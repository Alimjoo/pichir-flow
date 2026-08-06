struct ServerProcess {
    child: Mutex<Option<RunningServer>>,
    next_server_index: Mutex<usize>,
}

struct RunningServer {
    child: Child,
    server_index: usize,
    model_mode: String,
    launch_id: String,
}

#[allow(dead_code)]
#[derive(Clone, Copy)]
enum AsrBackendPreference {
    Cpu,
    Cuda,
    Metal,
    Vulkan,
}

impl AsrBackendPreference {
    fn env_value(self) -> &'static str {
        match self {
            AsrBackendPreference::Cpu => "cpu",
            AsrBackendPreference::Cuda => "cuda",
            AsrBackendPreference::Metal => "metal",
            AsrBackendPreference::Vulkan => "vulkan",
        }
    }

    fn label(self) -> &'static str {
        match self {
            AsrBackendPreference::Cpu => "CPU",
            AsrBackendPreference::Cuda => "CUDA",
            AsrBackendPreference::Metal => "Metal",
            AsrBackendPreference::Vulkan => "Vulkan",
        }
    }

    fn is_accelerated(self) -> bool {
        !matches!(self, AsrBackendPreference::Cpu)
    }
}

#[derive(Clone, Copy)]
struct AsrServerCandidate {
    bin_name: &'static str,
    backend: AsrBackendPreference,
}

#[cfg(windows)]
const ASR_SERVER_CANDIDATES: &[AsrServerCandidate] = &[
    AsrServerCandidate {
        bin_name: "ASR-cuda.exe",
        backend: AsrBackendPreference::Cuda,
    },
    AsrServerCandidate {
        bin_name: "ASR-vulkan.exe",
        backend: AsrBackendPreference::Vulkan,
    },
    AsrServerCandidate {
        bin_name: "ASR.exe",
        backend: AsrBackendPreference::Vulkan,
    },
    AsrServerCandidate {
        bin_name: "ASR.exe",
        backend: AsrBackendPreference::Cpu,
    },
];

#[cfg(target_os = "macos")]
const ASR_SERVER_CANDIDATES: &[AsrServerCandidate] = &[
    AsrServerCandidate {
        bin_name: "ASR",
        backend: AsrBackendPreference::Metal,
    },
    AsrServerCandidate {
        bin_name: "ASR-vulkan",
        backend: AsrBackendPreference::Vulkan,
    },
    AsrServerCandidate {
        bin_name: "ASR",
        backend: AsrBackendPreference::Cpu,
    },
];

#[cfg(all(not(windows), target_os = "linux"))]
const ASR_SERVER_CANDIDATES: &[AsrServerCandidate] = &[
    AsrServerCandidate {
        bin_name: "ASR-vulkan",
        backend: AsrBackendPreference::Vulkan,
    },
    AsrServerCandidate {
        bin_name: "ASR",
        backend: AsrBackendPreference::Cpu,
    },
];

#[cfg(all(not(windows), not(any(target_os = "linux", target_os = "macos"))))]
const ASR_SERVER_CANDIDATES: &[AsrServerCandidate] = &[AsrServerCandidate {
    bin_name: "ASR",
    backend: AsrBackendPreference::Cpu,
}];

#[derive(Clone, Copy)]
enum LocalService {
    Asr,
}

impl LocalService {
    fn port(self) -> u16 {
        match self {
            LocalService::Asr => SERVER_PORT,
        }
    }

    fn label(self) -> &'static str {
        match self {
            LocalService::Asr => "ASR",
        }
    }

    fn health_path(self) -> &'static str {
        "/api/health"
    }

    fn shutdown_path(self) -> &'static str {
        "/api/shutdown"
    }
}

