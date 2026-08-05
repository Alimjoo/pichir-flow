fn sanitize_file_name(file_name: &str) -> String {
    let sanitized = file_name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    let mut name = if sanitized.is_empty() {
        "transcript".to_string()
    } else {
        sanitized
    };

    if !name.to_lowercase().ends_with(".srt") {
        name.push_str(".srt");
    }

    name
}

fn sanitize_media_file_name(file_name: &str) -> String {
    let sanitized = file_name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    if sanitized.is_empty() {
        "recording.m4a".to_string()
    } else {
        sanitized
    }
}

fn sanitize_folder_name(name: &str, fallback: &str) -> String {
    let sanitized = name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn project_folder(
    app: &AppHandle,
    project_id: &str,
    project_title: &str,
) -> Result<PathBuf, String> {
    let base_dir = projects_base_dir(app)?;
    let safe_id = sanitize_folder_name(project_id, "project");
    let safe_title = sanitize_folder_name(project_title, "project");

    Ok(base_dir.join(format!("{safe_title}-{safe_id}")))
}

fn projects_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data directory: {err}"))?
        .join("projects"))
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("failed to remove {}: {}", path.display(), err)),
    }
}

fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let parent = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(PathBuf::new);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("transcript");
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 2..10_000 {
        let file_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}-{index}.{extension}"),
            _ => format!("{stem}-{index}"),
        };
        let candidate = parent.join(file_name);

        if !candidate.exists() {
            return candidate;
        }
    }

    path
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractedMediaAudio {
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    duration_ms: u64,
    pcm_i16: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedMediaFile {
    path: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAudioFile {
    folder_path: String,
    audio_path: String,
    sample_rate: Option<u32>,
    channels: Option<u16>,
    bits_per_sample: Option<u16>,
    duration_ms: Option<u64>,
    data_bytes: Option<u64>,
}

struct WavPcmInfo {
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    duration_ms: u64,
    data_offset: u64,
    data_bytes: u64,
}

fn project_audio_file_from_path(folder: &Path, audio_path: &Path) -> Result<ProjectAudioFile, String> {
    let info = read_wav_pcm_info(audio_path)?;

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

fn is_wav_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("wav"))
        .unwrap_or(false)
}

fn copy_if_native_asr_wav(input_path: &Path, output_path: &Path) -> Result<Option<WavPcmInfo>, String> {
    if !is_wav_path(input_path) {
        return Ok(None);
    }

    let Ok(info) = read_wav_pcm_info(input_path) else {
        return Ok(None);
    };

    if info.sample_rate != EXTRACTED_AUDIO_SAMPLE_RATE {
        return Ok(None);
    }

    fs::copy(input_path, output_path).map_err(|err| {
        format!(
            "failed to copy {} to {}: {}",
            input_path.display(),
            output_path.display(),
            err
        )
    })?;

    read_wav_pcm_info(output_path).map(Some)
}

fn temp_extract_dir() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    std::env::temp_dir().join(format!("ugasr-extract-{}-{nanos}", std::process::id()))
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| "invalid WAV header".to_string())?;

    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "invalid WAV header".to_string())?;

    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_wav_pcm_info(path: &Path) -> Result<WavPcmInfo, String> {
    let mut file =
        File::open(path).map_err(|err| format!("failed to open {}: {}", path.display(), err))?;
    let mut header = [0u8; 12];

    file.read_exact(&mut header)
        .map_err(|err| format!("failed to read {}: {}", path.display(), err))?;

    if header.get(0..4) != Some(b"RIFF") || header.get(8..12) != Some(b"WAVE") {
        return Err("native extractor did not produce a WAV file".to_string());
    }

    let mut format_tag = None;
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits_per_sample = None;
    let mut data_offset = None;
    let mut data_bytes = None;

    loop {
        let mut chunk_header = [0u8; 8];

        match file.read_exact(&mut chunk_header) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(err) => return Err(format!("failed to read WAV chunk: {err}")),
        }

        let chunk_id = &chunk_header[0..4];
        let chunk_size = u32::from_le_bytes([
            chunk_header[4],
            chunk_header[5],
            chunk_header[6],
            chunk_header[7],
        ]) as u64;
        let chunk_start = file
            .stream_position()
            .map_err(|err| format!("failed to read WAV position: {err}"))?;

        if chunk_id == b"fmt " {
            if chunk_size < 16 {
                return Err("invalid WAV fmt chunk".to_string());
            }

            let mut fmt = vec![0u8; chunk_size as usize];
            file.read_exact(&mut fmt)
                .map_err(|err| format!("failed to read WAV fmt chunk: {err}"))?;

            format_tag = Some(u16::from_le_bytes([fmt[0], fmt[1]]));
            channels = Some(u16::from_le_bytes([fmt[2], fmt[3]]));
            sample_rate = Some(u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]));
            bits_per_sample = Some(u16::from_le_bytes([fmt[14], fmt[15]]));
        } else if chunk_id == b"data" {
            data_offset = Some(chunk_start);
            data_bytes = Some(chunk_size);
            file.seek(SeekFrom::Current(chunk_size as i64))
                .map_err(|err| format!("failed to skip WAV data chunk: {err}"))?;
        } else {
            file.seek(SeekFrom::Current(chunk_size as i64))
                .map_err(|err| format!("failed to skip WAV chunk: {err}"))?;
        }

        if chunk_size % 2 != 0 {
            file.seek(SeekFrom::Current(1))
                .map_err(|err| format!("failed to skip WAV padding: {err}"))?;
        }
    }

    let format_tag = format_tag.ok_or_else(|| "WAV fmt chunk missing".to_string())?;
    let channels = channels.ok_or_else(|| "WAV channel count missing".to_string())?;
    let sample_rate = sample_rate.ok_or_else(|| "WAV sample rate missing".to_string())?;
    let bits_per_sample = bits_per_sample.ok_or_else(|| "WAV bit depth missing".to_string())?;
    let data_offset = data_offset.ok_or_else(|| "WAV data chunk missing".to_string())?;
    let data_bytes = data_bytes.ok_or_else(|| "WAV data chunk missing".to_string())?;

    if !matches!(format_tag, 1 | 0xfffe) {
        return Err(format!("unsupported WAV format tag: {format_tag}"));
    }

    if channels != 1 || bits_per_sample != 16 || sample_rate == 0 {
        return Err(format!(
            "unsupported WAV format: {channels} channel(s), {sample_rate} Hz, {bits_per_sample} bits"
        ));
    }

    if data_bytes == 0 {
        return Err("native extractor produced empty audio".to_string());
    }

    if data_bytes % 2 != 0 {
        return Err("native extractor produced unaligned 16-bit audio".to_string());
    }

    let sample_count = data_bytes / 2;
    let duration_ms = (sample_count * 1000) / u64::from(sample_rate);

    Ok(WavPcmInfo {
        sample_rate,
        channels,
        bits_per_sample,
        duration_ms,
        data_offset,
        data_bytes,
    })
}

