use sha2::{Digest, Sha256};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecureImageResponse {
    mime_type: &'static str,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
struct SecureTextResponse {
    key: &'static str,
    value: &'static str,
}

struct SecureTextEntry {
    key: &'static str,
    value: &'static str,
}

struct SecureImageAsset {
    key: &'static str,
    mime_type: &'static str,
    sha256: &'static str,
    bytes: &'static [u8],
}

struct FrontendIntegrityFile {
    path: &'static str,
    sha256: &'static str,
    bytes: &'static [u8],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseAgreementState {
    accepted: bool,
    sha256: String,
    text: String,
}

include!("generated_frontend_integrity.rs");

const SECURE_TEXT_HASH: &str = "6dc4991b6abaee757b0f047ddd87975c204355bea03bea49ed6524b9848fa698";
const EMBEDDED_LICENSE_TEXT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../LICENSE"));

const SECURE_TEXTS: &[SecureTextEntry] = &[
    SecureTextEntry {
        key: "aboutButton",
        value: "ھەققىدە",
    },
    SecureTextEntry {
        key: "aboutTitle",
        value: "ھەققىدە",
    },
    SecureTextEntry {
        key: "authorLabel",
        value: "ئاپتور",
    },
    SecureTextEntry {
        key: "authorName",
        value: "Piyazon",
    },
    SecureTextEntry {
        key: "douyinLabel",
        value: "دوۋيىن",
    },
    SecureTextEntry {
        key: "salonLabel",
        value: "سالون",
    },
    SecureTextEntry {
        key: "aboutWarning",
        value: "ئاگاھلاندۇرۇش: بۇ ئەپ ھەقسىز. ئەگەر بۇ ئەپ ئۈچۈن پۇل تۆلىگەن ياكى باشقىلاردىن سېتىۋالغان بولسىڭىز، دوۋيىن ياكى سالون ئارقىلىق مەن بىلەن ئالاقىلىشىڭ، پۇلىڭىزنى قايتۇرۇۋېلىشىڭىزغا ياردەم قىلىمىز.",
    },
    SecureTextEntry {
        key: "footerText",
        value: "ئاگاھلاندۇرۇش، بۇ ئەپ ھەسىز، قايتا سېتىشقا بولمايدۇ",
    },
    SecureTextEntry {
        key: "integrityTitle",
        value: "ئەپ بىخەتەرلىك تەكشۈرۈشىدىن ئۆتمىدى",
    },
    SecureTextEntry {
        key: "integrityMessage",
        value: "بۇ نەشرنىڭ ھۆججەتلىرى ئۆزگەرتىلگەن بولۇشى مۇمكىن. رەسمىي Piyazon نەشرىنى قايتا قاچىلاڭ.",
    },
];

const SECURE_IMAGE_ASSETS: &[SecureImageAsset] = &[
    SecureImageAsset {
        key: "penguin",
        mime_type: "image/svg+xml",
        sha256: "3513f8a5b6a70aac4909d0546a2726856538bda0f093ae025035816a6c35fe28",
        bytes: include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/assets/penguin.svg"
        )),
    },
    SecureImageAsset {
        key: "douyin",
        mime_type: "image/jpeg",
        sha256: "a8f2a0ac2582ecbc3b7494576cc1bb6cc2fadd6eb54f07f06f3d6382212301e2",
        bytes: include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/assets/douyin.jpg"
        )),
    },
    SecureImageAsset {
        key: "salon",
        mime_type: "image/jpeg",
        sha256: "e689baf4d44780e6f69fd14c4e648d7cc41adcc1a91959316761015700f70192",
        bytes: include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/assets/salon.jpg"
        )),
    },
    SecureImageAsset {
        key: "javascript",
        mime_type: "image/svg+xml",
        sha256: "8dac53799104214c30769aa44c25a16b3c8c86f7c6c6e46fb1996e63ab5d828e",
        bytes: include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/assets/javascript.svg"
        )),
    },
    SecureImageAsset {
        key: "tauri",
        mime_type: "image/svg+xml",
        sha256: "e5d2738bbaa5543c4684001a558dc53165da9b636144827b28db1dcfacf81aa8",
        bytes: include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/assets/tauri.svg"
        )),
    },
];

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256_hex_with_lf_line_endings(bytes: &[u8]) -> String {
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'\r' {
            normalized.push(b'\n');
            index += 1;

            if bytes.get(index) == Some(&b'\n') {
                index += 1;
            }
        } else {
            normalized.push(bytes[index]);
            index += 1;
        }
    }

    sha256_hex(&normalized)
}

