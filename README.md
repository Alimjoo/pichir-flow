<p align="center">
  <img src="frontend/src-tauri/icons/128x128.png" width="128" height="128" alt="PichirFlow icon">
</p>

<h1 align="center">PichirFlow</h1>

<p align="center">
  Private, local-first microphone, audio, and video transcription powered by whisper.cpp.
</p>

<p align="center">
  <a href="https://github.com/Alimjoo/pichir-flow/releases/latest"><img src="https://img.shields.io/github/v/release/Alimjoo/pichir-flow?display_name=tag&sort=semver" alt="Latest release"></a>
  <a href="https://github.com/Alimjoo/pichir-flow/actions/workflows/release.yml"><img src="https://github.com/Alimjoo/pichir-flow/actions/workflows/release.yml/badge.svg" alt="Release build"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-555" alt="Supported platforms">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Non--Commercial-orange" alt="PichirFlow Non-Commercial License"></a>
  <a href="https://ko-fi.com/piyazon"><img src="https://img.shields.io/badge/Ko--fi-Support%20Piyazon-FF5E5B?logo=ko-fi&logoColor=white" alt="Support Piyazon on Ko-fi"></a>
</p>

PichirFlow is a cross-platform desktop application for private speech-to-text transcription. It records from a microphone, transcribes audio and video files, and supports real-time stream simulation for continuous transcription. It also manages local projects and exports timestamped subtitles. Recognition totally runs locally.

## Features

- Live microphone transcription with confirmed and unconfirmed text.
- Audio and video file transcription, including multi-file queues.
- Automatic switching between a Uyghur-specific model and a general multilingual model.
- Silero voice activity detection (VAD) for speech boundaries and silence-based finalization.
- Timestamped timeline and whole-transcript views.
- Local project history with resume support for incomplete file jobs.
- SRT subtitle export and local project data files.
- Recorded microphone audio playback and export.
- English, Uyghur, Chinese, and Spanish interface translations.
- Metal acceleration on Apple Silicon and Vulkan builds for other supported release targets.
- CPU fallback when a compatible accelerated backend is unavailable.
- A local WebSocket API for custom integrations.
- Real-time stream simulation for continuous audio transcription.

## Roadmap and to-do

This checklist records what PichirFlow already supports and the main areas planned for future work. Checked items are available now; unchecked items are ideas or planned work rather than release promises.

### Completed

- [x] Fully local microphone transcription.
- [x] Audio and video transcription with multi-file queues.
- [x] Uyghur-only and multilingual model separation with automatic switching.
- [x] Silero VAD, live preview text, silence-based confirmation, and queued-audio finalization.
- [x] Local project history and resume support for incomplete file jobs.
- [x] Whole-text and timestamped timeline views.
- [x] SRT export and recorded microphone-audio export.
- [x] English, Uyghur, Chinese, and Spanish display languages, including RTL support.
- [x] Metal, Vulkan, and CPU backend selection/fallback paths.
- [x] Raw microphone capture that can acoustically hear computer-speaker playback.
- [x] Cross-platform macOS, Windows, and Linux release workflows.
- [x] Standalone local WebSocket API.
- [x] Real-time stream simulation for continuous transcription.

### Planned and open for contributions

- [ ] **System-wide voice typing in any application**, with recognized text inserted at the active cursor.
- [ ] Global push-to-talk and start/stop keyboard shortcuts.
- [ ] Direct system-audio/loopback capture without relying on the physical microphone.
- [ ] Microphone/input-device selector and live input-level meter.
- [ ] Optional raw, noise-suppressed, and voice-focused microphone modes.
- [ ] Editable transcripts with search, correction, and segment merging/splitting.
- [ ] Additional exports such as plain text, VTT, and structured JSON.
- [ ] Speaker diarization and speaker labels.
- [ ] More community-contributed display languages.
- [ ] Official CUDA release packages where supported.
- [ ] Automatic application updates and improved signed/notarized distribution.
- [ ] Broader automated tests for streaming, VAD, model switching, migrations, and exports.
- [ ] Accessibility review, complete keyboard navigation, and screen-reader improvements.

Want to help with an unchecked item or add a display language? Start with the [Contribution Guide](CONTRIBUTING.md).

## Models

Official release builds include three local model files:

| Model | Purpose | Language use |
| --- | --- | --- |
| `silero-v6.2.1-ggml.bin` | Silero VAD model used to detect speech and silence. It does not generate transcription text. | Language-independent voice activity detection. |
| `whisper-small-uyghur-q5_0.bin` | Quantized Whisper Small model specialized for Uyghur transcription. | **Uyghur only. Do not use this model for other languages.** |
| `whisper-small-q5_0.bin` | Quantized multilingual Whisper Small model. | Every supported language selection except Uyghur. |