fn parse_wav_i16_mono(path: &Path) -> Result<ExtractedMediaAudio, String> {
    let bytes =
        fs::read(path).map_err(|err| format!("failed to read {}: {}", path.display(), err))?;

    if bytes.len() < 44 || bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err("native extractor did not produce a WAV file".to_string());
    }

    let mut offset = 12usize;
    let mut format_tag = None;
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits_per_sample = None;
    let mut data_range = None;

    while offset + 8 <= bytes.len() {
        let chunk_id = bytes
            .get(offset..offset + 4)
            .ok_or_else(|| "invalid WAV chunk".to_string())?;
        let chunk_size = read_u32_le(&bytes, offset + 4)? as usize;
        let chunk_start = offset + 8;
        let chunk_end = chunk_start
            .checked_add(chunk_size)
            .ok_or_else(|| "invalid WAV chunk size".to_string())?;

        if chunk_end > bytes.len() {
            return Err("truncated WAV chunk".to_string());
        }

        if chunk_id == b"fmt " {
            if chunk_size < 16 {
                return Err("invalid WAV fmt chunk".to_string());
            }

            format_tag = Some(read_u16_le(&bytes, chunk_start)?);
            channels = Some(read_u16_le(&bytes, chunk_start + 2)?);
            sample_rate = Some(read_u32_le(&bytes, chunk_start + 4)?);
            bits_per_sample = Some(read_u16_le(&bytes, chunk_start + 14)?);
        } else if chunk_id == b"data" {
            data_range = Some(chunk_start..chunk_end);
        }

        offset = chunk_end + (chunk_size % 2);
    }

    let format_tag = format_tag.ok_or_else(|| "WAV fmt chunk missing".to_string())?;
    let channels = channels.ok_or_else(|| "WAV channel count missing".to_string())?;
    let sample_rate = sample_rate.ok_or_else(|| "WAV sample rate missing".to_string())?;
    let bits_per_sample = bits_per_sample.ok_or_else(|| "WAV bit depth missing".to_string())?;
    let data_range = data_range.ok_or_else(|| "WAV data chunk missing".to_string())?;

    if !matches!(format_tag, 1 | 0xfffe) {
        return Err(format!("unsupported WAV format tag: {format_tag}"));
    }

    if channels != 1 || sample_rate != EXTRACTED_AUDIO_SAMPLE_RATE || bits_per_sample != 16 {
        return Err(format!(
            "unexpected WAV format: {channels} channel(s), {sample_rate} Hz, {bits_per_sample} bits"
        ));
    }

    let pcm_i16 = bytes[data_range].to_vec();

    if pcm_i16.is_empty() {
        return Err("native extractor produced empty audio".to_string());
    }

    if pcm_i16.len() % 2 != 0 {
        return Err("native extractor produced unaligned 16-bit audio".to_string());
    }

    let sample_count = (pcm_i16.len() / 2) as u64;
    let duration_ms = (sample_count * 1000) / u64::from(sample_rate);

    Ok(ExtractedMediaAudio {
        sample_rate,
        channels,
        bits_per_sample,
        duration_ms,
        pcm_i16,
    })
}