impl ServerProcess {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            next_server_index: Mutex::new(0),
        }
    }

    fn start(
        &self,
        server_dir: PathBuf,
        model_paths: ModelPaths,
        log_path: Option<PathBuf>,
        wait_for_ready: bool,
    ) -> Result<(), String> {
        let mut child_guard = self
            .child
            .lock()
            .map_err(|_| "model process lock failed".to_string())?;

        if let Some(running) = child_guard.as_mut() {
            if running
                .child
                .try_wait()
                .map_err(|err| err.to_string())?
                .is_none()
            {
                if running.model_mode == model_paths.mode {
                    if wait_for_ready {
                        wait_for_server_ready(
                            &mut running.child,
                            Duration::from_secs(SERVER_READY_WAIT_SECS),
                            Some(&running.launch_id),
                        )?;
                    }

                    return Ok(());
                }

                let _ = running.child.kill();
                let _ = running.child.wait();
                *child_guard = None;
            } else {
                let mut next_index_guard = self
                    .next_server_index
                    .lock()
                    .map_err(|_| "model process lock failed".to_string())?;

                *next_index_guard = running.server_index.saturating_add(1);
                *child_guard = None;
            }
        }

        let mut errors = Vec::new();
        let mut next_index_guard = self
            .next_server_index
            .lock()
            .map_err(|_| "model process lock failed".to_string())?;
        let start_index = *next_index_guard;

        for (index, candidate) in ASR_SERVER_CANDIDATES
            .iter()
            .copied()
            .enumerate()
            .skip(start_index)
        {
            let server_bin = server_dir.join(candidate.bin_name);
            cleanup_stale_local_service(LocalService::Asr)?;

            if !server_bin.exists() {
                errors.push(format!("{} does not exist", server_bin.display()));
                *next_index_guard = index.saturating_add(1);
                continue;
            }

            let launch_id = new_launch_id("asr");
            let mut child = match spawn_server(
                &server_bin,
                &server_dir,
                &model_paths,
                log_path.as_deref(),
                candidate,
                &launch_id,
            ) {
                Ok(child) => child,
                Err(err) => {
                    errors.push(err);
                    *next_index_guard = index.saturating_add(1);
                    continue;
                }
            };

            if wait_for_ready || candidate.backend.is_accelerated() {
                let wait_duration = if candidate.backend.is_accelerated() {
                    Duration::from_secs(ACCELERATED_SERVER_WAIT_SECS)
                } else {
                    Duration::from_secs(SERVER_READY_WAIT_SECS)
                };

                match wait_for_server_ready(&mut child, wait_duration, Some(&launch_id)) {
                    Ok(()) => {
                        *next_index_guard = index;
                        *child_guard = Some(RunningServer {
                            child,
                            server_index: index,
                            model_mode: model_paths.mode.clone(),
                            launch_id,
                        });
                        return Ok(());
                    }
                    Err(err) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        errors.push(format!("{} failed: {}", server_bin.display(), err));
                        *next_index_guard = index.saturating_add(1);
                        continue;
                    }
                }
            }

            *next_index_guard = index;
            *child_guard = Some(RunningServer {
                child,
                server_index: index,
                model_mode: model_paths.mode.clone(),
                launch_id,
            });
            return Ok(());
        }

        let mut error = format!("failed to start ASR model: {}", errors.join("; "));

        if let Some(path) = log_path {
            error.push_str(&format!(". Log: {}", path.display()));
        }

        *next_index_guard = 0;

        Err(error)
    }

    fn stop(&self) {
        let Ok(mut child_guard) = self.child.lock() else {
            return;
        };

        if let Some(mut running) = child_guard.take() {
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }
}