fn secure_image_sha256(asset: &SecureImageAsset) -> String {
    if asset.mime_type == "image/svg+xml" {
        sha256_hex_with_lf_line_endings(asset.bytes)
    } else {
        sha256_hex(asset.bytes)
    }
}

fn secure_texts_hash() -> String {
    let mut hasher = Sha256::new();

    for entry in SECURE_TEXTS {
        hasher.update(entry.key.as_bytes());
        hasher.update([0]);
        hasher.update(entry.value.as_bytes());
        hasher.update([255]);
    }

    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn bundled_license_text(app: &AppHandle) -> String {
    let text = app
        .path()
        .resource_dir()
        .ok()
        .map(|resource_dir| resource_dir.join("LICENSE"))
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_else(|| EMBEDDED_LICENSE_TEXT.to_string());

    text.replace("ugASR", "PiVoiceLab")
}

fn license_hash(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

fn license_acceptance_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data directory: {err}"))?
        .join("pivoicelab-license-acceptance.json"))
}

#[tauri::command]
fn license_agreement_state(app: AppHandle) -> Result<LicenseAgreementState, String> {
    let license_text = bundled_license_text(&app);
    let expected_sha = license_hash(&license_text);
    let accepted = match fs::read_to_string(license_acceptance_path(&app)?) {
        Ok(contents) => serde_json::from_str::<serde_json::Value>(&contents)
            .ok()
            .and_then(|value| {
                value
                    .get("sha256")
                    .and_then(|sha| sha.as_str())
                    .map(|sha| sha == expected_sha)
            })
            .unwrap_or(false),
        Err(err) if err.kind() == io::ErrorKind::NotFound => false,
        Err(err) => {
            return Err(format!("failed to read license acceptance: {err}"));
        }
    };

    Ok(LicenseAgreementState {
        accepted,
        sha256: expected_sha,
        text: license_text,
    })
}

#[tauri::command]
fn accept_license_agreement(app: AppHandle, sha256: String) -> Result<(), String> {
    let license_text = bundled_license_text(&app);
    let expected_sha = license_hash(&license_text);

    if sha256 != expected_sha {
        return Err("license SHA-256 mismatch".to_string());
    }

    let path = license_acceptance_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create app data directory: {err}"))?;
    }

    let payload = serde_json::json!({
        "sha256": expected_sha,
        "acceptedAt": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
    });

    fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|err| err.to_string())?)
        .map_err(|err| format!("failed to save license acceptance: {err}"))
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn secure_texts() -> Result<Vec<SecureTextResponse>, String> {
    let actual_sha = secure_texts_hash();

    if actual_sha != SECURE_TEXT_HASH {
        return Err("secure text SHA-256 mismatch".to_string());
    }

    Ok(SECURE_TEXTS
        .iter()
        .map(|entry| SecureTextResponse {
            key: entry.key,
            value: entry.value,
        })
        .collect())
}

fn frontend_integrity_candidate_paths(app: &AppHandle, relative_path: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join(relative_path));
        paths.push(resource_dir.join("dist").join(relative_path));
        paths.push(resource_dir.join("frontend").join(relative_path));
        paths.push(resource_dir.join("assets").join(relative_path));
    }

    paths
}

