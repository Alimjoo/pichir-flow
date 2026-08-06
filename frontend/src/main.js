import {
  FILE_CHUNK_MS,
  FILE_STREAM_SPEED,
  MAX_WS_BUFFERED_BYTES,
  NATIVE_EXTRACTED_FILE_STREAM_SPEED,
  TARGET_SAMPLE_RATE,
  audioBufferToMono,
  bytesToArrayBuffer,
  concatFloat32Chunks,
  float32ToWavBlob,
  isMediaSelection,
  looksLikeVideoMedia,
  mediaTypeFromFileName,
  nativeMediaFileFromPath,
  pcmI16BytesToFloat32,
  pcmI16BytesToWavBlob,
  resampleBuffer,
  supportedMediaFiles,
} from './asr.js';
import {
  DEFAULT_DISPLAY_LANGUAGE,
  DISPLAY_LANGUAGE_OPTIONS,
  LOCALES,
} from './locale/index.js';
let ws = null;
let reconnectTimer = null;
let ensureServerPromise = null;
let ensureServerPromiseMode = null;
let hasConnectedOnce = false;
let reportedServerModelMode = null;

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;

let recording = false;
let fileStreaming = false;
let fileStreamToken = 0;
let currentRunMode = null;
let mediaRecorder = null;
let mediaRecorderChunks = [];
let microphonePcmChunks = [];
let mediaPlaybackCleanup = null;
let fileMediaCleanup = null;
let activePlaybackKey = null;
let selectedNativeMediaFile = null;
let selectedDroppedMediaFile = null;
let selectedNativeMediaFiles = [];
let selectedDroppedMediaFiles = [];

let confirmedText = "";
let unconfirmedText = "";

let projects = [];
let activeProjectId = null;
let currentProjectId = null;
let pendingConfirmedSkips = [];
let openProjectMenuId = null;
let resultViewMode = "timeline";
let appSettings = {
  asrLanguage: "Uyghur",
  maxUnconfirmedSec: 15,
  displayLanguage: DEFAULT_DISPLAY_LANGUAGE,
};
let pendingSettings = { ...appSettings };
let activeLocale = LOCALES[DEFAULT_DISPLAY_LANGUAGE];
let currentStatus = {
  key: "status.modelStarting",
  params: {},
  text: "",
};
let activeServerModelMode = null;
let serverIndicatorState = "offline";
let modelChangedStatusUntil = 0;
let asrBatchRunning = false;
let asrBatchStopRequested = false;
let asrBatchTotal = 0;
let asrBatchDone = 0;
let currentFileRunWaiter = null;
let currentRunOffsetMs = 0;

const WS_URL = "ws://localhost:47831";
const WS_CONNECT_TIMEOUT_MS = 120000;
const PROJECTS_KEY = "ugasr.projects.v1";
const RESULT_VIEW_KEY = "ugasr.resultView.v1";
const SETTINGS_KEY = "ugasr.settings.v1";
const SETTINGS_VERSION = 3;
const DEFAULT_MAX_UNCONFIRMED_SEC = 15;
const MEDIA_DB_NAME = "ugasr-media";
const MEDIA_DB_VERSION = 1;
const MEDIA_STORE_NAME = "media";
const ASR_PROJECT_SOURCE_TYPES = new Set(["microphone", "file", "video"]);
const STATUS_TEXT_KEYS = {
  connected: "status.connected",
  stopped: "status.stopped",
  cancelled: "status.cancelled",
  recording: "status.recording",
  "processing remaining audio": "status.processingRemaining",
  "swaping model(مودىل ئالماشتۇرىلىۋاتىدۇ)": "status.modelSwapping",
  "model changed(مودىل ئالماشتۇرۇلدى)": "status.modelChanged",
  "model error": "status.modelError",
};

const confirmedEl = document.getElementById("confirmed");
const unconfirmedEl = document.getElementById("unconfirmed");
const statusEl = document.getElementById("status");
const serverLedEl = document.getElementById("serverLed");
const backendLabelEl = document.getElementById("backendLabel");
const appTitleEl = document.getElementById("appTitle");
const projectListEl = document.getElementById("projectList");
const sidePanelTitleEl = document.getElementById("sidePanelTitle");
const resumeAllBtn = document.getElementById("resumeAllBtn");
const activeProjectTitleEl = document.getElementById("activeProjectTitle");
const timelineEl = document.getElementById("timeline");
const segmentCountEl = document.getElementById("segmentCount");
const clearProjectsBtn = document.getElementById("clearProjectsBtn");
const resultPaneTitleEl = document.getElementById("resultPaneTitle");
const wholeViewBtn = document.getElementById("wholeViewBtn");
const timelineViewBtn = document.getElementById("timelineViewBtn");
const aboutBtn = document.getElementById("aboutBtn");
const aboutModalEl = document.getElementById("aboutModal");
const aboutCloseBtn = document.getElementById("aboutCloseBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsModalEl = document.getElementById("settingsModal");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsConfirmBtn = document.getElementById("settingsConfirmBtn");
const asrLanguageSelectEl = document.getElementById("asrLanguageSelect");
const maxUnconfirmedRangeEl = document.getElementById("maxUnconfirmedRange");
const maxUnconfirmedValueEl = document.getElementById("maxUnconfirmedValue");
const displayLanguageSelectEl = document.getElementById("displayLanguageSelect");
const asrPanelEl = document.getElementById("asrPanel");
const asrBatchProgressEl = document.getElementById("asrBatchProgress");
const asrBatchProgressLabelEl = document.getElementById("asrBatchProgressLabel");
const asrBatchProgressValueEl = document.getElementById("asrBatchProgressValue");
const asrBatchProgressBarEl = document.getElementById("asrBatchProgressBar");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const fileBtn = document.getElementById("fileBtn");
const audioFileEl = document.getElementById("audioFile");
const filePickerEl = document.querySelector(".file-picker");
const selectedFileNameEl = document.getElementById("selectedFileName");

async function invokeProtectedCommand(command, args = {}) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  if (!tauriInvoke) {
    throw new Error("Protected Tauri API is unavailable");
  }

  return await tauriInvoke(command, args);
}

function normalizeDisplayLanguage(value) {
  const language = String(value || "").trim();
  return LOCALES[language] ? language : DEFAULT_DISPLAY_LANGUAGE;
}

function localeTextMap(locale = activeLocale) {
  return locale?.ui || {};
}

function hasTranslationKey(key) {
  return Boolean(
    localeTextMap(activeLocale)[key] ||
      localeTextMap(LOCALES[DEFAULT_DISPLAY_LANGUAGE])[key],
  );
}

function t(key, params = {}) {
  const template =
    localeTextMap(activeLocale)[key] ||
    localeTextMap(LOCALES[DEFAULT_DISPLAY_LANGUAGE])[key] ||
    key;

  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

function setActiveLocale(displayLanguage) {
  const code = normalizeDisplayLanguage(displayLanguage);
  activeLocale = LOCALES[code] || LOCALES[DEFAULT_DISPLAY_LANGUAGE];
  document.documentElement.lang = activeLocale.htmlLang || "en";
  document.documentElement.dir = activeLocale.dir || "ltr";
  document.body.dir = activeLocale.dir || "ltr";
}

function applyLocaleToDom() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }

  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.setAttribute("title", t(el.dataset.i18nTitle));
  }

  for (const el of document.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }
}

async function verifySecureImage(imageEl) {
  const imageKey = imageEl.dataset.secureImage;

  imageEl.removeAttribute("src");
  imageEl.hidden = true;

  if (!imageKey) {
    console.warn(`Secure image blocked: ${imageKey || "missing key"}`);
    return;
  }

  try {
    const secureImage = await invokeProtectedCommand("secure_image", { key: imageKey });
    const bytes = Array.isArray(secureImage?.bytes) ? secureImage.bytes : [];
    if (!bytes.length) {
      throw new Error("Secure image command returned no bytes");
    }

    if (imageEl.dataset.secureObjectUrl) {
      URL.revokeObjectURL(imageEl.dataset.secureObjectUrl);
    }

    const blob = new Blob([new Uint8Array(bytes)], {
      type: secureImage.mimeType || "application/octet-stream",
    });
    const objectUrl = URL.createObjectURL(blob);
    imageEl.dataset.secureObjectUrl = objectUrl;
    imageEl.src = objectUrl;
    imageEl.hidden = false;
  } catch (err) {
    console.warn(`Secure image blocked: ${imageKey}`, err);
  }
}

function installSecureImages() {
  const images = document.querySelectorAll("img[data-secure-image]");
  for (const imageEl of images) {
    void verifySecureImage(imageEl);
  }
}

async function installProtectedUi() {
  installSecureImages();
}

function renderText() {
  applyTranscriptDirection(getActiveProject());
  confirmedEl.textContent = normalizeTranscriptText(confirmedText);
  unconfirmedEl.textContent = normalizeTranscriptText(unconfirmedText);
}

function resolveStatus(value, params = {}) {
  const key = STATUS_TEXT_KEYS[value] || (hasTranslationKey(value) ? value : "");

  if (key) {
    return {
      key,
      params,
      text: t(key, params),
    };
  }

  return {
    key: "",
    params: {},
    text: String(value || ""),
  };
}

function setStatus(value, params = {}) {
  const status = resolveStatus(value, params);
  currentStatus = status;
  statusEl.textContent = status.text;
}

function statusValueMatchesKey(value, key) {
  return resolveStatus(value).key === key || String(value || "") === t(key);
}

function refreshCurrentStatusText() {
  if (currentStatus.key) {
    statusEl.textContent = t(currentStatus.key, currentStatus.params);
  }
}

function sendServerCommand(type, extra = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  ws.send(JSON.stringify({ type, ...extra }));
  return true;
}

function isAsrBusy() {
  return asrBatchRunning || recording || fileStreaming || Boolean(currentRunMode);
}

function isServerBusy() {
  return isAsrBusy() || serverIndicatorState === "working";
}

function updateModeTabState() {
}

function updateSettingsButtonState() {
  if (!settingsBtn) {
    return;
  }

  settingsBtn.hidden = false;
  settingsBtn.setAttribute("aria-hidden", "false");
  settingsBtn.tabIndex = 0;
  settingsBtn.disabled = isServerBusy();
  updateModeTabState();
}

function setServerIndicator(state) {
  serverIndicatorState = state;
  serverLedEl.className = "";
  serverLedEl.classList.add("server-" + state);
  updateSettingsButtonState();
}

function setServerIndicatorFromStatus(text) {
  if (text === "connected" || text === "stopped" || text === "cancelled") {
    setServerIndicator("available");
    return;
  }

  setServerIndicator("working");
}

function setBackendLabel(text) {
  backendLabelEl.textContent = text ? `[${text}]` : "";
}

function updateModeTitle() {
  appTitleEl.textContent = t("app.title");
  document.title = t("app.name");
}

function applyLocale() {
  applyLocaleToDom();
  updateModeTitle();
  renderSettings();
  updateSelectedFileName();
  renderProjects();
  renderActiveProject();
  refreshCurrentStatusText();
}

function errorMessage(err) {
  if (typeof err === "string") {
    return err;
  }

  return err?.message || String(err || "");
}

function setBusyState(isBusy) {
  startBtn.disabled = isBusy;
  fileBtn.disabled = isBusy;
  audioFileEl.disabled = isBusy;
  filePickerEl.classList.toggle("disabled", isBusy);
  updateSettingsButtonState();
  updateClearButtonState();
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateSelectedFileName() {
  const selectedFiles =
    selectedNativeMediaFiles.length > 0
      ? selectedNativeMediaFiles
      : selectedDroppedMediaFiles.length > 0
        ? selectedDroppedMediaFiles
        : Array.from(audioFileEl.files || []).filter(isMediaSelection);

  if (selectedFiles.length > 1) {
    selectedFileNameEl.textContent = t("file.selectedCount", {
      count: selectedFiles.length,
    });
    return;
  }

  selectedFileNameEl.textContent =
    selectedFiles[0]?.name ||
    t("file.none");
}

function fileNameFromPath(path, fallback = "media") {
  const name = String(path || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();

  return name || fallback;
}

async function allowNativeFilePath(path) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!tauriInvoke || !path) {
    return;
  }

  await tauriInvoke("allow_media_file_path", { path }).catch((err) => {
    console.error(err);
  });
}

async function selectAsrNativeMediaPath(path, name = fileNameFromPath(path)) {
  await selectAsrNativeMediaPaths([nativeMediaFileFromPath(path, name)]);
}

async function selectAsrNativeMediaPaths(mediaFiles) {
  const supported = supportedMediaFiles(mediaFiles);

  if (supported.length === 0) {
    setStatus("file.selectAudioVideo");
    return;
  }

  selectedNativeMediaFiles = supported;
  selectedNativeMediaFile = supported[0] || null;
  selectedDroppedMediaFiles = [];
  selectedDroppedMediaFile = null;
  audioFileEl.value = "";
  await Promise.all(
    supported
      .filter((mediaFile) => mediaFile.path)
      .map((mediaFile) => allowNativeFilePath(mediaFile.path)),
  );
  updateSelectedFileName();
  setStatus(
    supported.length > 1
      ? "file.selectedCount"
      : "file.selected",
    { count: supported.length },
  );
}

function selectAsrDroppedMediaFile(file) {
  selectAsrDroppedMediaFiles([file]);
}