The desktop app selects the model automatically:

- Selecting **Uyghur** loads `whisper-small-uyghur-q5_0.bin`.
- Selecting **English, Chinese, Spanish, or any other non-Uyghur language** loads `whisper-small-q5_0.bin`.
- Changing between Uyghur and a non-Uyghur language restarts the local ASR service with the correct model.

> [!IMPORTANT]
> The Uyghur model is intended only for the Uyghur language. Even closely related languages must use the general multilingual model.

The model assets used by the release workflow are hosted in the [PichirFlow models repository](https://huggingface.co/piyazon/pichier-flow-models).

## How it works

```text
Microphone / audio / video
             │
             ▼
       Tauri desktop UI
             │  16 kHz mono Float32 PCM
             ▼
   Local WebSocket (port 47831)
             │
             ├── Silero VAD: speech and silence boundaries
             └── whisper.cpp: preview and confirmed transcription
```

All ASR sessions, audio queues, and transcript state are isolated per WebSocket connection. The desktop app starts and stops the local backend automatically.

## Installation

Download the package for your platform from [GitHub Releases](https://github.com/Alimjoo/pichir-flow/releases/latest).

| Platform | Release backend |
| --- | --- |
| macOS Apple Silicon | Metal |
| macOS Intel | Vulkan through MoltenVK |
| Windows x64 | Vulkan |
| Linux x64 | Vulkan |

Install the downloaded package normally for your operating system. On first launch, allow microphone access if you want to use live transcription. GPU drivers must support the backend included in your package; the application can fall back to CPU when an appropriate CPU sidecar is available.

> [!NOTE]
> **macOS:** PichirFlow is currently unsigned because the project does not yet have an Apple Developer account. If Gatekeeper prevents an official PichirFlow release from opening, move the app to `/Applications`, then run:
>
> ```bash
> sudo xattr -rd com.apple.quarantine "/Applications/PichirFlow.app"
> ```
>
> Only remove quarantine from a package you downloaded from the official PichirFlow releases page.

Official packages bundle the ASR service, VAD model, both transcription models, and FFmpeg. They do not need a separate model download at runtime.

## Usage

### Choose a transcription language

1. Open **Settings**.
2. Choose the language spoken in the recording.
3. Optionally adjust **Maximum no-silence time**. The supported range is 3–20 seconds.
4. Confirm the settings.

PichirFlow automatically loads the Uyghur model only when **Uyghur** is selected. Every other language uses the multilingual model.

### Transcribe from a microphone

1. Select the correct language in **Settings**.
2. Press **Start** and speak normally.
3. Press **Stop** when finished.
4. Wait for **Processing remaining audio** to finish before closing the app.

When Stop is pressed, queued full audio chunks continue through normal VAD processing. Silence boundaries may finalize separate sections, and the final unconfirmed remainder is transcribed before the project is marked complete.

Microphone capture keeps voice processing disabled so sound played audibly through the computer speakers can reach the physical microphone. This is acoustic recording, not direct system-audio loopback: audio played only through headphones cannot be captured by the microphone.

### Transcribe audio or video files

1. Press **Choose file** and select one or more supported audio/video files.
2. Select the spoken language in **Settings**.
3. Press **Transcribe file**.
4. Follow progress in the Projects panel.

Common supported formats include WAV, MP3, M4A, AAC, FLAC, OGG, Opus, AIFF, MP4, MOV, MKV, AVI, MPEG, and WebM. FFmpeg is used when audio must be extracted or converted from native media.

### Review and export

- Use **Whole** to read the complete transcript.
- Use **Time** to review timestamped segments.
- Open a project's action menu to export SRT, open its local folder, resume an incomplete job, or delete it.
- Microphone projects can retain and export the recorded audio.

Project metadata, transcripts, segments, subtitles, and available project audio are stored locally in the application's data directory.

## Build from source

### Prerequisites

- CMake 3.15 or newer.
- A C++17 compiler.
- Rust stable.
- Node.js 20 or newer and npm.
- A local checkout of [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
- Platform development packages required by Tauri.
- Metal development support on Apple Silicon, or Vulkan SDK/runtime support for Vulkan builds.

The release workflow pins whisper.cpp commit `3e9b7d0fef3528ee2208da3cdb873a2c53d2ae2f`.

### 1. Clone the sources

```bash
git clone https://github.com/Alimjoo/pichir-flow.git
cd pichir-flow
git clone https://github.com/ggml-org/whisper.cpp.git ../whisper.cpp
git -C ../whisper.cpp checkout 3e9b7d0fef3528ee2208da3cdb873a2c53d2ae2f
```

You can keep whisper.cpp elsewhere and pass its location with `-DWHISPER_CPP_DIR=/absolute/path/to/whisper.cpp`.

### 2. Download the model assets

```bash
export SILERO_MODEL_URL="https://huggingface.co/piyazon/pichier-flow-models/resolve/main/silero-v6.2.1-ggml.bin"
export WHISPER_SMALL_MODEL_URL="https://huggingface.co/piyazon/pichier-flow-models/resolve/main/whisper-small-q5_0.bin"
export WHISPER_SMALL_UYGHUR_MODEL_URL="https://huggingface.co/piyazon/pichier-flow-models/resolve/main/whisper-small-uyghur-q5_0.bin"

bash scripts/ci/download-models.sh frontend/src-tauri/server
```

Review the licenses and usage terms of third-party models before redistributing them.

### 3. Build the native ASR backend

Apple Silicon with Metal:

```bash
cmake -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON \
  -DGGML_VULKAN=OFF \
  -DWHISPER_CPP_DIR="$(cd ../whisper.cpp && pwd)"

cmake --build build --config Release --target ASR --parallel
```

For a Vulkan build, use `-DGGML_METAL=OFF -DGGML_VULKAN=ON`. The post-build step copies the ASR executable into `frontend/src-tauri/server`.

### 4. Install frontend and FFmpeg dependencies

```bash
cd frontend
npm ci
npm install --no-save ffmpeg-static
node ../scripts/ci/install-ffmpeg-sidecar.cjs .
```

### 5. Run or package the desktop app

```bash
# Development
npm run dev

# Production packages
npm run build
```

The complete platform dependency and packaging commands are available in [the release workflow](.github/workflows/release.yml).

## Standalone ASR service

The native backend can be used without the desktop interface. Run it from a directory containing the selected transcription model and the Silero VAD model, or provide absolute paths through environment variables.

Multilingual example:

```bash
PICHIRFLOW_HELPER_MODEL_PATH=./silero-v6.2.1-ggml.bin \
PICHIRFLOW_WHISPER_MODEL_PATH=./whisper-small-q5_0.bin \
PICHIRFLOW_ASR_MODEL_FAMILY=non-uyghur \
./ASR
```

Uyghur-only example:

```bash
PICHIRFLOW_HELPER_MODEL_PATH=./silero-v6.2.1-ggml.bin \
PICHIRFLOW_WHISPER_MODEL_PATH=./whisper-small-uyghur-q5_0.bin \
PICHIRFLOW_ASR_MODEL_FAMILY=uyghur \
./ASR
```

The model is loaded once when the process starts. A WebSocket client cannot switch models inside an already-running backend process.

### Environment variables

| Variable | Description |
| --- | --- |
| `PICHIRFLOW_HELPER_MODEL_PATH` | Path to the Silero VAD model. |
| `PICHIRFLOW_WHISPER_MODEL_PATH` | Path to the transcription model loaded by this process. |
| `PICHIRFLOW_ASR_MODEL_FAMILY` | `uyghur` or `non-uyghur`. |
| `PICHIRFLOW_REQUIRED_BACKEND` | Force `metal`, `vulkan`, `cuda`, or `cpu`. |
| `PICHIRFLOW_DISABLE_GPU` | Set to a truthy value to force CPU execution. |
| `PICHIRFLOW_REQUIRE_GPU` | Fail startup instead of falling back when a requested GPU is unavailable. |
| `PICHIRFLOW_CPU_THREADS` | Worker thread count, clamped to 1–16. |
| `PICHIRFLOW_DISABLE_PREVIEW` | Disable live unconfirmed preview inference. |
| `PICHIRFLOW_LOG_FILE` | Path for backend diagnostic logs. Defaults to `ASR-debug.log`. |

## WebSocket API

The service listens at:

```text
ws://localhost:47831
```

Audio is sent as binary messages with this format:

| Property | Required value |
| --- | --- |
| Sample rate | 16,000 Hz |
| Channels | Mono |
| Sample type | 32-bit floating point PCM |
| Sample range | `-1.0` to `1.0` |

Chunks between 100 ms and 1,000 ms are recommended.

### Start

```json
{
  "type": "start",
  "asrLanguage": "English",
  "asrLanguageCode": "en",
  "maxUnconfirmedSec": 15
}
```

`maxUnconfirmedSec` is clamped to 3–20 seconds. The start message configures the language used by the model already loaded in the process; it does not change model files.

### Stop

Stop accepting new audio and finish everything already queued:

```json
{ "type": "stop" }
```

### Cancel

Discard the active session and queued audio:

```json
{ "type": "cancel" }
```

### Server messages

| Type | Meaning |
| --- | --- |
| `status` | Connection and processing state such as `recording`, `processing remaining audio`, or `stopped`. |
| `reset` | Clear the transcript for a new session. |
| `unconfirmed` | Live preview text that may be replaced. |
| `confirmed` | Final text that can be appended to the transcript. |
| `segment` | Final text with `start_ms` and `end_ms` timestamps. |
| `backend` | Active compute backend. |
| `model` | Active model family. |

Minimal browser client:

```js
const ws = new WebSocket("ws://localhost:47831");
ws.binaryType = "arraybuffer";

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({
    type: "start",
    asrLanguage: "English",
    asrLanguageCode: "en",
    maxUnconfirmedSec: 15,
  }));
});

ws.addEventListener("message", (event) => {
  console.log(JSON.parse(event.data));
});

function sendAudio(float32Pcm16k) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(float32Pcm16k.buffer);
  }
}

function stop() {
  ws.send(JSON.stringify({ type: "stop" }));
}
```

## Troubleshooting

### Microphone permission denied

Allow PichirFlow to access the microphone in your operating system's privacy settings, then restart the app.

### Speaker playback is not transcribed

PichirFlow can hear speaker playback only when that sound physically reaches the selected microphone. Increase the speaker level, move closer to the microphone, and ensure the correct input device is active. Headphones and direct system audio require a separate loopback or virtual audio device.

### Stop takes time

Stop drains all queued audio before finalizing the project. The status displays **Processing remaining audio** during this expected step. Slower CPU backends and long backlogs take longer.

### Backend does not start

- Check that all three model files and the correct ASR sidecar are present.
- Confirm that port `47831` is available.
- Update the GPU driver or try a CPU build.
- Inspect `ASR-debug.log` and the desktop sidecar log in the application data directory.

## Contributing

Bug reports, documentation improvements, translations, platform fixes, and focused pull requests are welcome. Read the full [Contribution Guide](CONTRIBUTING.md) before submitting a change.

Quick checklist:

- Search existing issues and discuss large changes before implementation.
- Keep each pull request focused on one problem.
- Include the operating system, hardware/backend, language, and test results.
- Run the relevant C++, frontend, and Rust validation commands.
- Remove private recordings, transcripts, local paths, credentials, and generated files.
- Preserve the strict separation between the Uyghur-only and multilingual models.

Contributions and modified builds remain subject to the repository license. See [CONTRIBUTING.md](CONTRIBUTING.md#license-and-attribution) for details.

## Support the project

<p align="center">
  <strong>Help keep private, local speech tools moving forward.</strong><br>
  Donations support development, testing, model integration, and cross-platform releases.
</p>

<table align="center">
  <tr>
    <td align="center" width="230">
      <a href="https://ko-fi.com/piyazon">
        <img src="docs/assets/ko-fi-piyazon-qr.png" width="190" alt="QR code for Piyazon's Ko-fi page">
      </a>
      <br>
      <sub><strong>Scan to open Ko-fi</strong></sub>
    </td>
    <td align="center" width="470">
      <h3>☕ Support PichirFlow</h3>
      <p>If PichirFlow is useful to you, consider supporting its continued development through Ko-fi.</p>
      <p>
        <a href="https://ko-fi.com/piyazon">
          <img src="https://img.shields.io/badge/Support%20PichirFlow%20on%20Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Support PichirFlow on Ko-fi">
        </a>
      </p>
      <p><a href="https://ko-fi.com/piyazon"><strong>ko-fi.com/piyazon</strong></a></p>
      <sub>Thank you for supporting independent development.</sub>
    </td>
  </tr>
</table>

<p align="center">
  <a href="https://github.com/Alimjoo/pichir-flow/stargazers"><img src="https://img.shields.io/badge/Star-the%20repository-24292f?logo=github" alt="Star the repository"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/Contribute-code%20or%20translations-2ea44f?logo=github" alt="Contribute code or translations"></a>
  <a href="https://github.com/Alimjoo/pichir-flow/issues"><img src="https://img.shields.io/badge/Report-an%20issue-d73a49?logo=github" alt="Report an issue"></a>
</p>

## License

Copyright © 2026 Piyazon. All rights reserved.

PichirFlow is source-available and free for personal, educational, research, evaluation, and other non-commercial use. Commercial use, resale, paid hosting, paid transcription services, SaaS, bundling with paid products, and other revenue-generating use require prior written permission from the copyright holder.

Anyone distributing the original application or a modified version must preserve attribution, include the license, state that use is non-commercial only, and clearly identify modifications.

See the complete English, Chinese, and Uyghur terms in [LICENSE](LICENSE).