fn spawn_server(
    server_bin: &Path,
    server_dir: &Path,
    model_paths: &ModelPaths,
    log_path: Option<&Path>,
    candidate: AsrServerCandidate,
    launch_id: &str,
) -> Result<Child, String> {
    let mut command = Command::new(server_bin);

    command.current_dir(server_dir).stdin(Stdio::null());
    command.env("PICHIRFLOW_SERVER_LAUNCH_ID", launch_id);
    command.env("PICHIRFLOW_HELPER_MODEL_PATH", &model_paths.helper);
    command.env("PICHIRFLOW_WHISPER_MODEL_PATH", &model_paths.whisper);
    command.env("PICHIRFLOW_UYGHUR_MODEL_PATH", &model_paths.whisper);
    command.env("PICHIRFLOW_ASR_MODEL_FAMILY", &model_paths.family);

    if let Some(path) = log_path {
        let debug_log_path = path.with_file_name("ASR-debug.log");
        command.env("PICHIRFLOW_LOG_FILE", debug_log_path);
    }

    if let Some((stdout, stderr)) = open_server_logs(log_path, server_bin) {
        command.stdout(stdout).stderr(stderr);
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }

    #[cfg(windows)]
    match candidate.backend {
        AsrBackendPreference::Cpu => {
            command.env("PICHIRFLOW_REQUIRED_BACKEND", "cpu");
            command.env("PICHIRFLOW_DISABLE_GPU", "1");
            command.env("PICHIRFLOW_CPU_THREADS", "4");
            command.env("PICHIRFLOW_BACKEND_LABEL", "CPU");
        }
        AsrBackendPreference::Cuda | AsrBackendPreference::Metal | AsrBackendPreference::Vulkan => {
            command.env("PICHIRFLOW_REQUIRED_BACKEND", candidate.backend.env_value());
            command.env("PICHIRFLOW_REQUIRE_GPU", "1");
            command.env("PICHIRFLOW_BACKEND_LABEL", candidate.backend.label());
        }
    }

    #[cfg(windows)]
    if let Some(server_dir_text) = server_dir.to_str() {
        let mut path_value = server_dir_text.to_string();

        if let Some(existing) = std::env::var_os("PATH") {
            path_value.push(';');
            path_value.push_str(&existing.to_string_lossy());
        }

        command.env("PATH", path_value);
    }

    #[cfg(not(windows))]
    match candidate.backend {
        AsrBackendPreference::Cpu => {
            command.env("PICHIRFLOW_REQUIRED_BACKEND", "cpu");
            command.env("PICHIRFLOW_DISABLE_GPU", "1");
            command.env("PICHIRFLOW_CPU_THREADS", "4");
            command.env("PICHIRFLOW_BACKEND_LABEL", "CPU");
        }
        AsrBackendPreference::Cuda | AsrBackendPreference::Metal | AsrBackendPreference::Vulkan => {
            command.env("PICHIRFLOW_REQUIRED_BACKEND", candidate.backend.env_value());
            command.env("PICHIRFLOW_REQUIRE_GPU", "1");
            command.env("PICHIRFLOW_BACKEND_LABEL", candidate.backend.label());
        }
    }

    #[cfg(target_os = "macos")]
    if matches!(candidate.backend, AsrBackendPreference::Vulkan) {
        let icd_path = server_dir.join("MoltenVK_icd.json");

        if icd_path.exists() {
            command.env("VK_ICD_FILENAMES", icd_path);
        }

        if let Some(server_dir_text) = server_dir.to_str() {
            let mut library_path = server_dir_text.to_string();

            if let Some(existing) = std::env::var_os("DYLD_LIBRARY_PATH") {
                library_path.push(':');
                library_path.push_str(&existing.to_string_lossy());
            }

            command.env("DYLD_LIBRARY_PATH", library_path);
        }
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    if candidate.backend.is_accelerated() {
        command.env("PICHIRFLOW_REQUIRED_BACKEND", candidate.backend.env_value());
        command.env("PICHIRFLOW_REQUIRE_GPU", "1");
        command.env("PICHIRFLOW_BACKEND_LABEL", candidate.backend.label());
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn().map_err(|err| {
        format!(
            "failed to start ASR model at {}: {}",
            server_bin.display(),
            err
        )
    })
}

fn open_server_logs(log_path: Option<&Path>, server_bin: &Path) -> Option<(Stdio, Stdio)> {
    let path = log_path?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok()?;
    }

    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;

    let _ = writeln!(
        log,
        "\n--- starting {} from {} ---",
        server_bin.display(),
        server_bin
            .parent()
            .map(Path::display)
            .map(|value| value.to_string())
            .unwrap_or_default()
    );

    let stderr = log.try_clone().ok()?;

    Some((Stdio::from(log), Stdio::from(stderr)))
}

fn wait_for_server_ready(
    child: &mut Child,
    wait_duration: Duration,
    expected_launch_id: Option<&str>,
) -> Result<(), String> {
    wait_for_port_ready(child, LocalService::Asr, wait_duration, expected_launch_id)
}

fn wait_for_port_ready(
    child: &mut Child,
    service: LocalService,
    wait_duration: Duration,
    expected_launch_id: Option<&str>,
) -> Result<(), String> {
    let deadline = Instant::now() + wait_duration;
    let port = service.port();

    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|err| err.to_string())? {
            return Err(format!(
                "model process exited before becoming ready: {status}"
            ));
        }

        if let Ok(response) =
            localhost_http_request(port, "GET", service.health_path(), Duration::from_millis(500))
        {
            let body = http_response_body(&response);
            if health_body_matches(body, service, expected_launch_id) {
                return Ok(());
            }
        }

        thread::sleep(Duration::from_millis(250));
    }

    Err(format!(
        "{} model did not become ready within {} seconds",
        service.label(),
        wait_duration.as_secs()
    ))
}