function selectAsrDroppedMediaFiles(files) {
  const supported = supportedMediaFiles(files);

  if (supported.length === 0) {
    setStatus("file.selectAudioVideo");
    return;
  }

  selectedNativeMediaFile = null;
  selectedNativeMediaFiles = [];
  selectedDroppedMediaFiles = supported;
  selectedDroppedMediaFile = supported[0] || null;
  audioFileEl.value = "";
  updateSelectedFileName();
  setStatus(
    supported.length > 1
      ? "file.selectedCount"
      : "file.selected",
    { count: supported.length },
  );
}

async function pickNativeMediaFile() {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!tauriInvoke) {
    audioFileEl.click();
    return;
  }

  try {
    let picked = await tauriInvoke("pick_media_files").catch(async () => {
      const single = await tauriInvoke("pick_media_file");
      return single ? [single] : [];
    });

    if (!Array.isArray(picked)) {
      picked = picked ? [picked] : [];
    }

    if (picked.length === 0) {
      return;
    }

    await selectAsrNativeMediaPaths(
      picked.map((item) => nativeMediaFileFromPath(item.path, item.name)),
    );
  } catch (err) {
    console.error(err);
    setStatus("file.pickError", { message: errorMessage(err) });
  }
}

function sendPcmSamples(samples) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !samples?.byteLength) {
    return;
  }

  const payload =
    samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength
      ? samples.buffer
      : samples.buffer.slice(
          samples.byteOffset,
          samples.byteOffset + samples.byteLength,
        );

  ws.send(payload);
}

async function getMicrophoneStream() {
  const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(
    navigator.mediaDevices,
  );

  if (!getUserMedia) {
    const err = new Error("getUserMedia is not available");
    err.name = "NotSupportedError";
    throw err;
  }

  try {
    return await getUserMedia({
      audio: {
        channelCount: 1,
        // Preserve playback from the computer speakers in the microphone
        // signal instead of treating it as echo/background noise.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
      throw err;
    }
  }

  return getUserMedia({ audio: true });
}

function microphoneStatusText(err) {
  if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
    return t("microphone.permission");
  }

  if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
    return t("microphone.notFound");
  }

  if (err?.name === "NotReadableError" || err?.name === "TrackStartError") {
    return t("microphone.notReadable");
  }

  if (err?.name === "NotSupportedError") {
    return t("microphone.notSupported");
  }

  return t("microphone.failed");
}

function serverStartupStatusText(err) {
  const message = String(err?.message || err || "").trim();

  return message
    ? t("status.serverStartupFailedWithMessage", { message })
    : t("status.serverStartupFailed");
}

function normalizeTranscriptText(text) {
  return String(text || "")
    .replace(/\[_EOT_\]/giu, " ")
    .replace(/\[_ئەئوت_\]/gu, " ")
    .replace(/\[\s*_?\s*ئەئوت\s*_?\s*\]/gu, " ")
    .replace(/^[\s\u00a0\u2000-\u200f\u2028\u2029\u2060\ufeff]+/u, "")
    .replace(/\n[\s\u00a0\u2000-\u200f\u2028\u2029\u2060\ufeff]+/gu, "\n")
    .replace(/[ \t]{2,}/g, " ");
}

function hasMeaningfulTranscriptText(text) {
  return /[\p{L}\p{N}]/u.test(normalizeTranscriptText(text));
}

function appendTranscriptText(existing, next) {
  const left = normalizeTranscriptText(existing).trimEnd();
  const right = normalizeTranscriptText(next).trim();

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return `${left} ${right}`;
}

function transcriptFromSegments(segments = []) {
  return segments.reduce(
    (transcript, segment) => appendTranscriptText(transcript, segment.text),
    "",
  );
}

function lastProjectSegmentEndMs(project) {
  return (project?.segments || []).reduce((maxEndMs, segment) => {
    const endMs = Number(segment.endMs || 0);
    return Number.isFinite(endMs) ? Math.max(maxEndMs, endMs) : maxEndMs;
  }, 0);
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString(activeLocale.dateLocale || "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatProjectTitleTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function formatSrtTime(ms) {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

function makeSrtFileName(project) {
  const baseName = (project.sourceName || project.title || "transcript")
    .replace(/\.[^/.]+$/, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();

  return `${baseName || "transcript"}.srt`;
}

function buildSrt(project) {
  const segments = project.segments.length > 0
    ? project.segments
    : [{
        startMs: 0,
        endMs: Math.max(project.durationMs || 0, 1000),
        text: project.transcript,
      }];

  return segments
    .filter((segment) => (segment.text || "").trim())
    .map((segment, index) => {
      const startMs = Number(segment.startMs || 0);
      const endMs = Math.max(Number(segment.endMs || 0), startMs + 1);

      return [
        String(index + 1),
        `${formatSrtTime(startMs)} --> ${formatSrtTime(endMs)}`,
        (segment.text || "").trim(),
      ].join("\n");
    })
    .join("\n\n");
}

function downloadTextFile(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBlobFile(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

const ASR_LANGUAGE_CODES = {
  Uyghur: "uz",
  Chinese: "zh",
  English: "en",
  Spanish: "es",
  Hindi: "hi",
  Bengali: "bn",
  Portuguese: "pt",
  Russian: "ru",
  Japanese: "ja",
  Vietnamese: "vi",
  Turkish: "tr",
  Korean: "ko",
  French: "fr",
  German: "de",
  Italian: "it",
  Indonesian: "id",
  Urdu: "ur",
  Punjabi: "pa",
  Persian: "fa",
  Javanese: "jw",
  Telugu: "te",
  Marathi: "mr",
  Tamil: "ta",
  Gujarati: "gu",
  Kannada: "kn",
  Malayalam: "ml",
  Malay: "ms",
  Thai: "th",
  Myanmar: "my",
  Polish: "pl",
  Ukrainian: "uk",
  Dutch: "nl",
  Romanian: "ro",
  Greek: "el",
  Czech: "cs",
  Hungarian: "hu",
  Swedish: "sv",
  Hebrew: "he",
  Danish: "da",
  Finnish: "fi",
  Norwegian: "no",
  Slovak: "sk",
  Catalan: "ca",
  Croatian: "hr",
  Serbian: "sr",
  Bulgarian: "bg",
  Slovenian: "sl",
  Lithuanian: "lt",
  Latvian: "lv",
  Estonian: "et",
  Hausa: "ha",
  Swahili: "sw",
  Yoruba: "yo",
  Somali: "so",
  Amharic: "am",
  Nepali: "ne",
  Sinhala: "si",
  Khmer: "km",
  Lao: "lo",
  Tagalog: "tl",
  Sundanese: "su",
  Assamese: "as",
  Mongolian: "mn",
  Kazakh: "kk",
  Uzbek: "uz",
  Azerbaijani: "az",
  Turkmen: "tk",
  Tajik: "tg",
  Pashto: "ps",
  Tatar: "tt",
  Bashkir: "ba",
  Sindhi: "sd",
  Tibetan: "bo",
  Sanskrit: "sa",
  Armenian: "hy",
  Georgian: "ka",
  Albanian: "sq",
  Bosnian: "bs",
  Macedonian: "mk",
  Belarusian: "be",
  Basque: "eu",
  Galician: "gl",
  Welsh: "cy",
  Afrikaans: "af",
  Malagasy: "mg",
  Shona: "sn",
  "Haitian Creole": "ht",
  Luxembourgish: "lb",
  Maltese: "mt",
  Icelandic: "is",
  Faroese: "fo",
  Breton: "br",
  Nynorsk: "nn",
  Occitan: "oc",
  Latin: "la",
  Maori: "mi",
  Hawaiian: "haw",
  Yiddish: "yi",
  Lingala: "ln",
  Cantonese: "yue",
  Arabic: "ar",
};

const ASR_LANGUAGES = Object.keys(ASR_LANGUAGE_CODES);

const ASR_LANGUAGE_LABELS = {
  Uyghur: "ئۇيغۇرچە",
  Afrikaans: "Afrikaans",
  Albanian: "Shqip",
  Amharic: "አማርኛ",
  Arabic: "العربية",
  Armenian: "Հայերեն",
  Assamese: "অসমীয়া",
  Azerbaijani: "Azərbaycanca",
  Bashkir: "Башҡортса",
  Basque: "Euskara",
  Belarusian: "Беларуская",
  Bengali: "বাংলা",
  Bosnian: "Bosanski",
  Breton: "Brezhoneg",
  Bulgarian: "Български",
  Cantonese: "粵語",
  Catalan: "Català",
  Chinese: "中文",
  Croatian: "Hrvatski",
  Czech: "Čeština",
  Danish: "Dansk",
  Dutch: "Nederlands",
  English: "English",
  Estonian: "Eesti",
  Faroese: "Føroyskt",
  Finnish: "Suomi",
  French: "Français",
  Galician: "Galego",
  Georgian: "ქართული",
  German: "Deutsch",
  Greek: "Ελληνικά",
  Gujarati: "ગુજરાતી",
  "Haitian Creole": "Kreyòl ayisyen",
  Hausa: "Hausa",
  Hawaiian: "ʻŌlelo Hawaiʻi",
  Hebrew: "עברית",
  Hindi: "हिन्दी",
  Hungarian: "Magyar",
  Icelandic: "Íslenska",
  Indonesian: "Bahasa Indonesia",
  Italian: "Italiano",
  Japanese: "日本語",
  Javanese: "Basa Jawa",
  Kannada: "ಕನ್ನಡ",
  Kazakh: "Қазақша",
  Khmer: "ខ្មែរ",
  Korean: "한국어",
  Lao: "ລາວ",
  Latin: "Latina",
  Latvian: "Latviešu",
  Lingala: "Lingála",
  Lithuanian: "Lietuvių",
  Luxembourgish: "Lëtzebuergesch",
  Macedonian: "Македонски",
  Malagasy: "Malagasy",
  Malay: "Bahasa Melayu",
  Malayalam: "മലയാളം",
  Maltese: "Malti",
  Maori: "Māori",
  Marathi: "मराठी",
  Mongolian: "Монгол",
  Myanmar: "မြန်မာ",
  Nepali: "नेपाली",
  Norwegian: "Norsk",
  Nynorsk: "Nynorsk",
  Occitan: "Occitan",
  Pashto: "پښتو",
  Persian: "فارسی",
  Polish: "Polski",
  Portuguese: "Português",
  Punjabi: "ਪੰਜਾਬੀ",
  Romanian: "Română",
  Russian: "Русский",
  Sanskrit: "संस्कृतम्",
  Serbian: "Српски",
  Shona: "Shona",
  Sindhi: "سنڌي",
  Sinhala: "සිංහල",
  Slovak: "Slovenčina",
  Slovenian: "Slovenščina",
  Somali: "Soomaali",
  Spanish: "Español",
  Sundanese: "Basa Sunda",
  Swahili: "Kiswahili",
  Swedish: "Svenska",
  Tagalog: "Tagalog",
  Tajik: "Тоҷикӣ",
  Tamil: "தமிழ்",
  Tatar: "Татарча",
  Telugu: "తెలుగు",
  Thai: "ไทย",
  Tibetan: "བོད་སྐད",
  Turkish: "Türkçe",
  Turkmen: "Türkmençe",
  Ukrainian: "Українська",
  Urdu: "اردو",
  Uzbek: "Oʻzbekcha",
  Vietnamese: "Tiếng Việt",
  Welsh: "Cymraeg",
  Yiddish: "ייִדיש",
  Yoruba: "Yorùbá",
};

const RTL_TEXT_LANGUAGES = new Set([
  "Uyghur",
  "Arabic",
  "Urdu",
  "Persian",
  "Pashto",
  "Sindhi",
  "Hebrew",
  "Yiddish",
]);

function normalizeAsrLanguage(value) {
  const language = String(value || "").trim();
  return ASR_LANGUAGES.includes(language) ? language : "Uyghur";
}

function isUyghurAsrLanguage(value) {
  return normalizeAsrLanguage(value) === "Uyghur";
}

function asrLanguageCode(value) {
  return ASR_LANGUAGE_CODES[normalizeAsrLanguage(value)] || "auto";
}

function languageDisplayName(value) {
  const language = normalizeAsrLanguage(value);
  return ASR_LANGUAGE_LABELS[language] || language;
}

function textDirectionForLanguage(language) {
  return RTL_TEXT_LANGUAGES.has(String(language || "").trim()) ? "rtl" : "ltr";
}

function setTextElementDirection(element, language) {
  if (!element) {
    return;
  }

  element.setAttribute("dir", textDirectionForLanguage(language));
}

function projectTextLanguage(project) {
  return normalizeAsrLanguage(
    project?.asr?.lang ||
      project?.language ||
      appSettings.asrLanguage,
  );
}

function projectDisplayTitle(project) {
  if (!project) {
    return "";
  }

  return project.title;
}

function applyTranscriptDirection(project = getActiveProject()) {
  const language = projectTextLanguage(project);
  const transcriptPane = confirmedEl?.closest(".transcript-pane");

  setTextElementDirection(transcriptPane, language);
  setTextElementDirection(confirmedEl, language);
  setTextElementDirection(unconfirmedEl, language);
}

function asrModelKey(settings = appSettings) {
  return isUyghurAsrLanguage(settings.asrLanguage) ? "fast" : "non-uyghur";
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");

    appSettings = {
      asrLanguage: normalizeAsrLanguage(saved.asrLanguage),
      maxUnconfirmedSec: clampNumber(
        saved.maxUnconfirmedSec,
        3,
        20,
        DEFAULT_MAX_UNCONFIRMED_SEC,
      ),
      displayLanguage: normalizeDisplayLanguage(saved.displayLanguage),
    };
  } catch (err) {
    console.error(err);
    appSettings = {
      asrLanguage: "Uyghur",
      maxUnconfirmedSec: DEFAULT_MAX_UNCONFIRMED_SEC,
      displayLanguage: DEFAULT_DISPLAY_LANGUAGE,
    };
  }

  pendingSettings = { ...appSettings };
}

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      ...appSettings,
      version: SETTINGS_VERSION,
    }),
  );
}