fn bundled_ffmpeg_path(server_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        server_dir.join(FFMPEG_BIN),
        PathBuf::from(DEV_SERVER_DIR).join(FFMPEG_BIN),
    ];

    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Some(path);
    }

    #[cfg(debug_assertions)]
    {
        let mut command = hidden_command(FFMPEG_BIN);
        if command
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Some(PathBuf::from(FFMPEG_BIN));
        }
    }

    None
}

fn require_bundled_ffmpeg_path(server_dir: &Path) -> Result<PathBuf, String> {
    bundled_ffmpeg_path(server_dir).ok_or_else(|| {
        format!(
            "FFmpeg sidecar is missing. Expected {} at {} or {}",
            FFMPEG_BIN,
            server_dir.join(FFMPEG_BIN).display(),
            PathBuf::from(DEV_SERVER_DIR).join(FFMPEG_BIN).display()
        )
    })
}

#[cfg(windows)]
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    Command::new(program)
}

fn run_ffmpeg_extract_wav(
    ffmpeg: &Path,
    input_path: &Path,
    output_path: &Path,
    sample_rate: u32,
) -> Result<(), String> {
    let mut command = hidden_command(ffmpeg);
    let output = command
        .args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(input_path)
        .args([
            "-vn",
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            &sample_rate.to_string(),
            "-acodec",
            "pcm_s16le",
            "-f",
            "wav",
        ])
        .arg(output_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("failed to run FFmpeg extractor: {err}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    Err(if stderr.is_empty() {
        "FFmpeg extractor failed".to_string()
    } else {
        format!("FFmpeg extractor failed: {stderr}")
    })
}

fn run_ffmpeg_extract(ffmpeg: &Path, input_path: &Path, output_path: &Path) -> Result<(), String> {
    run_ffmpeg_extract_wav(ffmpeg, input_path, output_path, EXTRACTED_AUDIO_SAMPLE_RATE)
}

fn extract_media_audio_path_with_server_dir(
    server_dir: PathBuf,
    path: PathBuf,
) -> Result<ExtractedMediaAudio, String> {
    if !path.is_file() {
        return Err(format!("media file does not exist: {}", path.display()));
    }

    let temp_dir = temp_extract_dir();
    let result = (|| {
        fs::create_dir_all(&temp_dir)
            .map_err(|err| format!("failed to create {}: {}", temp_dir.display(), err))?;

        let output_path = temp_dir.join("audio.wav");

        let ffmpeg = require_bundled_ffmpeg_path(&server_dir)?;
        run_ffmpeg_extract(&ffmpeg, &path, &output_path)?;

        parse_wav_i16_mono(&output_path)
    })();

    let _ = fs::remove_dir_all(&temp_dir);

    result
}

fn extract_media_audio_blocking(
    server_dir: PathBuf,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<ExtractedMediaAudio, String> {
    if bytes.is_empty() {
        return Err("media file is empty".to_string());
    }

    let temp_dir = temp_extract_dir();
    let result = (|| {
        fs::create_dir_all(&temp_dir)
            .map_err(|err| format!("failed to create {}: {}", temp_dir.display(), err))?;

        let input_path = temp_dir.join(sanitize_media_file_name(&file_name));

        fs::write(&input_path, bytes)
            .map_err(|err| format!("failed to write {}: {}", input_path.display(), err))?;

        extract_media_audio_path_with_server_dir(server_dir, input_path)
    })();

    let _ = fs::remove_dir_all(&temp_dir);

    result
}