fn new_launch_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    format!("{prefix}-{}-{nanos}", std::process::id())
}

fn localhost_connectable(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

fn localhost_http_request(
    port: u16,
    method: &str,
    path: &str,
    timeout: Duration,
) -> Result<String, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|err| err.to_string())?;

    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;

    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| err.to_string())?;

    let mut response_bytes = Vec::new();
    let mut buffer = [0_u8; 4096];

    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => response_bytes.extend_from_slice(&buffer[..n]),
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) && !response_bytes.is_empty() =>
            {
                break;
            }
            Err(err) => return Err(err.to_string()),
        }
    }

    let response = String::from_utf8_lossy(&response_bytes).into_owned();

    Ok(response)
}

fn http_response_status(response: &str) -> Option<u16> {
    let status_line = response.lines().next()?;
    let mut parts = status_line.split_whitespace();
    let _http_version = parts.next()?;
    parts.next()?.parse().ok()
}

fn http_response_body(response: &str) -> &str {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or("")
}

fn health_body_matches(body: &str, service: LocalService, expected_launch_id: Option<&str>) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return false;
    };

    if value.get("ok").and_then(|item| item.as_bool()) != Some(true)
        || value.get("app").and_then(|item| item.as_str()) != Some("PichirFlow")
        || value.get("service").and_then(|item| item.as_str()) != Some(service.label())
    {
        return false;
    }

    if let Some(expected_launch_id) = expected_launch_id {
        return value
            .get("launchId")
            .and_then(|item| item.as_str())
            == Some(expected_launch_id);
    }

    true
}

fn cleanup_stale_local_service(service: LocalService) -> Result<(), String> {
    let port = service.port();

    if !localhost_connectable(port, Duration::from_millis(250)) {
        return Ok(());
    }

    let response = localhost_http_request(
        port,
        "GET",
        service.health_path(),
        Duration::from_millis(750),
    )
    .map_err(|err| {
        format!(
            "port {port} is already in use and did not answer PichirFlow {} health check: {err}",
            service.label()
        )
    })?;

    let status = http_response_status(&response).unwrap_or(0);
    let body = http_response_body(&response);

    if status != 200 || !health_body_matches(body, service, None) {
        return Err(format!(
            "port {port} is already in use by a non-PichirFlow {} service",
            service.label()
        ));
    }

    let _ = localhost_http_request(
        port,
        "POST",
        service.shutdown_path(),
        Duration::from_millis(750),
    );

    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        if !localhost_connectable(port, Duration::from_millis(250)) {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(250));
    }

    Err(format!(
        "stale PichirFlow {} service on port {port} did not shut down",
        service.label()
    ))
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn resolve_server_dir(app: &AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let dev_server_dir = PathBuf::from(DEV_SERVER_DIR);

        if dev_server_dir.exists() {
            return dev_server_dir;
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let server_dir = resource_dir.join(SERVER_RESOURCE_DIR);

        if server_dir.exists() {
            return server_dir;
        }
    }

    PathBuf::from(DEV_SERVER_DIR)
}

