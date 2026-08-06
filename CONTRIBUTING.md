# Contributing to PichirFlow

Thank you for helping improve PichirFlow. Bug reports, documentation fixes, translations, platform improvements, and focused code contributions are welcome.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- For a large feature, architecture change, new dependency, or model change, open an issue first so the approach can be discussed.
- Keep each contribution focused on one problem. Unrelated cleanup should be submitted separately.
- Never include private recordings, transcripts, API credentials, signing keys, or personal paths in commits or issue reports.

## Repository layout

| Path | Purpose |
| --- | --- |
| `server.cpp` | Native C++ ASR WebSocket service, VAD flow, transcription, and backend selection. |
| `frontend/src` | Desktop interface, microphone/file streaming, projects, exports, and translations. |
| `frontend/src-tauri` | Tauri/Rust application shell, native commands, sidecar lifecycle, and packaging. |
| `scripts/ci` | Model, FFmpeg, runtime, and release helper scripts. |
| `.github/workflows` | Cross-platform release builds. |

See [README.md](README.md#build-from-source) for prerequisites, model setup, and full build instructions.

## Development workflow

1. Fork the repository and create a branch from the current `main` branch.
2. Use a short, descriptive branch name such as `fix/microphone-stop` or `docs/linux-build`.
3. Make the smallest change that completely solves the problem.
4. Preserve the existing code style and avoid formatting unrelated files.
5. Add or update documentation when behavior, configuration, models, or public messages change.
6. Run the relevant validation commands below.
7. Review your diff for generated files, model binaries, logs, recordings, and unrelated changes before opening a pull request.

## Validation

Run the checks relevant to your change. A full cross-platform build is not expected from every contributor, but clearly state which platform and backend you tested.

### General checks

```bash
git diff --check
legacy_name="$(printf '%s%s' 'ug' 'asr')"
git grep -in "$legacy_name" -- .
```

The second command should return no matches; the package and application name is PichirFlow.

### Native ASR backend

```bash
cmake -S . -B build \
  -DCMAKE_BUILD_TYPE=Debug \
  -DWHISPER_CPP_DIR=/absolute/path/to/whisper.cpp

cmake --build build --config Debug --target ASR --parallel
```

Add the appropriate `-DGGML_METAL=ON` or `-DGGML_VULKAN=ON` option for the backend being tested.

When changing streaming, VAD, or finalization behavior, verify at least:

- Live preview continues while audio arrives.
- Speech followed by silence is finalized correctly.
- Pressing Stop drains queued audio and reaches the `stopped` state.
- Cancel discards queued audio without confirming it.
- A long recording does not permanently grow the processing backlog.

### Frontend

```bash
cd frontend
node --check src/main.js
npm run frontend:build
```

For microphone or file changes, test both a new project and an existing saved project. Confirm that the timeline, whole-text view, playback, and applicable exports still work.

### Adding a display language

Display-language translations are a good first contribution. They translate the PichirFlow interface; they do not add a new speech-recognition language or model.

1. Copy `frontend/src/locale/english.js` to a new lowercase file such as `frontend/src/locale/german.js`.
2. Update the locale metadata and translate every value in the `ui` object.
3. Import and register the locale in `frontend/src/locale/index.js`.
4. Build the frontend, select the new language in **Settings → Display language**, and inspect every screen.

A locale starts with this structure:

```js
export default {
  code: "german",
  htmlLang: "de",
  dir: "ltr",
  dateLocale: "de-DE",
  nativeName: "Deutsch",
  ui: {
    // Copy every key from english.js and translate its value.
  },
};
```

Register it in `frontend/src/locale/index.js`:

```js
import german from "./german.js";

export const LOCALES = {
  // Existing locales...
  german,
};

export const DISPLAY_LANGUAGE_OPTIONS = [
  // Existing options...
  { code: "german", label: german.nativeName },
];
```

Translation requirements:

- Use a stable lowercase `code` matching the registry key.
- Use a valid BCP 47 value for `htmlLang` and an appropriate locale for `dateLocale`.
- Set `dir` to `rtl` for right-to-left interfaces such as Arabic or Persian; otherwise use `ltr`.
- Keep every key present in `english.js`. Do not translate keys such as `projects.title`; translate only their values.
- Preserve placeholders exactly, including `{count}` and `{message}`.
- Keep the product name `PichirFlow`, author name `Piyazon`, and license meaning unchanged.
- Use natural interface language rather than word-for-word machine translation.
- Do not insert HTML into translation values.

From the `frontend` directory, compare the new locale with English before building. Replace `german.js` in this command with your filename:

```bash
node --input-type=module -e '
import english from "./src/locale/english.js";
import candidate from "./src/locale/german.js";
const missing = Object.keys(english.ui).filter((key) => !(key in candidate.ui));
const extra = Object.keys(candidate.ui).filter((key) => !(key in english.ui));
console.log({ missing, extra });
if (missing.length || extra.length) process.exit(1);
'

node --check src/locale/german.js
npm run frontend:build
```

Test all of the following manually:

- Settings and About dialogs.
- Microphone Start/Stop and status messages.
- File selection, batch progress, and error messages.
- Empty, running, completed, cancelled, and failed project states.
- Project actions, timeline/whole-text switch, and export messages.
- Long labels at the smallest supported window size.
- RTL layout and mixed-direction transcript text when `dir` is `rtl`.

Include screenshots with the pull request. Also update the README's display-language list and completed roadmap item to include the new language.

### Tauri/Rust

```bash
cd frontend/src-tauri
cargo fmt --check
cargo check --locked
```

To verify the final desktop bundle:

```bash
cd frontend
npm run tauri -- build --bundles app
```

### Model switching

If a change affects language or model selection, test both directions:

- Uyghur must load `whisper-small-uyghur-q5_0.bin`.
- Every non-Uyghur language must load `whisper-small-q5_0.bin`.

The Uyghur-specific model must not be used for other languages.

## Reporting bugs

A useful bug report includes:

- PichirFlow version or commit.
- Operating system and architecture.
- CPU/GPU model and active backend: Metal, Vulkan, CUDA, or CPU.
- Selected transcription language and whether the source was microphone, audio, or video.
- Exact reproduction steps.
- Expected and actual behavior.
- The relevant final portion of `ASR-debug.log`.

Logs can contain local file paths and recognized text. Remove anything private before posting. Share a short synthetic or public-domain sample only when audio is necessary to reproduce the problem.

## Model and dependency changes

- Do not commit model binaries, generated installers, build directories, logs, or recorded audio.
- Explain the source, license, size, checksum, and expected accuracy/performance impact of a proposed model.
- Keep the Uyghur-specific and multilingual model roles separate.
- Avoid new runtime dependencies unless they materially improve the application and can be packaged on all supported platforms.
- Update the release workflow and README when a dependency changes platform requirements.

## Pull requests

Your pull request description should include:

- What changed and why.
- How the change was tested.
- Tested operating system, architecture, and backend.
- Screenshots for visible interface changes.
- Any compatibility, performance, model-size, or migration impact.
- Related issue numbers, when applicable.

Before submitting, confirm that:

- [ ] The change is focused and contains no unrelated formatting.
- [ ] Source files contain no private data or generated artifacts.
- [ ] Relevant builds and checks pass.
- [ ] User-facing behavior and configuration are documented.
- [ ] Existing projects and settings are preserved or intentionally migrated.
- [ ] The pull request clearly states anything that was not tested.

## License and attribution

By submitting a contribution, you confirm that you have the right to provide it and agree that it will be distributed under the [PichirFlow Non-Commercial License 1.0](LICENSE). Third-party components remain governed by their original licenses.

Do not remove copyright notices, attribution, license notices, or statements identifying modified versions.