function renderAsrLanguages() {
  const selected = asrLanguageSelectEl.value || pendingSettings.asrLanguage || "Uyghur";

  asrLanguageSelectEl.innerHTML = "";
  for (const language of ASR_LANGUAGES) {
    const option = document.createElement("option");
    option.value = language;
    option.textContent = ASR_LANGUAGE_LABELS[language] || language;
    asrLanguageSelectEl.appendChild(option);
  }

  asrLanguageSelectEl.value = normalizeAsrLanguage(selected);
}

function renderDisplayLanguages() {
  const selected =
    displayLanguageSelectEl.value ||
    pendingSettings.displayLanguage ||
    DEFAULT_DISPLAY_LANGUAGE;

  displayLanguageSelectEl.innerHTML = "";
  for (const language of DISPLAY_LANGUAGE_OPTIONS) {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    displayLanguageSelectEl.appendChild(option);
  }

  displayLanguageSelectEl.value = normalizeDisplayLanguage(selected);
}

function renderSettings(settings = pendingSettings) {
  renderAsrLanguages();
  renderDisplayLanguages();
  const asrLanguage = normalizeAsrLanguage(settings.asrLanguage);
  asrLanguageSelectEl.value = asrLanguage;
  displayLanguageSelectEl.value = normalizeDisplayLanguage(settings.displayLanguage);
  maxUnconfirmedRangeEl.value = String(settings.maxUnconfirmedSec);
  maxUnconfirmedValueEl.textContent = `${settings.maxUnconfirmedSec}s`;
}

function openSettings() {
  if (settingsBtn.disabled || isServerBusy()) {
    return;
  }

  pendingSettings = { ...appSettings };
  renderSettings();
  settingsModalEl.hidden = false;
  asrLanguageSelectEl.focus();
}

function closeSettings() {
  settingsModalEl.hidden = true;
  settingsBtn.focus();
}

function openAbout() {
  aboutModalEl.hidden = false;
  aboutCloseBtn.focus();
}

function closeAbout() {
  aboutModalEl.hidden = true;
  aboutBtn.focus();
}

async function confirmSettings() {
  const previousModelKey = asrModelKey(appSettings);
  const previousLanguage = normalizeAsrLanguage(appSettings.asrLanguage);
  const previousDisplayLanguage = normalizeDisplayLanguage(appSettings.displayLanguage);

  appSettings = {
    asrLanguage: normalizeAsrLanguage(pendingSettings.asrLanguage),
    maxUnconfirmedSec: clampNumber(
      pendingSettings.maxUnconfirmedSec,
      3,
      20,
      DEFAULT_MAX_UNCONFIRMED_SEC,
    ),
    displayLanguage: normalizeDisplayLanguage(pendingSettings.displayLanguage),
  };
  pendingSettings = { ...appSettings };
  const displayLanguageChanged =
    previousDisplayLanguage !== normalizeDisplayLanguage(appSettings.displayLanguage);

  if (displayLanguageChanged) {
    setActiveLocale(appSettings.displayLanguage);
  }

  saveSettings();
  applyLocale();
  closeSettings();
  setStatus("settings.saved");
  renderText();
  renderResultPane(getActiveProject(), { preserveScroll: true });

  const modelChanged = previousModelKey !== asrModelKey(appSettings);
  const languageChanged = previousLanguage !== normalizeAsrLanguage(appSettings.asrLanguage);

  if (
    (modelChanged || languageChanged) &&
    !recording &&
    !fileStreaming &&
    !currentRunMode
  ) {
    try {
      if (modelChanged) {
        setStatus("settings.switchingModel");
        setServerIndicator("working");
        resetAsrWebSocket();
        await ensureServerProcess(true);
        connectWebSocket();
      } else {
        sendServerCommand("setModel", {
          modelMode: asrModelKey(appSettings),
          asrLanguage: appSettings.asrLanguage,
          asrLanguageCode: asrLanguageCode(appSettings.asrLanguage),
          maxUnconfirmedSec: appSettings.maxUnconfirmedSec,
        });
      }
    } catch (err) {
      console.error(err);
    }
  }
}

function openMediaDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_DB_NAME, MEDIA_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        db.createObjectStore(MEDIA_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function mediaStoreTransaction(db, mode) {
  return db.transaction(MEDIA_STORE_NAME, mode).objectStore(MEDIA_STORE_NAME);
}

async function putStoredMedia(record) {
  const db = await openMediaDb();

  try {
    await new Promise((resolve, reject) => {
      const request = mediaStoreTransaction(db, "readwrite").put(record);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function getStoredMedia(id) {
  if (!id) {
    return null;
  }

  const db = await openMediaDb();

  try {
    return await new Promise((resolve, reject) => {
      const request = mediaStoreTransaction(db, "readonly").get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function deleteStoredMedia(id) {
  if (!id) {
    return;
  }

  const db = await openMediaDb();

  try {
    await new Promise((resolve, reject) => {
      const request = mediaStoreTransaction(db, "readwrite").delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function clearStoredMedia() {
  const db = await openMediaDb();

  try {
    await new Promise((resolve, reject) => {
      const request = mediaStoreTransaction(db, "readwrite").clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

function loadProjects() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROJECTS_KEY) || "[]");
    projects = Array.isArray(saved)
      ? saved.filter((project) =>
          !project?.sourceType || ASR_PROJECT_SOURCE_TYPES.has(project.sourceType),
        )
      : [];
  } catch (err) {
    console.error(err);
    projects = [];
  }

  activeProjectId = projects[0]?.id || null;

  const savedViewMode = localStorage.getItem(RESULT_VIEW_KEY);
  resultViewMode = savedViewMode === "whole" ? "whole" : "timeline";
}

function saveProjects() {
  if (projects.length === 0) {
    localStorage.removeItem(PROJECTS_KEY);
    return;
  }

  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

function visibleProjectsForMode() {
  return projects;
}

function ensureActiveProjectForMode() {
  const activeProject = projects.find((project) => project.id === activeProjectId);

  if (activeProject) {
    return;
  }

  activeProjectId = visibleProjectsForMode()[0]?.id || null;
}

async function saveProjectDataFiles(project) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!project || !tauriInvoke) {
    return null;
  }

  const folderPath = await tauriInvoke("save_project_data_files", {
    projectId: project.id,
    projectTitle: project.title || project.sourceName || "project",
    transcript: normalizeTranscriptText(project.transcript || ""),
    segmentsJson: JSON.stringify(project.segments || [], null, 2),
    projectJson: JSON.stringify(project, null, 2),
  });

  project.projectFolderPath = folderPath;
  project.updatedAt = Date.now();
  saveProjects();

  return folderPath;
}

function saveProjectDataFilesSoon(project) {
  void saveProjectDataFiles(project).catch((err) => console.error(err));
}

async function deleteProjectDataFiles(project) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!project || !tauriInvoke) {
    return;
  }

  await tauriInvoke("delete_project_data_files", {
    projectId: project.id,
    projectTitle: project.title || project.sourceName || "project",
    projectFolderPath: project.projectFolderPath || null,
  });
}

async function clearProjectDataFiles() {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!tauriInvoke) {
    return;
  }

  await tauriInvoke("clear_project_data_files");
}

function updateClearButtonState() {
  const visibleProjects = visibleProjectsForMode();

  clearProjectsBtn.disabled =
    isAsrBusy() ||
    (visibleProjects.length === 0 &&
      !confirmedText &&
      !unconfirmedText);
  updateSettingsButtonState();
  updateAsrBatchProgress();
}

function getProject(projectId) {
  return projects.find((project) => project.id === projectId) || null;
}

function getActiveProject() {
  return getProject(activeProjectId);
}

function getCurrentProject() {
  return getProject(currentProjectId);
}

function asrProjectConfirmedFraction(project) {
  if (!project) {
    return 0;
  }

  const durationMs = Number(project.projectAudioInfo?.durationMs || project.durationMs || 0);

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }

  const confirmedEndMs = lastProjectSegmentEndMs(project);

  return Math.min(1, Math.max(0, confirmedEndMs / durationMs));
}

function currentAsrBatchConfirmedFraction() {
  if (!asrBatchRunning || !currentProjectId) {
    return 0;
  }

  const project = getProject(currentProjectId);

  if (!project || ["done", "error", "cancelled"].includes(project.status)) {
    return 0;
  }

  return asrProjectConfirmedFraction(project);
}

function microphoneProjectTitlePrefixes() {
  return Array.from(
    new Set(
      Object.values(LOCALES)
        .map((locale) => localeTextMap(locale)["projects.microphoneTitle"])
        .filter(Boolean)
        .concat("مىكروفون تونۇشى"),
    ),
  );
}

function nextMicrophoneProjectTitle() {
  let highestNumber = 0;
  let legacyUntitledCount = 0;
  const prefixes = microphoneProjectTitlePrefixes();

  for (const project of projects) {
    const title = String(project.title || "");
    if (
      project.sourceType !== "microphone" &&
      project.sourceName !== "microphone" &&
      !prefixes.some((prefix) => title.startsWith(prefix))
    ) {
      continue;
    }

    const prefix =
      prefixes.find((item) => title.startsWith(item)) ||
      t("projects.microphoneTitle");
    const suffix = title
      .slice(prefix.length)
      .trim();

    if (!suffix) {
      legacyUntitledCount++;
      continue;
    }

    const number = Number(suffix);

    if (Number.isInteger(number) && number > highestNumber) {
      highestNumber = number;
    }
  }

  const next = Math.max(highestNumber, legacyUntitledCount) + 1;

  return `${t("projects.microphoneTitle")}${next}`;
}

function createProject({
  title,
  sourceType,
  sourceName,
  durationMs = null,
  language = null,
}) {
  const now = Date.now();
  const project = {
    id: makeId(),
    title,
    sourceType,
    sourceName,
    status: "running",
    createdAt: now,
    updatedAt: now,
    durationMs,
    language,
    transcript: "",
    segments: [],
  };

  projects.unshift(project);
  activeProjectId = project.id;
  currentProjectId = project.id;
  pendingConfirmedSkips = [];
  openProjectMenuId = null;

  saveProjects();
  renderProjects();
  renderActiveProject();

  return project;
}

function timestampForFileName(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function sanitizeDownloadName(fileName, fallback) {
  const cleaned = String(fileName || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();

  return cleaned || fallback;
}

function makeMediaFileName(project, mediaRecord = null) {
  const storedName = mediaRecord?.name || project.mediaName || project.sourceName;
  const fallback = `${timestampForFileName(project.createdAt)}.media`;

  return sanitizeDownloadName(storedName, fallback);
}

function attachNativeMediaPath(project, mediaFile) {
  if (!project || !mediaFile?.path) {
    return;
  }

  project.mediaPath = mediaFile.path;
  project.mediaName = sanitizeDownloadName(mediaFile.name, project.sourceName || "media");
  project.mediaType = mediaTypeFromFileName(project.mediaName);
  project.updatedAt = Date.now();
  saveProjects();
  renderProjects();
}

async function blobToBytes(blob) {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

async function attachMediaToProject(project, blob, name, type) {
  if (!project || !blob) {
    return false;
  }

  const mediaId = project.id;
  const storedAt = Date.now();
  const mediaName = sanitizeDownloadName(
    name,
    `${timestampForFileName(project.createdAt)}.media`,
  );
  const mediaType = type || blob.type || "application/octet-stream";

  await putStoredMedia({
    id: mediaId,
    blob,
    name: mediaName,
    type: mediaType,
    sourceType: project.sourceType,
    storedAt,
    size: blob.size,
  });

  project.mediaId = mediaId;
  project.mediaName = mediaName;
  project.mediaType = mediaType;
  project.mediaStoredAt = storedAt;
  project.mediaSize = blob.size;
  project.updatedAt = Date.now();
  saveProjects();
  renderProjects();

  return true;
}

async function saveProjectAudioWav(project, wavBlob) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!project || !wavBlob || !tauriInvoke) {
    return null;
  }

  const saved = await tauriInvoke("save_project_audio_wav", {
    projectId: project.id,
    projectTitle: project.title || project.sourceName || "project",
    bytes: await blobToBytes(wavBlob),
  });

  project.projectFolderPath = saved.folderPath;
  project.projectAudioPath = saved.audioPath;
  project.updatedAt = Date.now();
  saveProjects();
  renderProjects();

  saveProjectDataFilesSoon(project);

  return saved;
}

function attachProjectAudioFile(project, savedAudio) {
  if (!project || !savedAudio?.audioPath) {
    return;
  }

  project.projectFolderPath = savedAudio.folderPath;
  project.projectAudioPath = savedAudio.audioPath;
  project.mediaPath = savedAudio.audioPath;
  project.mediaName = "audio.wav";
  project.mediaType = "audio/wav";
  project.mediaSize = Number(savedAudio.dataBytes || 0) + 44;

  if (Number.isFinite(Number(savedAudio.durationMs))) {
    project.durationMs = Number(savedAudio.durationMs);
  }

  project.projectAudioInfo = {
    sampleRate: Number(savedAudio.sampleRate || 0) || TARGET_SAMPLE_RATE,
    channels: Number(savedAudio.channels || 0) || 1,
    bitsPerSample: Number(savedAudio.bitsPerSample || 0) || 16,
    durationMs: Number(savedAudio.durationMs || 0) || project.durationMs || null,
    dataBytes: Number(savedAudio.dataBytes || 0) || null,
  };
  project.asrBatch = {
    ...(project.asrBatch || {}),
    audioPath: savedAudio.audioPath,
    preparedAt: Date.now(),
  };
  project.updatedAt = Date.now();
  saveProjects();
  renderProjects();
  saveProjectDataFilesSoon(project);
}

function setProjectStatus(projectId, status) {
  const project = getProject(projectId);

  if (!project) {
    return;
  }

  project.status = status;
  project.updatedAt = Date.now();
  saveProjects();
  renderProjects();
  renderActiveProject();
}

function isAsrFileProject(project) {
  return project && project.sourceType !== "microphone";
}

function isAsrProjectResumable(project) {
  if (!isAsrFileProject(project) || project.status === "done") {
    return false;
  }

  return Boolean(
    project.projectAudioPath ||
      project.asrBatch?.audioPath ||
      project.asrBatch?.sourcePath ||
      project.mediaPath ||
      project.mediaId,
  );
}

function resumableAsrProjects() {
  return projects.filter(isAsrProjectResumable);
}

function markStoppedAsrBatchProjects(batchProjects) {
  let changed = false;

  for (const project of batchProjects) {
    if (
      !isAsrFileProject(project) ||
      project.status === "done" ||
      project.status === "error"
    ) {
      continue;
    }

    if (project.status !== "cancelled") {
      project.status = "cancelled";
      project.updatedAt = Date.now();
      changed = true;
      saveProjectDataFilesSoon(project);
    }
  }

  if (changed) {
    saveProjects();
  }
}

function markQueuedAsrBatchProjects(batchProjects) {
  let changed = false;

  for (const project of batchProjects) {
    if (!isAsrFileProject(project) || project.status === "done") {
      continue;
    }

    if (project.status !== "queued") {
      project.status = "queued";
      project.updatedAt = Date.now();
      changed = true;
      saveProjectDataFilesSoon(project);
    }
  }

  if (changed) {
    saveProjects();
    renderProjects();
  }
}

function selectProject(projectId) {
  activeProjectId = projectId;
  openProjectMenuId = null;
  renderProjects();
  renderActiveProject();
}

function updateAsrBatchProgress(label = "") {
  if (
    !resumeAllBtn ||
    !asrBatchProgressEl ||
    !asrBatchProgressLabelEl ||
    !asrBatchProgressValueEl ||
    !asrBatchProgressBarEl
  ) {
    return;
  }

  const resumable = resumableAsrProjects();
  const showProgress = asrBatchRunning || resumable.length > 0;
  const disabled = asrBatchRunning || recording || fileStreaming || Boolean(currentRunMode);

  resumeAllBtn.hidden = resumable.length === 0;
  resumeAllBtn.disabled = disabled || resumable.length === 0;
  asrBatchProgressEl.hidden = !showProgress;

  if (!showProgress) {
    asrBatchProgressBarEl.style.width = "0%";
    asrBatchProgressValueEl.textContent = "0/0";
    return;
  }

  const total = asrBatchRunning ? Math.max(asrBatchTotal, 1) : Math.max(resumable.length, 1);
  const confirmedFraction = currentAsrBatchConfirmedFraction();
  const doneUnits = asrBatchRunning
    ? Math.min(total, Math.max(0, asrBatchDone + confirmedFraction))
    : 0;
  const percent = Math.round((doneUnits / total) * 100);

  asrBatchProgressLabelEl.textContent =
    label
      ? (hasTranslationKey(label) ? t(label) : label)
      : t(asrBatchRunning ? "projects.batchProcessing" : "projects.batchWaiting");
  asrBatchProgressValueEl.textContent = asrBatchRunning
    ? `${percent}%`
    : `0/${total}`;
  asrBatchProgressBarEl.style.width = `${percent}%`;
}

function positionProjectMenu(menu, anchorButton) {
  const margin = 8;
  const gap = 6;
  const anchorRect = anchorButton.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const maxLeft = window.innerWidth - menuRect.width - margin;
  const belowTop = anchorRect.bottom + gap;
  const aboveTop = anchorRect.top - menuRect.height - gap;
  const opensUp =
    belowTop + menuRect.height > window.innerHeight - margin &&
    aboveTop >= margin;
  const top = opensUp
    ? aboveTop
    : Math.min(belowTop, window.innerHeight - menuRect.height - margin);

  menu.style.left = `${Math.max(margin, Math.min(anchorRect.left, maxLeft))}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
  menu.style.visibility = "visible";
}

function renderProjects() {
  sidePanelTitleEl.textContent = t("projects.title");
  ensureActiveProjectForMode();
  projectListEl.innerHTML = "";
  updateClearButtonState();
  updateAsrBatchProgress();

  const visibleProjects = visibleProjectsForMode();

  if (visibleProjects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "project-empty";
    empty.textContent = t("projects.empty");
    projectListEl.appendChild(empty);
    return;
  }

  for (const project of visibleProjects) {
    const item = document.createElement("div");
    item.className =
      "project-item" + (project.id === activeProjectId ? " active" : "");
    item.classList.add(`status-${project.status || "done"}`);

    if (project.id === openProjectMenuId) {
      item.classList.add("menu-open");
    }

    if (asrBatchRunning && project.status === "queued") {
      item.classList.add("batch-waiting");
    }

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "project-select";
    selectButton.addEventListener("click", () => selectProject(project.id));

    const title = document.createElement("span");
    title.className = "project-title";
    title.textContent = projectDisplayTitle(project);

    const meta = document.createElement("span");
    meta.className = "project-meta";

    const status = document.createElement("span");
    status.textContent = projectStatusText(project.status);

    const count = document.createElement("span");
    const projectError = project.status === "error" ? String(project.errorMessage || "") : "";
    const language = projectTextLanguage(project);
    count.textContent = projectError
      ? projectError
      : languageDisplayName(language);
    if (projectError) {
      count.title = projectError;
    } else {
      count.className = "project-language";
      count.title = languageDisplayName(language);
      setTextElementDirection(count, language);
    }

    meta.append(status, count);
    selectButton.append(title, meta);

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "project-menu-button";
    menuButton.textContent = "...";
    menuButton.setAttribute("aria-label", t("projects.operations"));
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openProjectMenuId =
        openProjectMenuId === project.id ? null : project.id;
      renderProjects();
    });

    item.append(selectButton, menuButton);

    if (project.id === openProjectMenuId) {
      const menu = document.createElement("div");
      menu.className = "project-menu";
      menu.style.visibility = "hidden";
      menu.addEventListener("click", (event) => event.stopPropagation());

      const openLocationButton = document.createElement("button");
      openLocationButton.type = "button";
      openLocationButton.className = "project-menu-item";
      openLocationButton.textContent = t("projects.openLocation");
      openLocationButton.addEventListener("click", () => openProjectLocation(project.id));

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "project-menu-item danger";
      deleteButton.textContent = t("projects.delete");
      deleteButton.addEventListener("click", () => deleteProject(project.id));

      if (isAsrProjectResumable(project)) {
        const resumeButton = document.createElement("button");
        resumeButton.type = "button";
        resumeButton.className = "project-menu-item";
        resumeButton.textContent = t("projects.resume");
        resumeButton.disabled = asrBatchRunning || recording || fileStreaming || Boolean(currentRunMode);
        resumeButton.addEventListener("click", () => {
          void resumeAsrProject(project.id);
        });
        menu.appendChild(resumeButton);
      }

      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "project-menu-item";
      exportButton.textContent = t("projects.exportSrt");
      exportButton.addEventListener("click", () => exportProjectSrt(project.id));
      menu.appendChild(exportButton);

      menu.append(openLocationButton, deleteButton);
      item.appendChild(menu);
      requestAnimationFrame(() => positionProjectMenu(menu, menuButton));
    }

    projectListEl.appendChild(item);
  }
}

function projectStatusText(status) {
  if (status === "queued") {
    return t("projects.status.queued");
  }

  if (status === "preparing") {
    return t("projects.status.preparing");
  }

  if (status === "running") {
    return t("projects.status.running");
  }

  if (status === "processing") {
    return t("projects.status.processing");
  }

  if (status === "cancelled") {
    return t("projects.status.cancelled");
  }

  if (status === "error") {
    return t("projects.status.error");
  }

  return t("projects.status.done");
}

function renderActiveProject() {
  const project = getActiveProject();

  if (!project) {
    activeProjectTitleEl.textContent = t("projects.newTranscript");
    confirmedText = "";
    unconfirmedText = "";
    renderText();
    renderResultPane(null);

    return;
  }

  activeProjectTitleEl.textContent =
    `${project.title} · ${formatDate(project.createdAt)}`;
  confirmedText = normalizeTranscriptText(project.transcript);
  unconfirmedText = project.id === currentProjectId ? unconfirmedText : "";
  renderText();
  renderResultPane(project);
}

function setResultViewMode(mode) {
  resultViewMode = mode === "whole" ? "whole" : "timeline";
  localStorage.setItem(RESULT_VIEW_KEY, resultViewMode);
  renderResultPane(getActiveProject());
}

function renderResultPane(project, options = {}) {
  const previousScrollTop = options.preserveScroll ? timelineEl.scrollTop : 0;
  const segments = project?.segments || [];
  const language = projectTextLanguage(project);

  timelineEl.innerHTML = "";
  timelineEl.dataset.textDir = textDirectionForLanguage(language);
  segmentCountEl.textContent = languageDisplayName(language);
  segmentCountEl.title = languageDisplayName(language);
  setTextElementDirection(segmentCountEl, language);
  wholeViewBtn.classList.toggle("active", resultViewMode === "whole");
  timelineViewBtn.classList.toggle("active", resultViewMode === "timeline");
  timelineEl.className =
    "result-content " +
    (resultViewMode === "whole" ? "whole-mode" : "timeline-list");

  if (resultViewMode === "whole") {
    resultPaneTitleEl.textContent = t("timeline.wholeTitle");
    renderWholeTranscript(project);
    if (options.preserveScroll) {
      timelineEl.scrollTop = previousScrollTop;
    }
    return;
  }

  resultPaneTitleEl.textContent = t("timeline.title");
  renderTimelineSegments(project);

  if (options.preserveScroll) {
    timelineEl.scrollTop = previousScrollTop;
  }
}

function renderWholeTranscript(project) {
  const text = normalizeTranscriptText(project?.transcript || confirmedText);
  const language = projectTextLanguage(project);

  if (!text) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.textContent = t("timeline.emptyText");
    timelineEl.appendChild(empty);
    return;
  }

  const body = document.createElement("div");
  body.className = "whole-transcript";
  setTextElementDirection(body, language);
  body.textContent = text;
  timelineEl.appendChild(body);
}

function renderTimelineSegments(project) {
  const segments = project?.segments || [];
  const language = projectTextLanguage(project);

  if (segments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.textContent = t("timeline.emptySegments");
    timelineEl.appendChild(empty);
    return;
  }

  for (const segment of segments) {
    const item = document.createElement("article");
    item.className = "segment-card";
    const playbackKey = `${project.id}:${segment.id}`;

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className =
      "segment-play-button" +
      (playbackKey === activePlaybackKey ? " playing" : "");
    playButton.disabled = !project.mediaId && !project.mediaPath;
    playButton.setAttribute("aria-label", t("media.play"));
    playButton.title = t("media.play");
    playButton.addEventListener("click", () => playSegment(project.id, segment));

    const time = document.createElement("div");
    time.className = "segment-time";
    time.textContent =
      `${formatDuration(segment.startMs)} - ${formatDuration(segment.endMs)}`;

    const text = document.createElement("div");
    text.className = "segment-text";
    setTextElementDirection(text, language);
    text.textContent = segment.text;

    item.append(playButton, time, text);

    timelineEl.appendChild(item);
  }

}

function appendProjectSegment(segment) {
  const project = getCurrentProject();

  if (!project) {
    return;
  }

  const cleanSegment = {
    ...segment,
    text: normalizeTranscriptText(segment.text).trim(),
  };

  if (!cleanSegment.text || !hasMeaningfulTranscriptText(cleanSegment.text)) {
    return;
  }

  project.segments.push(cleanSegment);
  project.transcript = appendTranscriptText(
    project.transcript,
    cleanSegment.text,
  );
  project.updatedAt = Date.now();

  if (cleanSegment.endMs != null) {
    project.durationMs = Math.max(project.durationMs || 0, cleanSegment.endMs);
  }

  pendingConfirmedSkips.push(cleanSegment.text);
  saveProjects();

  if (activeProjectId === project.id) {
    confirmedText = normalizeTranscriptText(project.transcript);
    unconfirmedText = "";
    renderText();
    renderResultPane(project, { preserveScroll: true });
  }

  saveProjectDataFilesSoon(project);
  renderProjects();

  if (asrBatchRunning && project.id === currentProjectId) {
    updateAsrBatchProgress("projects.batchRecognizing");
  }
}

function appendFallbackConfirmed(text) {
  const project = getCurrentProject();

  if (!project) {
    confirmedText = appendTranscriptText(confirmedText, text);
    unconfirmedText = "";
    renderText();
    return;
  }

  const lastEnd =
    project.segments[project.segments.length - 1]?.endMs || 0;

  appendProjectSegment({
    id: makeId(),
    text: normalizeTranscriptText(text),
    startMs: lastEnd,
    endMs: lastEnd + 1000,
  });
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await ensureServerProcess();
      connectWebSocket();
    } catch (err) {
      console.error(err);
    }
  }, 1000);
}

function resetAsrWebSocket() {
  activeServerModelMode = null;
  reportedServerModelMode = null;

  if (!ws) {
    return;
  }

  ws.onclose = null;
  ws.onerror = null;
  ws.onmessage = null;
  ws.onopen = null;

  try {
    ws.close();
  } catch (err) {
    console.error(err);
  }

  ws = null;
}

function failActiveRun(statusText, indicatorState) {
  const projectId = currentProjectId;
  const wasFileRun = currentRunMode === "file" || fileStreaming;

  if (asrBatchRunning) {
    asrBatchStopRequested = true;
  }

  recording = false;
  fileStreaming = false;
  currentRunMode = null;
  currentProjectId = null;
  currentRunOffsetMs = 0;
  fileStreamToken++;

  if (projectId) {
    setProjectStatus(projectId, "cancelled");
  }

  finishCurrentFileRun(projectId, "cancelled");

  void stopMicrophoneRecorder(false);
  void closeAudioResources();
  setBusyState(false);
  setStatus(
    wasFileRun && statusValueMatchesKey(statusText, "status.modelError")
      ? "file.recognitionError"
      : statusText,
  );
  setServerIndicator(indicatorState);
}

function beginCurrentFileRun(projectId) {
  if (currentFileRunWaiter) {
    currentFileRunWaiter.resolve({ projectId, status: "cancelled" });
  }

  return new Promise((resolve) => {
    currentFileRunWaiter = { projectId, resolve };
  });
}

function finishCurrentFileRun(projectId, status) {
  if (!currentFileRunWaiter) {
    return;
  }

  if (projectId && currentFileRunWaiter.projectId !== projectId) {
    return;
  }

  const waiter = currentFileRunWaiter;
  currentFileRunWaiter = null;
  waiter.resolve({ projectId: waiter.projectId, status });
}

function setDropZoneActive(target, active) {
  filePickerEl?.classList.toggle("is-drag-over", target === "asr" && active);
}

function clearDropZoneStates() {
  setDropZoneActive("asr", false);
}

function viewportPointFromDropPosition(position) {
  if (!position) {
    return null;
  }

  const x = Number(position.x ?? position[0]);
  const y = Number(position.y ?? position[1]);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

function elementContainsPoint(element, point) {
  if (!element || !point) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function dropTargetForPosition(position) {
  const point = viewportPointFromDropPosition(position);

  if (elementContainsPoint(filePickerEl, point)) {
    return "asr";
  }

  if (elementContainsPoint(asrPanelEl, point)) {
    return "asr";
  }

  if (!point) {
    return "asr";
  }

  return null;
}

function droppedFiles(event) {
  return Array.from(event.dataTransfer?.files || []).filter((file) => file && file.name);
}

async function handleAsrDroppedFiles(files) {
  if (!files.length) {
    return;
  }

  const nativeFiles = files
    .filter((file) => file.path)
    .map((file) => nativeMediaFileFromPath(file.path, file.name));

  if (nativeFiles.length > 0) {
    await selectAsrNativeMediaPaths(nativeFiles);
    return;
  }

  selectAsrDroppedMediaFiles(files);
}

async function handleDroppedNativePaths(target, paths) {
  const cleanPaths = paths.filter(Boolean);

  if (cleanPaths.length === 0) {
    return;
  }

  if (target === "asr") {
    await selectAsrNativeMediaPaths(
      cleanPaths.map((path) => nativeMediaFileFromPath(path, fileNameFromPath(path))),
    );
  }
}

function installDomDropZone(element, target) {
  if (!element) {
    return;
  }

  const onDragOver = (event) => {
    if (!event.dataTransfer) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropZoneActive(target, true);
  };

  element.addEventListener("dragenter", onDragOver);
  element.addEventListener("dragover", onDragOver);
  element.addEventListener("dragleave", (event) => {
    if (!element.contains(event.relatedTarget)) {
      setDropZoneActive(target, false);
    }
  });
  element.addEventListener("drop", (event) => {
    event.preventDefault();
    setDropZoneActive(target, false);

    const files = droppedFiles(event);
    if (target === "asr") {
      void handleAsrDroppedFiles(files);
    }
  });
}

async function installNativeDragDrop() {
  const getCurrentWebview = window.__TAURI__?.webview?.getCurrentWebview;

  if (!getCurrentWebview) {
    return;
  }

  try {
    const webview = getCurrentWebview();

    if (!webview?.onDragDropEvent) {
      return;
    }

    await webview.onDragDropEvent((event) => {
      const payload = event?.payload || {};
      const target = dropTargetForPosition(payload.position);

      if (payload.type === "over") {
        clearDropZoneStates();
        if (target) {
          setDropZoneActive(target, true);
        }
        return;
      }

      clearDropZoneStates();

      if (payload.type !== "drop" || !target) {
        return;
      }

      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      void handleDroppedNativePaths(target, paths);
    });
  } catch (err) {
    console.error(err);
  }
}

async function ensureServerProcess(forceRestart = false) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const requestedLanguage = normalizeAsrLanguage(appSettings.asrLanguage);
  const requestedModelKey = asrModelKey(appSettings);

  if (!tauriInvoke) {
    return;
  }

  if (
    ensureServerPromise &&
    (forceRestart || ensureServerPromiseMode !== requestedModelKey)
  ) {
    await ensureServerPromise.catch((err) => {
      console.error(err);
    });
  }

  if (!ensureServerPromise) {
    ensureServerPromiseMode = requestedModelKey;
    ensureServerPromise = tauriInvoke("ensure_asr_server", {
      modelMode: requestedModelKey,
      asrLanguage: requestedLanguage,
      forceRestart,
    })
      .catch((err) => {
        console.error(err);
        setStatus(serverStartupStatusText(err));
        setServerIndicator("offline");
        throw err;
      })
      .finally(() => {
        ensureServerPromise = null;
        ensureServerPromiseMode = null;
      });
  }

  const serverModelMode = await ensureServerPromise;
  activeServerModelMode = String(serverModelMode || requestedModelKey);
}

function connectWebSocket() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  reportedServerModelMode = null;
  ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    hasConnectedOnce = true;
    setStatus("connected");
    setServerIndicator("available");
  };

  ws.onclose = () => {
    if (recording || fileStreaming || currentRunMode) {
      failActiveRun("status.modelDisconnected", "offline");
    } else if (hasConnectedOnce) {
      setStatus("status.modelStopped");
      setServerIndicator("offline");
    } else {
      setStatus("status.modelStarting");
      setServerIndicator("working");
    }

    scheduleReconnect();
  };

  ws.onerror = () => {
    if (hasConnectedOnce) {
      setStatus("status.modelError");
      setServerIndicator("offline");
    } else {
      setStatus("status.modelStarting");
      setServerIndicator("working");
    }
  };

  ws.onmessage = (event) => {
    let msg;

    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      console.error("Bad JSON:", event.data);
      return;
    }

    if (msg.type === "status") {
      if (msg.text === "model error") {
        failActiveRun(msg.text, "available");
        return;
      }

      if (msg.text === "model changed(مودىل ئالماشتۇرۇلدى)") {
        modelChangedStatusUntil = Date.now() + 1600;
        setStatus(msg.text);
        setServerIndicator("available");
        return;
      }

      if (
        Date.now() < modelChangedStatusUntil &&
        (msg.text === "recording" || msg.text === "connected")
      ) {
        setServerIndicatorFromStatus(msg.text);
        return;
      }

      setStatus(
        msg.text === "recording" && currentRunMode === "file"
          ? "file.loading"
          : msg.text,
      );
      setServerIndicatorFromStatus(msg.text);

      if (msg.text === "recording") {
        setProjectStatus(currentProjectId, "running");
        if (asrBatchRunning) {
          updateAsrBatchProgress("projects.batchRecognizing");
        }
      }

      if (msg.text === "processing remaining audio") {
        setProjectStatus(currentProjectId, "processing");
        if (asrBatchRunning) {
          updateAsrBatchProgress("projects.batchReviewing");
        }
      }

      if (msg.text === "stopped") {
        const projectId = currentProjectId;
        recording = false;
        fileStreaming = false;
        currentRunMode = null;
        currentRunOffsetMs = 0;
        setProjectStatus(projectId, "done");
        currentProjectId = null;
        setBusyState(false);
        finishCurrentFileRun(projectId, "done");
      }

      if (msg.text === "cancelled") {
        const projectId = currentProjectId;
        recording = false;
        fileStreaming = false;
        currentRunMode = null;
        currentRunOffsetMs = 0;
        setProjectStatus(projectId, "cancelled");
        currentProjectId = null;
        setBusyState(false);
        finishCurrentFileRun(projectId, "cancelled");
      }
    }

    if (msg.type === "backend") {
      setBackendLabel(normalizeTranscriptText(msg.text).trim());
    }

    if (msg.type === "model") {
      activeServerModelMode = String(msg.text || "");
      reportedServerModelMode = activeServerModelMode;
    }

    if (msg.type === "extractor") {
      console.info("Media extractor:", msg.text);
    }

    if (msg.type === "reset") {
      if (!activeProjectId || activeProjectId === currentProjectId) {
        const project = getCurrentProject();
        confirmedText =
          currentRunOffsetMs > 0 && project
            ? normalizeTranscriptText(project.transcript)
            : "";
        unconfirmedText = "";
        renderText();
      }
    }

    if (msg.type === "segment") {
      const startMs = Number(msg.start_ms || 0) + currentRunOffsetMs;
      const endMs = Number(msg.end_ms || 0) + currentRunOffsetMs;

      appendProjectSegment({
        id: makeId(),
        text: normalizeTranscriptText(msg.text).trim(),
        startMs,
        endMs,
      });
    }

    if (msg.type === "confirmed") {
      if (
        pendingConfirmedSkips[0] ===
        normalizeTranscriptText(msg.text).trim()
      ) {
        pendingConfirmedSkips.shift();
        return;
      }

      appendFallbackConfirmed(normalizeTranscriptText(msg.text).trim());
    }

    if (msg.type === "unconfirmed") {
      unconfirmedText =
        activeProjectId === currentProjectId
          ? normalizeTranscriptText(msg.text)
          : unconfirmedText;
      renderText();
    }
  };
}

function waitForServerModelReport(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (reportedServerModelMode !== null) {
      resolve(reportedServerModelMode);
      return;
    }

    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (
        reportedServerModelMode !== null ||
        Date.now() - startedAt > timeoutMs
      ) {
        clearInterval(timer);
        resolve(reportedServerModelMode);
      }
    }, 50);
  });
}

function waitForWebSocketOpen() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt > WS_CONNECT_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error("ASR model connection timed out"));
      }
    }, 50);
  });
}

async function ensureWebSocket() {
  await ensureServerProcess();

  if (!(ws && ws.readyState === WebSocket.OPEN)) {
    connectWebSocket();
    await waitForWebSocketOpen();
  }

  const reportedMode = await waitForServerModelReport();
  const expectedMode = asrModelKey(appSettings);

  if (reportedMode && reportedMode !== expectedMode) {
    setStatus("settings.switchingModel");
    setServerIndicator("working");
    resetAsrWebSocket();
    await ensureServerProcess(true);
    connectWebSocket();
    await waitForWebSocketOpen();

    const restartedMode = await waitForServerModelReport();
    if (restartedMode && restartedMode !== expectedMode) {
      throw new Error(
        `ASR server loaded ${restartedMode}, expected ${expectedMode}`,
      );
    }
  }
}

function resetTranscript() {
  confirmedText = "";
  unconfirmedText = "";
  renderText();
}

async function startServerSession() {
  await ensureWebSocket();
  resetTranscript();
  setBusyState(true);
  setServerIndicator("working");
  sendServerCommand("start", {
    modelMode: asrModelKey(appSettings),
    asrLanguage: normalizeAsrLanguage(appSettings.asrLanguage),
    asrLanguageCode: asrLanguageCode(appSettings.asrLanguage),
    maxUnconfirmedSec: appSettings.maxUnconfirmedSec,
  });
}

function cancelFileStream() {
  fileStreaming = false;
  fileStreamToken++;

  if (fileMediaCleanup) {
    fileMediaCleanup();
    fileMediaCleanup = null;
  }
}

async function closeAudioResources() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
}

async function cancelActiveRun() {
  const hadActiveRun = recording || fileStreaming || currentRunMode;

  recording = false;
  cancelFileStream();
  await stopMicrophoneRecorder(false);
  await closeAudioResources();

  if (hadActiveRun && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "cancel" }));
  }
}

async function clearAllData() {
  const projectsToClear = visibleProjectsForMode();
  if (isAsrBusy()) {
    return;
  } else if (
    projectsToClear.length === 0 &&
    !currentRunMode &&
    !confirmedText &&
    !unconfirmedText
  ) {
    return;
  }

  asrBatchStopRequested = true;
  await cancelActiveRun();

  stopSegmentPlayback({ render: false });

  for (const project of projectsToClear) {
    await deleteStoredMedia(project.mediaId).catch((err) => console.error(err));
    await deleteProjectDataFiles(project).catch((err) => console.error(err));
  }

  const clearedIds = new Set(projectsToClear.map((project) => project.id));
  projects = projects.filter((project) => !clearedIds.has(project.id));
  ensureActiveProjectForMode();
  currentProjectId = null;
  currentRunMode = null;
  pendingConfirmedSkips = [];
  openProjectMenuId = null;
  saveProjects();

  resetTranscript();

  renderProjects();
  renderActiveProject();
  setBusyState(false);
  setStatus("projects.cleared");
  setServerIndicator(ws?.readyState === WebSocket.OPEN ? "available" : "offline");
}

async function deleteProject(projectId) {
  const project = getProject(projectId);

  if (!project) {
    return;
  }

  if (projectId === currentProjectId) {
    await cancelActiveRun();
    currentProjectId = null;
    currentRunMode = null;
    setBusyState(false);
  }

  if (activePlaybackKey?.startsWith(`${projectId}:`)) {
    stopSegmentPlayback({ render: false });
  }

  await deleteStoredMedia(project.mediaId).catch((err) => console.error(err));
  await deleteProjectDataFiles(project).catch((err) => console.error(err));

  projects = projects.filter((item) => item.id !== projectId);

  if (activeProjectId === projectId) {
    ensureActiveProjectForMode();
  }

  openProjectMenuId = null;
  pendingConfirmedSkips = [];
  saveProjects();
  renderProjects();
  renderActiveProject();
  setStatus("projects.deleted");
  setServerIndicator(ws?.readyState === WebSocket.OPEN ? "available" : "offline");
}

async function exportProjectSrt(projectId) {
  const project = getProject(projectId);

  if (!project) {
    return;
  }

  const content = buildSrt(project);

  if (!content) {
    setStatus("file.noExportText");
    openProjectMenuId = null;
    renderProjects();
    return;
  }

  openProjectMenuId = null;
  renderProjects();

  try {
    const tauriInvoke = window.__TAURI__?.core?.invoke;

    if (tauriInvoke) {
      await saveProjectDataFiles(project);
      await tauriInvoke("save_project_srt", {
        projectId: project.id,
        projectTitle: project.title || project.sourceName || "project",
        content,
      });
      await tauriInvoke("open_project_location", {
        projectId: project.id,
        projectTitle: project.title || project.sourceName || "project",
      });
      setStatus("file.srtSaved");
      return;
    }
  } catch (err) {
    console.error(err);
    setStatus("file.srtSaveError");
    return;
  }

  downloadTextFile("audio.srt", content, "application/x-subrip;charset=utf-8");
  setStatus("file.srtExported");
}

async function exportProjectMedia(projectId) {
  const project = getProject(projectId);

  if (!project?.mediaId || project.sourceType !== "microphone") {
    setStatus("file.onlyRecordedAudioExport");
    openProjectMenuId = null;
    renderProjects();
    return;
  }

  openProjectMenuId = null;
  renderProjects();

  try {
    const mediaRecord = await getStoredMedia(project.mediaId);

    if (!mediaRecord?.blob) {
      setStatus("file.savedMediaMissing");
      return;
    }

    const fileName = makeMediaFileName(project, mediaRecord);
    const tauriInvoke = window.__TAURI__?.core?.invoke;

    if (!tauriInvoke) {
      downloadBlobFile(fileName, mediaRecord.blob);
      setStatus("file.mediaExported");
      return;
    }

    const savedPath = await tauriInvoke("export_media", {
      fileName,
      bytes: await blobToBytes(mediaRecord.blob),
    });
    setStatus(savedPath ? "file.audioSaved" : "file.audioExportCancelled");
  } catch (err) {
    console.error(err);
    setStatus("file.mediaExportError");
  }
}

async function openProjectLocation(projectId) {
  const project = getProject(projectId);
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  openProjectMenuId = null;
  renderProjects();

  if (!project || !tauriInvoke) {
    setStatus("projects.locationUnavailable");
    return;
  }

  try {
    await saveProjectDataFiles(project).catch((err) => console.error(err));

    const folderPath = await tauriInvoke("open_project_location", {
      projectId: project.id,
      projectTitle: project.title || project.sourceName || "project",
    });

    project.projectFolderPath = folderPath;
    project.updatedAt = Date.now();
    saveProjects();
    setStatus("projects.locationOpened");
  } catch (err) {
    console.error(err);
    setStatus("projects.locationOpenError");
  }
}

function stopSegmentPlayback({ render = true } = {}) {
  if (mediaPlaybackCleanup) {
    mediaPlaybackCleanup();
    mediaPlaybackCleanup = null;
  }

  const project = activePlaybackKey
    ? getProject(activePlaybackKey.split(":")[0])
    : getActiveProject();

  activePlaybackKey = null;

  if (render && project && activeProjectId === project.id) {
    renderResultPane(project, { preserveScroll: true });
  }
}

async function createProjectPlaybackSource(project) {
  if (project?.mediaId) {
    const mediaRecord = await getStoredMedia(project.mediaId);

    if (!mediaRecord?.blob) {
      throw new Error("stored media missing");
    }

    return {
      url: URL.createObjectURL(mediaRecord.blob),
      revoke: true,
      type: mediaRecord.type || project.mediaType,
      name: mediaRecord.name || project.mediaName || project.sourceName,
    };
  }

  if (project?.mediaPath) {
    const tauriInvoke = window.__TAURI__?.core?.invoke;

    if (!tauriInvoke) {
      throw new Error("native media path is unavailable");
    }

    const convertFileSrc = window.__TAURI__?.core?.convertFileSrc;

    if (convertFileSrc) {
      await tauriInvoke("allow_media_file_path", {
        path: project.mediaPath,
      });

      return {
        url: convertFileSrc(project.mediaPath),
        revoke: false,
        type: project.mediaType,
        name: project.mediaName || project.sourceName,
      };
    }

    const bytes = await tauriInvoke("read_media_file", {
      path: project.mediaPath,
    });
    const blob = new Blob([bytesToArrayBuffer(bytes)], {
      type: project.mediaType || mediaTypeFromFileName(project.mediaName),
    });

    return {
      url: URL.createObjectURL(blob),
      revoke: true,
      type: project.mediaType,
      name: project.mediaName || project.sourceName,
    };
  }

  throw new Error("project media missing");
}

function waitForMediaEvent(element, eventName, timeoutMs, errorMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(errorMessage));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener(eventName, onEvent);
      element.removeEventListener("error", onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("media load failed"));
    };

    element.addEventListener(eventName, onEvent, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
}

async function seekMediaElement(element, seconds) {
  const duration = Number.isFinite(element.duration) ? element.duration : seconds;
  const target = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.05));

  if (Math.abs(element.currentTime - target) < 0.05) {
    return;
  }

  const seeked = waitForMediaEvent(
    element,
    "seeked",
    30000,
    "media seek timed out",
  );

  element.currentTime = target;
  await seeked;

  if (element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
    await waitForMediaEvent(
      element,
      "canplay",
      30000,
      "media decode timed out",
    );
  }
}

async function playSegment(projectId, segment) {
  const project = getProject(projectId);
  const playbackKey = `${projectId}:${segment.id}`;

  if (activePlaybackKey === playbackKey) {
    stopSegmentPlayback();
    return;
  }

  if (!project?.mediaId && !project?.mediaPath) {
    setStatus("media.noStoredMedia");
    return;
  }

  stopSegmentPlayback({ render: false });

  try {
    const mediaSource = await createProjectPlaybackSource(project);
    const element = document.createElement(
      looksLikeVideoMedia({
        type: mediaSource.type,
        name: mediaSource.name,
      })
        ? "video"
        : "audio",
    );
    const startSeconds = Math.max(0, Number(segment.startMs || 0) / 1000);
    const endSeconds = Math.max(
      startSeconds + 0.1,
      Number(segment.endMs || 0) / 1000,
    );
    let stopTimer = null;

    element.className = "media-playback-element";
    element.src = mediaSource.url;
    element.preload = "auto";
    document.body.appendChild(element);

    mediaPlaybackCleanup = () => {
      if (stopTimer) {
        clearTimeout(stopTimer);
      }

      element.pause();
      element.removeAttribute("src");
      element.load();
      element.remove();

      if (mediaSource.revoke) {
        URL.revokeObjectURL(mediaSource.url);
      }
    };

    activePlaybackKey = playbackKey;
    renderResultPane(project, { preserveScroll: true });

    await waitForMediaEvent(
      element,
      "loadedmetadata",
      30000,
      "media metadata timed out",
    );

    await seekMediaElement(element, startSeconds);

    element.ontimeupdate = () => {
      if (element.currentTime >= endSeconds) {
        stopSegmentPlayback();
      }
    };

    element.onended = () => stopSegmentPlayback();
    await element.play();

    stopTimer = setTimeout(
      () => stopSegmentPlayback(),
      Math.max(150, (endSeconds - startSeconds + 0.15) * 1000),
    );
  } catch (err) {
    console.error(err);
    stopSegmentPlayback({ render: false });
    setStatus("media.playError");
    renderResultPane(project, { preserveScroll: true });
  }
}

async function streamPcmChunks(pcm16k, token, speed = FILE_STREAM_SPEED) {
  const chunkSamples = Math.round(
    (TARGET_SAMPLE_RATE * FILE_CHUNK_MS) / 1000,
  );
  const chunkDelayMs = FILE_CHUNK_MS / Math.max(1, speed);

  let offset = 0;

  while (offset < pcm16k.length) {
    if (!fileStreaming || token !== fileStreamToken) {
      return false;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket closed");
    }

    const end = Math.min(offset + chunkSamples, pcm16k.length);
    const chunk = pcm16k.subarray(offset, end);

    sendPcmSamples(chunk);
    offset = end;

    while (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      if (!fileStreaming || token !== fileStreamToken) {
        return false;
      }

      await sleep(20);
    }

    await sleep(chunkDelayMs);
  }

  return true;
}

async function streamProjectAudioFile(
  savedAudio,
  token,
  speed = NATIVE_EXTRACTED_FILE_STREAM_SPEED,
  startMs = 0,
) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!tauriInvoke || !savedAudio?.audioPath) {
    return null;
  }

  if (
    Number(savedAudio.sampleRate) !== TARGET_SAMPLE_RATE ||
    Number(savedAudio.channels) !== 1 ||
    Number(savedAudio.bitsPerSample) !== 16
  ) {
    throw new Error("FFmpeg returned an unsupported WAV format");
  }

  const dataBytes = Number(savedAudio.dataBytes || 0);

  if (!Number.isFinite(dataBytes) || dataBytes <= 0) {
    throw new Error("FFmpeg returned empty audio");
  }

  const readBytes = TARGET_SAMPLE_RATE * 2 * 10;
  const bytesPerFrame = Number(savedAudio.channels) * (Number(savedAudio.bitsPerSample) / 8);
  const byteRate = Number(savedAudio.sampleRate) * bytesPerFrame;
  const startByte = Math.floor((Math.max(0, Number(startMs) || 0) / 1000) * byteRate);
  let offset = startByte - (startByte % bytesPerFrame);

  while (offset < dataBytes) {
    if (!fileStreaming || token !== fileStreamToken) {
      return false;
    }

    const bytes = await tauriInvoke("read_project_audio_pcm_chunk", {
      path: savedAudio.audioPath,
      offset,
      maxBytes: Math.min(readBytes, dataBytes - offset),
    });

    if (!bytes?.length) {
      break;
    }

    offset += bytes.length;
    const chunkFinished = await streamPcmChunks(
      pcmI16BytesToFloat32(bytes),
      token,
      speed,
    );

    if (!chunkFinished) {
      return false;
    }
  }

  return offset > 0;
}

async function streamDecodedAudioBuffer(arrayBuffer, token, speed = FILE_STREAM_SPEED) {
  if (!fileStreaming || token !== fileStreamToken) {
    return false;
  }

  const DecodeAudioContext = window.AudioContext || window.webkitAudioContext;
  const decodeContext = new DecodeAudioContext();

  try {
    const audioBuffer = await decodeContext.decodeAudioData(arrayBuffer);

    if (!fileStreaming || token !== fileStreamToken) {
      return false;
    }

    const currentProject = getCurrentProject();
    if (currentProject) {
      currentProject.durationMs = Math.round(audioBuffer.duration * 1000);
      saveProjects();
      renderProjects();
    }

    const mono = audioBufferToMono(audioBuffer);
    const pcm16k = resampleBuffer(
      mono,
      audioBuffer.sampleRate,
      TARGET_SAMPLE_RATE,
    );
    const wavBlob = float32ToWavBlob(pcm16k, TARGET_SAMPLE_RATE);

    if (currentProject) {
      await attachMediaToProject(currentProject, wavBlob, "audio.wav", "audio/wav");
      await saveProjectAudioWav(currentProject, wavBlob);
    }

    setStatus("file.loading");
    return streamPcmChunks(pcm16k, token, speed);
  } finally {
    await decodeContext.close();
  }
}

async function streamDecodedAudioFile(file, token, speed = FILE_STREAM_SPEED) {
  return streamDecodedAudioBuffer(await file.arrayBuffer(), token, speed);
}

async function streamDecodedNativeAudioFile(mediaFile, token, speed = FILE_STREAM_SPEED) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!tauriInvoke || !mediaFile?.path) {
    return null;
  }

  const bytes = await tauriInvoke("read_media_file", {
    path: mediaFile.path,
  });

  return streamDecodedAudioBuffer(bytesToArrayBuffer(bytes), token, speed);
}

function recorderMimeType() {
  if (!window.MediaRecorder?.isTypeSupported) {
    return "";
  }

  return [
    "audio/mp4",
    "audio/aac",
    "audio/webm;codecs=opus",
    "audio/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function extensionForMimeType(mimeType) {
  if (mimeType.includes("mp4")) {
    return "m4a";
  }

  if (mimeType.includes("aac")) {
    return "aac";
  }

  if (mimeType.includes("wav")) {
    return "wav";
  }

  return "webm";
}

function startMicrophoneRecorder(project) {
  if (!window.MediaRecorder || !mediaStream) {
    return;
  }

  try {
    const mimeType = recorderMimeType();
    const options = mimeType ? { mimeType } : undefined;

    mediaRecorderChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream, options);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data?.size > 0) {
        mediaRecorderChunks.push(event.data);
      }
    };
    mediaRecorder.onerror = (event) => {
      console.error(event);
    };
    mediaRecorder.start(1000);
  } catch (err) {
    console.error(err);
    mediaRecorder = null;
    mediaRecorderChunks = [];
    project.mediaRecorderError = true;
    saveProjects();
  }
}

async function stopMicrophoneRecorder(shouldSave) {
  const recorder = mediaRecorder;
  const chunks = mediaRecorderChunks;
  const pcmChunks = microphonePcmChunks;
  const project = getCurrentProject();

  mediaRecorder = null;
  mediaRecorderChunks = [];
  microphonePcmChunks = [];

  if (!recorder) {
    if (shouldSave && project && pcmChunks.length > 0) {
      const wavBlob = float32ToWavBlob(concatFloat32Chunks(pcmChunks), TARGET_SAMPLE_RATE);
      await attachMediaToProject(project, wavBlob, "audio.wav", "audio/wav");
      await saveProjectAudioWav(project, wavBlob);
    }

    return;
  }

  await new Promise((resolve) => {
    recorder.onstop = async () => {
      if (shouldSave && project && pcmChunks.length > 0) {
        const wavBlob = float32ToWavBlob(concatFloat32Chunks(pcmChunks), TARGET_SAMPLE_RATE);

        try {
          await attachMediaToProject(project, wavBlob, "audio.wav", "audio/wav");
          await saveProjectAudioWav(project, wavBlob);
        } catch (err) {
          console.error(err);
          setStatus("file.audioSaveError");
        }
      } else if (shouldSave && project && chunks.length > 0) {
        const mimeType = recorder.mimeType || chunks[0]?.type || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });
        const fileName =
          `recording-${timestampForFileName(project.createdAt)}.${extensionForMimeType(mimeType)}`;

        try {
          await attachMediaToProject(project, blob, fileName, mimeType);
        } catch (err) {
          console.error(err);
          setStatus("file.audioSaveError");
        }
      }

      resolve();
    };

    if (recorder.state === "inactive") {
      recorder.onstop();
      return;
    }

    try {
      recorder.stop();
    } catch (err) {
      console.error(err);
      resolve();
    }
  });
}

async function streamNativeExtractedMediaFile(file, token) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!tauriInvoke) {
    return null;
  }

  try {
    setStatus("file.fastExtracting");
    console.info("Media extractor:", await tauriInvoke("ffmpeg_sidecar_path"));

    const extracted = await tauriInvoke("extract_media_audio", {
      fileName: file.name,
      bytes: await blobToBytes(file),
    });

    if (!fileStreaming || token !== fileStreamToken) {
      return false;
    }

    if (
      !extracted ||
      Number(extracted.sampleRate) !== TARGET_SAMPLE_RATE ||
      Number(extracted.channels) !== 1 ||
      Number(extracted.bitsPerSample) !== 16
    ) {
      throw new Error("native extractor returned an unsupported PCM format");
    }

    const pcm16k = pcmI16BytesToFloat32(extracted.pcmI16);

    if (pcm16k.length === 0) {
      throw new Error("native extractor returned empty audio");
    }

    const currentProject = getCurrentProject();
    if (currentProject && Number.isFinite(Number(extracted.durationMs))) {
      currentProject.durationMs = Number(extracted.durationMs);
      saveProjects();
      renderProjects();
    }

    if (currentProject) {
      const wavBlob = pcmI16BytesToWavBlob(extracted.pcmI16, TARGET_SAMPLE_RATE);
      await attachMediaToProject(
        currentProject,
        wavBlob,
        "audio.wav",
        "audio/wav",
      );
      await saveProjectAudioWav(currentProject, wavBlob);
    }

    setStatus("file.loading");
    return streamPcmChunks(pcm16k, token, NATIVE_EXTRACTED_FILE_STREAM_SPEED);
  } catch (err) {
    if (!fileStreaming || token !== fileStreamToken) {
      return false;
    }

    console.error("FFmpeg media extraction failed:", err);
    throw new Error(errorMessage(err) || "FFmpeg media extraction failed");
  }
}

async function streamNativeExtractedMediaPath(mediaFile, token) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!tauriInvoke || !mediaFile?.path) {
    return null;
  }

  try {
    setStatus("file.fastExtracting");
    tauriInvoke("ffmpeg_sidecar_path")
      .then((path) => console.info("Media extractor:", path))
      .catch((err) => console.info("Media extractor unavailable:", errorMessage(err)));

    const currentProject = getCurrentProject();

    if (!currentProject) {
      throw new Error("project missing");
    }

    const savedAudio = await tauriInvoke("prepare_project_audio_from_path", {
      projectId: currentProject.id,
      projectTitle: currentProject.title || currentProject.sourceName || "project",
      path: mediaFile.path,
    });

    if (!fileStreaming || token !== fileStreamToken) {
      return false;
    }

    attachProjectAudioFile(currentProject, savedAudio);

    setStatus("file.loading");
    return streamProjectAudioFile(savedAudio, token);
  } catch (err) {
    if (!fileStreaming || token !== fileStreamToken) {
      return false;
    }

    console.error("FFmpeg path media extraction failed:", err);
    throw new Error(errorMessage(err) || "FFmpeg path media extraction failed");
  }
}

async function streamMediaElementFile(file, token) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  const url = URL.createObjectURL(file);
  const element = document.createElement(
    looksLikeVideoMedia(file) ? "video" : "audio",
  );
  const source = context.createMediaElementSource(element);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silentGain = context.createGain();
  let ended = false;

  silentGain.gain.value = 0;
  element.className = "media-playback-element";
  element.preload = "auto";
  element.src = url;
  element.playsInline = true;
  document.body.appendChild(element);

  processor.onaudioprocess = (event) => {
    if (!fileStreaming || token !== fileStreamToken) {
      return;
    }

    const mono = audioBufferToMono(event.inputBuffer);
    const pcm16k = resampleBuffer(
      mono,
      context.sampleRate,
      TARGET_SAMPLE_RATE,
    );

    sendPcmSamples(pcm16k);
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);

  fileMediaCleanup = () => {
    element.pause();
    element.removeAttribute("src");
    element.load();
    element.remove();
    processor.disconnect();
    source.disconnect();
    silentGain.disconnect();
    URL.revokeObjectURL(url);
    void context.close();
  };

  try {
    if (context.state === "suspended") {
      await context.resume();
    }

    await new Promise((resolve, reject) => {
      element.onloadedmetadata = () => resolve();
      element.onerror = () => reject(new Error("media element decode failed"));
    });

    const currentProject = getCurrentProject();
    if (currentProject && Number.isFinite(element.duration)) {
      currentProject.durationMs = Math.round(element.duration * 1000);
      saveProjects();
      renderProjects();
    }

    setStatus("file.videoProcessing");

    const finished = await new Promise((resolve, reject) => {
      const cancelTimer = setInterval(() => {
        if (!fileStreaming || token !== fileStreamToken) {
          clearInterval(cancelTimer);
          resolve(false);
        }
      }, 100);

      element.onended = () => {
        ended = true;
        clearInterval(cancelTimer);
        resolve(true);
      };
      element.onerror = () => {
        clearInterval(cancelTimer);
        reject(new Error("media playback failed"));
      };
      element.play().catch((err) => {
        clearInterval(cancelTimer);
        reject(err);
      });
    });

    return Boolean(finished) && ended && fileStreaming && token === fileStreamToken;
  } finally {
    if (fileMediaCleanup) {
      fileMediaCleanup();
      fileMediaCleanup = null;
    }
  }
}

async function startRecording() {
  if (recording || fileStreaming || currentRunMode) {
    await stopAsr();
  }

  const asrLanguage = normalizeAsrLanguage(appSettings.asrLanguage);
  const project = createProject({
    title: nextMicrophoneProjectTitle(),
    sourceType: "microphone",
    sourceName: "microphone",
    language: asrLanguage,
  });
  project.asr = { lang: asrLanguage };

  currentRunMode = "microphone";
  setBusyState(true);
  setStatus("status.checkingMicrophone");
  setServerIndicator("working");

  try {
    mediaStream = await getMicrophoneStream();
  } catch (err) {
    console.error(err);
    setStatus(microphoneStatusText(err));
    setProjectStatus(currentProjectId, "cancelled");
    currentProjectId = null;
    currentRunMode = null;
    setServerIndicator(ws?.readyState === WebSocket.OPEN ? "available" : "offline");
    setBusyState(false);

    return;
  }

  try {
    await startServerSession();
  } catch (err) {
    console.error(err);
    setStatus(serverStartupStatusText(err));
    setProjectStatus(currentProjectId, "cancelled");
    currentProjectId = null;
    currentRunMode = null;
    await closeAudioResources();
    setServerIndicator("offline");
    setBusyState(false);
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextClass();

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);

  microphonePcmChunks = [];
  startMicrophoneRecorder(project);
  recording = true;

  processorNode.onaudioprocess = (event) => {
    if (!recording || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const pcm16k = resampleBuffer(
      input,
      audioContext.sampleRate,
      TARGET_SAMPLE_RATE,
    );

    microphonePcmChunks.push(new Float32Array(pcm16k));
    sendPcmSamples(pcm16k);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);

  setStatus("status.recording");
  setServerIndicator("working");
}

function selectedAsrMediaFiles() {
  if (selectedNativeMediaFiles.length > 0) {
    return supportedMediaFiles(selectedNativeMediaFiles);
  }

  if (selectedDroppedMediaFiles.length > 0) {
    return supportedMediaFiles(selectedDroppedMediaFiles);
  }

  return supportedMediaFiles(Array.from(audioFileEl.files || []));
}

async function createAsrProjectForMedia(mediaFile) {
  const asrLanguage = normalizeAsrLanguage(appSettings.asrLanguage);
  const project = createProject({
    title: mediaFile.name,
    sourceType: looksLikeVideoMedia(mediaFile) ? "video" : "file",
    sourceName: mediaFile.name,
    language: asrLanguage,
  });

  project.status = "queued";
  project.asr = { lang: asrLanguage };
  project.asrBatch = {
    sourcePath: mediaFile.path || "",
    sourceName: mediaFile.name,
    queuedAt: Date.now(),
  };

  if (mediaFile.path) {
    attachNativeMediaPath(project, mediaFile);
  } else {
    await attachMediaToProject(
      project,
      mediaFile,
      mediaFile.name,
      mediaFile.type || "application/octet-stream",
    );
  }

  project.status = "queued";
  project.updatedAt = Date.now();
  saveProjects();
  saveProjectDataFilesSoon(project);
  renderProjects();
  return project;
}

async function queuedAsrProjectsFromMedia(mediaFiles) {
  const supported = supportedMediaFiles(mediaFiles);
  const projectsToRun = [];

  for (const mediaFile of supported) {
    try {
      projectsToRun.push(await createAsrProjectForMedia(mediaFile));
    } catch (err) {
      console.error(err);
    }
  }

  currentProjectId = null;
  currentRunMode = null;
  pendingConfirmedSkips = [];
  resetTranscript();
  renderProjects();
  renderActiveProject();

  return projectsToRun;
}

function hasPreparedProjectAudio(project) {
  return Boolean(project?.projectAudioPath || project?.asrBatch?.audioPath);
}

function projectAudioFile(project) {
  const info = project.projectAudioInfo || {};
  const audioPath = project.projectAudioPath || project.asrBatch?.audioPath || project.mediaPath;

  return {
    folderPath: project.projectFolderPath || "",
    audioPath,
    sampleRate: Number(info.sampleRate || TARGET_SAMPLE_RATE),
    channels: Number(info.channels || 1),
    bitsPerSample: Number(info.bitsPerSample || 16),
    durationMs: Number(info.durationMs || project.durationMs || 0) || null,
    dataBytes: Number(info.dataBytes || 0) || null,
  };
}

async function ensureProjectAudioInfo(project) {
  const audioFile = projectAudioFile(project);

  if (audioFile.audioPath && audioFile.dataBytes) {
    return audioFile;
  }

  const tauriInvoke = window.__TAURI__?.core?.invoke;
  if (!tauriInvoke || !audioFile.audioPath) {
    return audioFile;
  }

  const inspected = await tauriInvoke("read_project_audio_info", {
    path: audioFile.audioPath,
  });
  attachProjectAudioFile(project, inspected);
  return projectAudioFile(project);
}

async function prepareAsrProjectAudio(project) {
  if (!project) {
    throw new Error("project missing");
  }

  if (hasPreparedProjectAudio(project)) {
    return ensureProjectAudioInfo(project);
  }

  const tauriInvoke = window.__TAURI__?.core?.invoke;
  if (!tauriInvoke) {
    throw new Error("native media preparation unavailable");
  }

  project.status = "preparing";
  project.errorMessage = "";
  project.updatedAt = Date.now();
  saveProjects();
  renderProjects();
  updateAsrBatchProgress("projects.batchPreparingWav");

  const sourcePath = project.asrBatch?.sourcePath || project.mediaPath || "";

  if (sourcePath) {
    const savedAudio = await tauriInvoke("prepare_project_audio_from_path", {
      projectId: project.id,
      projectTitle: project.title || project.sourceName || "project",
      path: sourcePath,
    });
    attachProjectAudioFile(project, savedAudio);
    project.status = "queued";
    project.updatedAt = Date.now();
    saveProjects();
    renderProjects();
    return projectAudioFile(project);
  }

  const mediaRecord = await getStoredMedia(project.mediaId);
  if (!mediaRecord?.blob) {
    throw new Error("stored media missing");
  }

  const extracted = await tauriInvoke("extract_media_audio", {
    fileName: mediaRecord.name || project.sourceName || "media",
    bytes: await blobToBytes(mediaRecord.blob),
  });

  if (!extracted?.pcmI16?.length) {
    throw new Error("media audio is empty");
  }

  const wavBlob = pcmI16BytesToWavBlob(extracted.pcmI16, TARGET_SAMPLE_RATE);
  await attachMediaToProject(project, wavBlob, "audio.wav", "audio/wav");
  const savedAudio = await saveProjectAudioWav(project, wavBlob);

  if (Number.isFinite(Number(extracted.durationMs))) {
    project.durationMs = Number(extracted.durationMs);
  }

  attachProjectAudioFile(project, savedAudio);
  project.status = "queued";
  project.updatedAt = Date.now();
  saveProjects();
  renderProjects();
  return projectAudioFile(project);
}

function asrProjectResumeOffsetMs(project, audioFile) {
  const lastEndMs = lastProjectSegmentEndMs(project);

  if (!Number.isFinite(lastEndMs) || lastEndMs <= 0) {
    return 0;
  }

  const durationMs = Number(audioFile?.durationMs || project?.durationMs || 0);

  if (Number.isFinite(durationMs) && durationMs > 0 && lastEndMs >= durationMs - 250) {
    return durationMs;
  }

  return Math.max(0, lastEndMs);
}

async function transcribePreparedAsrProject(project) {
  const audioFile = await ensureProjectAudioInfo(project);

  if (!audioFile.audioPath || !audioFile.dataBytes) {
    throw new Error("prepared WAV is missing");
  }

  const resumeOffsetMs = asrProjectResumeOffsetMs(project, audioFile);
  const resuming = resumeOffsetMs > 0 && (project.segments || []).length > 0;
  const audioDurationMs = Number(audioFile.durationMs || project.durationMs || 0);

  if (
    resuming &&
    Number.isFinite(audioDurationMs) &&
    audioDurationMs > 0 &&
    resumeOffsetMs >= audioDurationMs - 250
  ) {
    project.status = "done";
    project.transcript = transcriptFromSegments(project.segments);
    project.updatedAt = Date.now();
    saveProjects();
    saveProjectDataFilesSoon(project);
    renderProjects();
    renderActiveProject();
    return { projectId: project.id, status: "done" };
  }

  project.status = "running";
  project.errorMessage = "";
  if (resuming) {
    project.transcript = transcriptFromSegments(project.segments);
  } else {
    project.transcript = "";
    project.segments = [];
  }
  project.updatedAt = Date.now();
  activeProjectId = project.id;
  currentProjectId = project.id;
  currentRunMode = "file";
  currentRunOffsetMs = resuming ? resumeOffsetMs : 0;
  pendingConfirmedSkips = [];
  confirmedText = normalizeTranscriptText(project.transcript);
  unconfirmedText = "";
  saveProjects();
  renderProjects();
  renderActiveProject();
  renderText();

  await startServerSession();
  fileStreaming = true;
  const token = ++fileStreamToken;
  const runDone = beginCurrentFileRun(project.id);

  try {
    setStatus(resuming ? "file.resuming" : "file.loading");
    setServerIndicator("working");
    const finished = await streamProjectAudioFile(
      audioFile,
      token,
      NATIVE_EXTRACTED_FILE_STREAM_SPEED,
      resumeOffsetMs,
    );

    if (
      finished &&
      fileStreaming &&
      token === fileStreamToken &&
      ws &&
      ws.readyState === WebSocket.OPEN
    ) {
      ws.send(JSON.stringify({ type: "stop" }));
      setStatus("file.completedProcessing");
      setServerIndicator("working");
      setProjectStatus(project.id, "processing");
    }

    return await runDone;
  } catch (err) {
    console.error(err);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "cancel" }));
    }
    setProjectStatus(project.id, "error");
    finishCurrentFileRun(project.id, "error");
    throw err;
  } finally {
    if (token === fileStreamToken) {
      fileStreaming = false;
      currentRunOffsetMs = 0;
    }
  }
}

async function runAsrBatchProjects(projectIds) {
  if (asrBatchRunning) {
    setStatus("status.asrBusy");
    return;
  }

  const batchProjects = projectIds
    .map((projectId) => getProject(projectId))
    .filter(isAsrProjectResumable);

  if (batchProjects.length === 0) {
    setStatus("projects.noResume");
    return;
  }

  asrBatchRunning = true;
  asrBatchStopRequested = false;
  asrBatchTotal = batchProjects.length;
  asrBatchDone = 0;
  markQueuedAsrBatchProjects(batchProjects);
  setBusyState(true);
  updateAsrBatchProgress("projects.batchPreparingWav");

  try {
    for (const project of batchProjects) {
      if (asrBatchStopRequested) {
        break;
      }

      try {
        await prepareAsrProjectAudio(project);
      } catch (err) {
        console.error(err);
        project.errorMessage = errorMessage(err);
        project.status = "error";
        project.updatedAt = Date.now();
        saveProjects();
        saveProjectDataFilesSoon(project);
        renderProjects();
        setStatus(project.errorMessage);
      }
    }

    updateAsrBatchProgress("projects.batchRecognizing");

    for (const project of batchProjects) {
      if (asrBatchStopRequested) {
        break;
      }

      if (!isAsrProjectResumable(project) || !hasPreparedProjectAudio(project)) {
        continue;
      }

      try {
        const result = await transcribePreparedAsrProject(project);
        if (result.status === "done") {
          asrBatchDone += 1;
        }
      } catch (err) {
        console.error(err);
        if (project.status !== "cancelled") {
          project.errorMessage = errorMessage(err);
          project.status = "error";
          project.updatedAt = Date.now();
          saveProjects();
          saveProjectDataFilesSoon(project);
          renderProjects();
          setStatus(project.errorMessage);
        }
      }

      updateAsrBatchProgress("projects.batchRecognizing");
    }
  } finally {
    const wasStopped = asrBatchStopRequested;
    if (wasStopped) {
      markStoppedAsrBatchProjects(batchProjects);
    }
    const remaining = batchProjects.filter(isAsrProjectResumable).length;
    asrBatchRunning = false;
    asrBatchStopRequested = false;
    currentProjectId = null;
    currentRunMode = null;
    fileStreaming = false;
    setBusyState(false);
    updateSelectedFileName();
    renderProjects();
    renderActiveProject();
    setStatus(
      wasStopped
        ? "status.asrStopped"
        : remaining > 0
          ? "projects.someIncomplete"
          : "projects.allCompleted",
    );
    setServerIndicator(ws?.readyState === WebSocket.OPEN ? "available" : "offline");
  }
}

async function resumeAsrProject(projectId) {
  openProjectMenuId = null;
  renderProjects();
  await runAsrBatchProjects([projectId]);
}

async function resumeAllAsrJobs() {
  openProjectMenuId = null;
  renderProjects();
  await runAsrBatchProjects(resumableAsrProjects().map((project) => project.id));
}

async function streamAudioFile() {
  const mediaFiles = selectedAsrMediaFiles();

  if (mediaFiles.length === 0) {
    setStatus("file.selectAudioVideo");
    return;
  }

  if (recording || fileStreaming || currentRunMode) {
    await stopAsr();
  }

  const projectsToRun = await queuedAsrProjectsFromMedia(mediaFiles);

  if (projectsToRun.length === 0) {
    setStatus("file.unsupported");
    return;
  }

  setStatus("file.addedCount", { count: projectsToRun.length });
  await runAsrBatchProjects(projectsToRun.map((project) => project.id));
}

async function stopAsr() {
  if (asrBatchRunning) {
    asrBatchStopRequested = true;
  }

  if (!recording && !fileStreaming && !currentRunMode) {
    if (asrBatchRunning) {
      setStatus("status.asrStopping");
    }
    return;
  }

  const wasFileJob = currentRunMode === "file" || fileStreaming;

  recording = false;
  cancelFileStream();
  await stopMicrophoneRecorder(!wasFileJob);
  await closeAudioResources();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: wasFileJob ? "cancel" : "stop",
      }),
    );
  }

  if (wasFileJob) {
    const projectId = currentProjectId;
    resetTranscript();
    setProjectStatus(projectId, "cancelled");
    finishCurrentFileRun(projectId, "cancelled");
    currentProjectId = null;
    currentRunMode = null;
    setStatus("file.stopped");
    setBusyState(false);
    setServerIndicator(ws?.readyState === WebSocket.OPEN ? "available" : "offline");
  } else {
    setProjectStatus(currentProjectId, "processing");
    setStatus("status.stoppedProcessingRemaining");
    setServerIndicator("working");
  }
}

window.addEventListener("beforeunload", () => {
  asrBatchStopRequested = true;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "cancel" }));
  }
});

async function bootApp() {
  loadSettings();
  setActiveLocale(appSettings.displayLanguage);

  try {
    await installProtectedUi();
  } catch (err) {
    console.error(err);
  }

  loadProjects();
  applyLocale();
  installDomDropZone(filePickerEl, "asr");
  void installNativeDragDrop();

  setServerIndicator("working");
  setBusyState(false);

  startBtn.addEventListener("click", startRecording);
  stopBtn.addEventListener("click", stopAsr);
  fileBtn.addEventListener("click", streamAudioFile);
  filePickerEl.addEventListener("click", (event) => {
    if (window.__TAURI__?.core?.invoke) {
      event.preventDefault();
      void pickNativeMediaFile();
    }
  });
  audioFileEl.addEventListener("change", () => {
    selectedNativeMediaFile = null;
    selectedNativeMediaFiles = [];
    selectedDroppedMediaFiles = supportedMediaFiles(Array.from(audioFileEl.files || []));
    selectedDroppedMediaFile = selectedDroppedMediaFiles[0] || null;
    updateSelectedFileName();
  });
  resumeAllBtn?.addEventListener("click", () => {
    void resumeAllAsrJobs();
  });
  clearProjectsBtn.addEventListener("click", clearAllData);
  wholeViewBtn.addEventListener("click", () => setResultViewMode("whole"));
  timelineViewBtn.addEventListener("click", () => setResultViewMode("timeline"));
  aboutBtn.addEventListener("click", openAbout);
  aboutCloseBtn.addEventListener("click", closeAbout);
  settingsBtn.addEventListener("click", openSettings);
  settingsCloseBtn.addEventListener("click", closeSettings);
  settingsConfirmBtn.addEventListener("click", () => {
    void confirmSettings();
  });
  aboutModalEl.addEventListener("click", (event) => {
    if (event.target === aboutModalEl) {
      closeAbout();
    }
  });
  settingsModalEl.addEventListener("click", (event) => {
    if (event.target === settingsModalEl) {
      closeSettings();
    }
  });
  asrLanguageSelectEl.addEventListener("change", () => {
    pendingSettings.asrLanguage = normalizeAsrLanguage(asrLanguageSelectEl.value);
    renderSettings();
  });
  displayLanguageSelectEl.addEventListener("change", () => {
    pendingSettings.displayLanguage = normalizeDisplayLanguage(displayLanguageSelectEl.value);
    renderSettings();
  });
  maxUnconfirmedRangeEl.addEventListener("input", () => {
    pendingSettings.maxUnconfirmedSec = clampNumber(
      maxUnconfirmedRangeEl.value,
      3,
      20,
      DEFAULT_MAX_UNCONFIRMED_SEC,
    );
    renderSettings();
  });
  projectListEl.addEventListener("scroll", () => {
    if (!openProjectMenuId) {
      return;
    }

    openProjectMenuId = null;
    renderProjects();
  });

  window.addEventListener("resize", () => {
    if (!openProjectMenuId) {
      return;
    }

    openProjectMenuId = null;
    renderProjects();
  });

  document.addEventListener("click", (event) => {
    if (!openProjectMenuId) {
      return;
    }

    if (
      event.target instanceof Element &&
      (event.target.closest(".project-item") ||
        event.target.closest(".project-menu"))
    ) {
      return;
    }

    openProjectMenuId = null;
    renderProjects();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    if (!aboutModalEl.hidden) {
      closeAbout();
      return;
    }

    if (!settingsModalEl.hidden) {
      closeSettings();
      return;
    }

    if (openProjectMenuId) {
      openProjectMenuId = null;
      renderProjects();
    }
  });

  ensureServerProcess()
    .then(connectWebSocket)
    .catch((err) => console.error(err));
}

window.addEventListener("DOMContentLoaded", () => {
  void bootApp();
});