#[derive(Clone)]
struct ModelPaths {
    helper: PathBuf,
    whisper: PathBuf,
    mode: String,
    family: String,
}

fn usable_model_file(path: &Path, min_size: u64) -> bool {
    match fs::metadata(path) {
        Ok(metadata) => metadata.is_file() && metadata.len() >= min_size,
        Err(_) => false,
    }
}

const HELPER_MODEL_MIN_BYTES: u64 = 100_000;
const ASR_MODEL_MIN_BYTES: u64 = 30_000_000;

fn model_file_name_for_mode(mode: &str) -> &'static str {
    match mode {
        "fast" | "normal" | "slow" => "whisper-small-uyghur-q5_0.bin",
        _ => "whisper-small-uyghur-q5_0.bin",
    }
}

fn model_dir(app: &AppHandle, server_dir: &Path) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| server_dir.to_path_buf())
        .join("models")
}

fn model_label_for_mode(mode: &str) -> &'static str {
    match mode {
        "fast" | "normal" | "slow" => "fast Uyghur ASR model",
        _ => "Uyghur ASR model",
    }
}

fn resolve_required_model_file(
    label: &str,
    candidates: &[PathBuf],
    min_size: u64,
) -> Result<PathBuf, String> {
    if let Some(path) = candidates
        .iter()
        .find(|path| usable_model_file(path, min_size))
    {
        return Ok(path.clone());
    }

    let expected = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(" or ");

    Err(format!("{label} is missing. Expected {expected}"))
}

fn normalize_asr_language(asr_language: Option<String>) -> String {
    let language = asr_language
        .unwrap_or_else(|| "Uyghur".to_string())
        .trim()
        .to_string();

    if language.is_empty() {
        "Uyghur".to_string()
    } else {
        language
    }
}

fn resolve_model_paths(
    app: &AppHandle,
    server_dir: &Path,
    _model_mode: Option<String>,
    asr_language: Option<String>,
) -> Result<ModelPaths, String> {
    let asr_language = normalize_asr_language(asr_language);
    let bundled_helper = server_dir.join("silero-v6.2.1-ggml.bin");
    let app_model_dir = model_dir(app, server_dir);
    let helper = resolve_required_model_file(
        "ASR helper model",
        &[
            bundled_helper,
            app_model_dir.join("silero-v6.2.1-ggml.bin"),
        ],
        HELPER_MODEL_MIN_BYTES,
    )?;

    if asr_language != "Uyghur" {
        let whisper = resolve_required_model_file(
            "non-Uyghur ASR model",
            &[
                server_dir.join("whisper-small-q5_0.bin"),
                app_model_dir.join("whisper-small-q5_0.bin"),
            ],
            ASR_MODEL_MIN_BYTES,
        )?;

        return Ok(ModelPaths {
            helper,
            whisper,
            mode: "non-uyghur".to_string(),
            family: "non-uyghur".to_string(),
        });
    }

    let mode = "fast".to_string();
    let selected_model_file = model_file_name_for_mode(&mode);
    let whisper = resolve_required_model_file(
        model_label_for_mode(&mode),
        &[
            server_dir.join(selected_model_file),
            app_model_dir.join(selected_model_file),
        ],
        ASR_MODEL_MIN_BYTES,
    )?;

    Ok(ModelPaths {
        helper,
        whisper,
        mode,
        family: "uyghur".to_string(),
    })
}

fn resolve_server_log_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_log_dir()
        .ok()
        .map(|dir| dir.join(SERVER_LOG_FILE))
}