#[tauri::command]
fn verify_frontend_integrity(app: AppHandle) -> Result<(), String> {
    for file in FRONTEND_INTEGRITY_FILES {
        let embedded_sha = sha256_hex(file.bytes);
        if embedded_sha != file.sha256 {
            return Err(format!(
                "compiled frontend integrity hash mismatch: {}",
                file.path
            ));
        }

        for path in frontend_integrity_candidate_paths(&app, file.path) {
            if !path.is_file() {
                continue;
            }

            let bytes = fs::read(&path)
                .map_err(|err| format!("failed to read {}: {}", path.display(), err))?;
            let actual_sha = sha256_hex(&bytes);

            if actual_sha != file.sha256 {
                return Err(format!("frontend file was modified: {}", file.path));
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn secure_image(key: String) -> Result<SecureImageResponse, String> {
    let key = key.trim();
    let asset = SECURE_IMAGE_ASSETS
        .iter()
        .find(|asset| asset.key == key)
        .ok_or_else(|| "unknown secure image".to_string())?;
    let actual_sha = secure_image_sha256(asset);

    if actual_sha != asset.sha256 {
        return Err(format!("secure image SHA-256 mismatch: {key}"));
    }

    Ok(SecureImageResponse {
        mime_type: asset.mime_type,
        bytes: asset.bytes.to_vec(),
    })
}

#[tauri::command]
fn ensure_asr_server(
    app: AppHandle,
    server: tauri::State<'_, ServerProcess>,
    model_mode: Option<String>,
    asr_language: Option<String>,
    force_restart: Option<bool>,
) -> Result<String, String> {
    let server_dir = resolve_server_dir(&app);
    let model_paths = resolve_model_paths(&app, &server_dir, model_mode, asr_language)?;
    let resolved_mode = model_paths.mode.clone();

    if force_restart.unwrap_or(false) {
        server.stop();
    }

    server.start(server_dir, model_paths, resolve_server_log_path(&app), true)?;

    Ok(resolved_mode)
}

#[tauri::command]
async fn export_srt(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
) -> Result<Option<String>, String> {
    let file_name = sanitize_file_name(&file_name);
    let (sender, receiver) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .set_title("Choose SRT export folder")
        .pick_folder(move |folder_path| {
            let _ = sender.send(folder_path);
        });

    let folder_path = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;

    let Some(folder_path) = folder_path else {
        return Ok(None);
    };

    let folder = folder_path.into_path().map_err(|err| err.to_string())?;

    if !folder.is_dir() {
        return Err(format!(
            "selected path is not a folder: {}",
            folder.display()
        ));
    }

    let path = unique_path(folder.join(file_name));

    fs::write(&path, content)
        .map_err(|err: io::Error| format!("failed to write {}: {}", path.display(), err))?;

    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn export_media(
    app: tauri::AppHandle,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    if bytes.is_empty() {
        return Err("media file is empty".to_string());
    }

    let file_name = sanitize_media_file_name(&file_name);
    let (sender, receiver) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .set_title("Choose audio export path")
        .set_file_name(file_name)
        .save_file(move |file_path| {
            let _ = sender.send(file_path);
        });

    let file_path = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;

    let Some(file_path) = file_path else {
        return Ok(None);
    };

    let path = file_path.into_path().map_err(|err| err.to_string())?;

    fs::write(&path, bytes)
        .map_err(|err: io::Error| format!("failed to write {}: {}", path.display(), err))?;

    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn save_project_audio_wav(
    app: tauri::AppHandle,
    project_id: String,
    project_title: String,
    bytes: Vec<u8>,
) -> Result<ProjectAudioFile, String> {
    if bytes.is_empty() {
        return Err("audio file is empty".to_string());
    }

    let folder = project_folder(&app, &project_id, &project_title)?;
    let audio_path = folder.join("audio.wav");

    tauri::async_runtime::spawn_blocking({
        let folder = folder.clone();
        let audio_path = audio_path.clone();
        move || {
            fs::create_dir_all(&folder)
                .map_err(|err| format!("failed to create {}: {}", folder.display(), err))?;
            fs::write(&audio_path, bytes)
                .map_err(|err| format!("failed to write {}: {}", audio_path.display(), err))
        }
    })
    .await
    .map_err(|err| err.to_string())??;

    project_audio_file_from_path(&folder, &audio_path)
}

#[tauri::command]
async fn save_project_data_files(
    app: tauri::AppHandle,
    project_id: String,
    project_title: String,
    transcript: String,
    segments_json: String,
    project_json: String,
) -> Result<String, String> {
    let folder = project_folder(&app, &project_id, &project_title)?;

    tauri::async_runtime::spawn_blocking({
        let folder = folder.clone();
        move || {
            fs::create_dir_all(&folder)
                .map_err(|err| format!("failed to create {}: {}", folder.display(), err))?;
            fs::write(folder.join("transcript.txt"), &transcript)
                .map_err(|err| format!("failed to write transcript.txt: {err}"))?;
            fs::write(folder.join("timestamps.json"), segments_json)
                .map_err(|err| format!("failed to write timestamps.json: {err}"))?;
            fs::write(folder.join("project.json"), project_json)
                .map_err(|err| format!("failed to write project.json: {err}"))?;

            Ok::<(), String>(())
        }
    })
    .await
    .map_err(|err| err.to_string())??;

    Ok(folder.display().to_string())
}

#[tauri::command]
async fn save_project_srt(
    app: tauri::AppHandle,
    project_id: String,
    project_title: String,
    content: String,
) -> Result<String, String> {
    if content.trim().is_empty() {
        return Err("SRT content is empty".to_string());
    }

    let folder = project_folder(&app, &project_id, &project_title)?;
    let srt_path = folder.join("audio.srt");

    tauri::async_runtime::spawn_blocking({
        let folder = folder.clone();
        let srt_path = srt_path.clone();
        move || {
            fs::create_dir_all(&folder)
                .map_err(|err| format!("failed to create {}: {}", folder.display(), err))?;
            fs::write(&srt_path, content)
                .map_err(|err| format!("failed to write {}: {}", srt_path.display(), err))
        }
    })
    .await
    .map_err(|err| err.to_string())??;

    Ok(srt_path.display().to_string())
}

#[tauri::command]
async fn prepare_project_audio_from_path(
    app: tauri::AppHandle,
    project_id: String,
    project_title: String,
    path: String,
) -> Result<ProjectAudioFile, String> {
    let server_dir = resolve_server_dir(&app);
    let folder = project_folder(&app, &project_id, &project_title)?;
    let audio_path = folder.join("audio.wav");
    let input_path = PathBuf::from(path);

    if !input_path.is_file() {
        return Err(format!(
            "media file does not exist: {}",
            input_path.display()
        ));
    }

    let info = tauri::async_runtime::spawn_blocking({
        let folder = folder.clone();
        let audio_path = audio_path.clone();
        move || {
            fs::create_dir_all(&folder)
                .map_err(|err| format!("failed to create {}: {}", folder.display(), err))?;

            if let Some(info) = copy_if_native_asr_wav(&input_path, &audio_path)? {
                return Ok(info);
            }

            let ffmpeg = require_bundled_ffmpeg_path(&server_dir)?;
            run_ffmpeg_extract(&ffmpeg, &input_path, &audio_path)?;
            read_wav_pcm_info(&audio_path)
        }
    })
    .await
    .map_err(|err| err.to_string())??;

    Ok(ProjectAudioFile {
        folder_path: folder.display().to_string(),
        audio_path: audio_path.display().to_string(),
        sample_rate: Some(info.sample_rate),
        channels: Some(info.channels),
        bits_per_sample: Some(info.bits_per_sample),
        duration_ms: Some(info.duration_ms),
        data_bytes: Some(info.data_bytes),
    })
}

#[tauri::command]
async fn read_project_audio_pcm_chunk(
    path: String,
    offset: u64,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let info = read_wav_pcm_info(&path)?;

        if offset >= info.data_bytes {
            return Ok(Vec::new());
        }

        let max_bytes = cmp::min(max_bytes, 512 * 1024);
        let remaining = info.data_bytes - offset;
        let byte_count = cmp::min(max_bytes, remaining) as usize;
        let mut bytes = vec![0u8; byte_count - (byte_count % 2)];
        let mut file = File::open(&path)
            .map_err(|err| format!("failed to open {}: {}", path.display(), err))?;

        file.seek(SeekFrom::Start(info.data_offset + offset))
            .map_err(|err| format!("failed to seek {}: {}", path.display(), err))?;
        file.read_exact(&mut bytes)
            .map_err(|err| format!("failed to read {}: {}", path.display(), err))?;

        Ok(bytes)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn read_project_audio_info(path: String) -> Result<ProjectAudioFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let audio_path = PathBuf::from(path);

        if !audio_path.is_file() {
            return Err(format!("audio file does not exist: {}", audio_path.display()));
        }

        let folder = audio_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(PathBuf::new);

        project_audio_file_from_path(&folder, &audio_path)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn delete_project_data_files(
    app: tauri::AppHandle,
    project_id: String,
    project_title: String,
    project_folder_path: Option<String>,
) -> Result<(), String> {
    let base_dir = projects_base_dir(&app)?;
    let expected_folder = project_folder(&app, &project_id, &project_title)?;
    let safe_id_suffix = format!("-{}", sanitize_folder_name(&project_id, "project"));

    tauri::async_runtime::spawn_blocking(move || {
        let mut folders = vec![expected_folder];

        if let Some(project_folder_path) = project_folder_path {
            if !project_folder_path.trim().is_empty() {
                folders.push(PathBuf::from(project_folder_path));
            }
        }

        if base_dir.is_dir() {
            let entries = fs::read_dir(&base_dir)
                .map_err(|err| format!("failed to read {}: {}", base_dir.display(), err))?;

            for entry in entries {
                let entry = entry.map_err(|err| err.to_string())?;
                let path = entry.path();
                let name_matches = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.ends_with(&safe_id_suffix))
                    .unwrap_or(false);

                if path.is_dir() && name_matches {
                    folders.push(path);
                }
            }
        }

        folders.sort();
        folders.dedup();

        let base_dir = match fs::canonicalize(&base_dir) {
            Ok(path) => path,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(format!("failed to resolve {}: {}", base_dir.display(), err)),
        };

        for folder in folders {
            if let Ok(folder) = fs::canonicalize(&folder) {
                if folder.starts_with(&base_dir) {
                    remove_dir_if_exists(&folder)?;
                }
            }
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn clear_project_data_files(app: tauri::AppHandle) -> Result<(), String> {
    let base_dir = projects_base_dir(&app)?;

    tauri::async_runtime::spawn_blocking(move || remove_dir_if_exists(&base_dir))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
fn open_project_location(
    app: tauri::AppHandle,
    project_id: String,
    project_title: String,
) -> Result<String, String> {
    let folder = project_folder(&app, &project_id, &project_title)?;

    fs::create_dir_all(&folder)
        .map_err(|err| format!("failed to create {}: {}", folder.display(), err))?;

    app.opener()
        .open_path(folder.display().to_string(), None::<String>)
        .map_err(|err| err.to_string())?;

    Ok(folder.display().to_string())
}

#[tauri::command]
async fn pick_media_file(app: tauri::AppHandle) -> Result<Option<PickedMediaFile>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .set_title("Choose audio or video file")
        .add_filter(
            "Media",
            &[
                "aac", "aif", "aiff", "avi", "flac", "m4a", "m4v", "mkv", "mov", "mp3", "mp4",
                "mpeg", "mpg", "oga", "ogg", "opus", "wav", "webm",
            ],
        )
        .pick_file(move |file_path| {
            let _ = sender.send(file_path);
        });

    let file_path = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;

    let Some(file_path) = file_path else {
        return Ok(None);
    };

    let path = file_path.into_path().map_err(|err| err.to_string())?;

    if !path.is_file() {
        return Err(format!("selected path is not a file: {}", path.display()));
    }

    app.state::<tauri::scope::Scopes>()
        .allow_file(&path)
        .map_err(|err| err.to_string())?;

    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("media")
        .to_string();

    Ok(Some(PickedMediaFile {
        path: path.display().to_string(),
        name,
    }))
}

#[tauri::command]
async fn pick_media_files(app: tauri::AppHandle) -> Result<Vec<PickedMediaFile>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .set_title("Choose audio or video files")
        .add_filter(
            "Media",
            &[
                "aac", "aif", "aiff", "avi", "flac", "m4a", "m4v", "mkv", "mov", "mp3", "mp4",
                "mpeg", "mpg", "oga", "ogg", "opus", "wav", "webm",
            ],
        )
        .pick_files(move |file_paths| {
            let _ = sender.send(file_paths);
        });

    let file_paths = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;

    let Some(file_paths) = file_paths else {
        return Ok(Vec::new());
    };

    let mut picked = Vec::new();

    for file_path in file_paths {
        let path = file_path.into_path().map_err(|err| err.to_string())?;

        if !path.is_file() {
            continue;
        }

        app.state::<tauri::scope::Scopes>()
            .allow_file(&path)
            .map_err(|err| err.to_string())?;

        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("media")
            .to_string();

        picked.push(PickedMediaFile {
            path: path.display().to_string(),
            name,
        });
    }

    Ok(picked)
}

#[tauri::command]
async fn extract_media_audio(
    app: tauri::AppHandle,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<ExtractedMediaAudio, String> {
    let server_dir = resolve_server_dir(&app);

    tauri::async_runtime::spawn_blocking(move || {
        extract_media_audio_blocking(server_dir, file_name, bytes)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn extract_media_audio_from_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<ExtractedMediaAudio, String> {
    let server_dir = resolve_server_dir(&app);

    tauri::async_runtime::spawn_blocking(move || {
        extract_media_audio_path_with_server_dir(server_dir, PathBuf::from(path))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn read_media_file(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);

        if !path.is_file() {
            return Err(format!("media file does not exist: {}", path.display()));
        }

        fs::read(&path).map_err(|err| format!("failed to read {}: {}", path.display(), err))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn ffmpeg_sidecar_path(app: tauri::AppHandle) -> Result<String, String> {
    let server_dir = resolve_server_dir(&app);
    let ffmpeg = require_bundled_ffmpeg_path(&server_dir)?;

    Ok(ffmpeg.display().to_string())
}

#[tauri::command]
fn allow_media_file_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);

    if !path.is_file() {
        return Err(format!("media file does not exist: {}", path.display()));
    }

    app.state::<tauri::scope::Scopes>()
        .allow_file(&path)
        .map_err(|err| err.to_string())
}
