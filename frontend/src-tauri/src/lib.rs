use std::{
    cmp,
    fs::File,
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const SERVER_RESOURCE_DIR: &str = "server";
const DEV_SERVER_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/server");
const SERVER_LOG_FILE: &str = "ASR-server.log";
const SERVER_PORT: u16 = 47831;
const SERVER_READY_WAIT_SECS: u64 = 180;
const ACCELERATED_SERVER_WAIT_SECS: u64 = 180;
const EXTRACTED_AUDIO_SAMPLE_RATE: u32 = 16_000;
#[cfg(windows)]
const FFMPEG_BIN: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG_BIN: &str = "ffmpeg";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
include!("processes.rs");
include!("media.rs");
include!("commands.rs");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(ServerProcess::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ensure_asr_server,
            export_srt,
            export_media,
            save_project_audio_wav,
            save_project_data_files,
            save_project_srt,
            prepare_project_audio_from_path,
            read_project_audio_pcm_chunk,
            read_project_audio_info,
            delete_project_data_files,
            clear_project_data_files,
            open_project_location,
            pick_media_file,
            pick_media_files,
            extract_media_audio,
            extract_media_audio_from_path,
            read_media_file,
            secure_texts,
            secure_image,
            ffmpeg_sidecar_path,
            allow_media_file_path
        ])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                let server = window.app_handle().state::<ServerProcess>();
                server.stop();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            let server = app_handle.state::<ServerProcess>();
            server.stop();
        }
    });
}
