#include <websocketpp/config/asio_no_tls.hpp>
#include <websocketpp/server.hpp>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "ggml-backend.h"
#include "whisper.h"
#include "umsc.h"

using websocketpp::connection_hdl;
using server_t = websocketpp::server<websocketpp::config::asio>;

static const int TARGET_SAMPLE_RATE = 16000;
static const int CHUNK_MS = 1000;
static const size_t CHUNK_SAMPLES = TARGET_SAMPLE_RATE * CHUNK_MS / 1000;
static const float GAP_THRESHOLD_SEC = 0.30f;
static const float MIN_CONFIRMED_SEC = 3.0f;
static const float DEFAULT_MAX_UNCONFIRMED_SEC = 15.0f;
static const float MIN_MAX_UNCONFIRMED_SEC = 3.0f;
static const float MAX_MAX_UNCONFIRMED_SEC = 20.0f;
static const double ENERGY_SPEECH_RMS_THRESHOLD = 0.008;
static const float ENERGY_SPEECH_PEAK_THRESHOLD = 0.050f;

struct PreviewSettings {
    bool enabled = true;
    bool skip_speech_vad_segment_release = false;
};

struct RuntimeSettings {
    std::string model_mode = "normal";
    std::string language = "uz";
    bool convert_uyghur_script = true;
    float max_unconfirmed_sec = DEFAULT_MAX_UNCONFIRMED_SEC;
    int preview_best_of = 1;
    int confirm_best_of = 4;
};

struct AudioLevel {
    double rms = 0.0;
    float peak = 0.0f;
};

enum class RequestedBackend {
    Auto,
    Cpu,
    Metal,
    Vulkan,
    Cuda
};

struct WhisperModelState {
    whisper_context* ctx = nullptr;
    std::string mode = "slow";
    std::string path;
    bool is_uyghur_model = true;
    RequestedBackend backend = RequestedBackend::Auto;
};

// ============================================================
// Silence ASR engine logs
// ============================================================

static void whisper_log_callback_silent(
    ggml_log_level level,
    const char* text,
    void* user_data
) {
    (void)level;
    (void)text;
    (void)user_data;
}

static bool starts_with_text(
    const std::string& text,
    const char* prefix
) {
    return text.rfind(prefix, 0) == 0;
}

static void replace_all_in_place(
    std::string& text,
    const std::string& needle,
    const std::string& replacement
) {
    if (needle.empty()) {
        return;
    }

    size_t pos = 0;
    while ((pos = text.find(needle, pos)) != std::string::npos) {
        text.replace(pos, needle.size(), replacement);
        pos += replacement.size();
    }
}

static std::string sanitize_engine_names_for_log(std::string text) {
    replace_all_in_place(text, "whisper.cpp", "ASR engine");
    replace_all_in_place(text, "Whisper", "ASR");
    replace_all_in_place(text, "whisper", "ASR");
    return text;
}

static bool should_print_startup_log_to_terminal(const std::string& text) {
    static bool worker_waiting_printed = false;

    if (text == "worker waiting") {
        if (worker_waiting_printed) {
            return false;
        }

        worker_waiting_printed = true;
        return true;
    }

    return starts_with_text(text, "Executable: ") ||
           starts_with_text(text, "Requested backend: ") ||
           starts_with_text(text, "Registered backend count: ") ||
           starts_with_text(text, "Backend registry[") ||
           starts_with_text(text, "Registered device count: ") ||
           starts_with_text(text, "Device[") ||
           starts_with_text(text, "Loading ASR model with requested backend ") ||
           starts_with_text(text, "ASR model load succeeded for backend ") ||
           starts_with_text(text, "Preview and confirmation use the same ASR backend: ") ||
           starts_with_text(text, "changed to ") ||
           text == "worker thread started" ||
           text == "WebSocket ASR server running";
}

static void log_stage(const std::string& text) {
    static std::mutex log_mutex;
    static bool log_initialized = false;
    static std::ofstream log_file;

    std::lock_guard<std::mutex> lock(log_mutex);

    if (!log_initialized) {
        const char* configured_path = std::getenv("UGASR_LOG_FILE");
        const std::string log_path =
            (configured_path != nullptr && configured_path[0] != '\0')
                ? std::string(configured_path)
                : std::string("ASR-debug.log");

        log_file.open(log_path, std::ios::app);
        log_initialized = true;
    }

    const std::string sanitized_text = sanitize_engine_names_for_log(text);

    if (should_print_startup_log_to_terminal(sanitized_text)) {
        std::cerr << "[ASR] " << sanitized_text << std::endl;
    }

    if (log_file) {
        log_file << "[ASR] " << sanitized_text << std::endl;
    }
}

// ============================================================
// JSON helpers
// ============================================================

static bool is_utf8_continuation(unsigned char c) {
    return (c & 0xC0u) == 0x80u;
}

static std::string sanitize_utf8(const std::string& text) {
    std::string result;
    result.reserve(text.size());

    for (size_t i = 0; i < text.size();) {
        const unsigned char lead = static_cast<unsigned char>(text[i]);

        if (lead <= 0x7Fu) {
            result.push_back(static_cast<char>(lead));
            i++;
            continue;
        }

        size_t width = 0;

        if (lead >= 0xC2u && lead <= 0xDFu) {
            width = 2;
        } else if (lead >= 0xE0u && lead <= 0xEFu) {
            width = 3;
        } else if (lead >= 0xF0u && lead <= 0xF4u) {
            width = 4;
        } else {
            result.push_back(' ');
            i++;
            continue;
        }

        if (i + width > text.size()) {
            result.push_back(' ');
            break;
        }

        bool valid = true;

        for (size_t j = 1; j < width; ++j) {
            if (!is_utf8_continuation(static_cast<unsigned char>(text[i + j]))) {
                valid = false;
                break;
            }
        }

        const unsigned char second =
            static_cast<unsigned char>(text[i + 1]);

        if (valid && width == 3) {
            valid = !((lead == 0xE0u && second < 0xA0u) ||
                      (lead == 0xEDu && second > 0x9Fu));
        } else if (valid && width == 4) {
            valid = !((lead == 0xF0u && second < 0x90u) ||
                      (lead == 0xF4u && second > 0x8Fu));
        }

        if (!valid) {
            result.push_back(' ');
            i++;
            continue;
        }

        result.append(text, i, width);
        i += width;
    }

    return result;
}

static std::string json_escape(const std::string& s) {
    std::ostringstream out;
    const std::string safe = sanitize_utf8(s);

    for (unsigned char c : safe) {
        switch (c) {
        case '\\': out << "\\\\"; break;
        case '"':  out << "\\\""; break;
        case '\n': out << "\\n";  break;
        case '\r': out << "\\r";  break;
        case '\t': out << "\\t";  break;
        default:
            if (c < 0x20) {
                out << "\\u00";
                const char* hex = "0123456789ABCDEF";
                out << hex[(c >> 4) & 0x0F];
                out << hex[c & 0x0F];
            } else {
                out << c;
            }
        }
    }

    return out.str();
}

static std::string make_json(
    const std::string& type,
    const std::string& text
) {
    return "{\"type\":\"" + json_escape(type) +
           "\",\"text\":\"" + json_escape(text) +
           "\"}";
}

static std::string make_segment_json(
    const std::string& text,
    std::uint64_t start_ms,
    std::uint64_t end_ms
) {
    return "{\"type\":\"segment\",\"text\":\"" + json_escape(text) +
           "\",\"start_ms\":" + std::to_string(start_ms) +
           ",\"end_ms\":" + std::to_string(end_ms) +
           "}";
}

// ============================================================
// Thread-safe audio queue
// Browser sends Float32 PCM, 16 kHz, mono.
// ============================================================

class AudioQueue {
public:
    enum class PopResult {
        Chunk,
        StopRequested,
        Shutdown
    };

    void push(
        const float* data,
        size_t n,
        std::uint64_t session_generation
    ) {
        {
            std::lock_guard<std::mutex> lock(mutex_);

            for (size_t i = 0; i < n; ++i) {
                float sample = std::isfinite(data[i]) ? data[i] : 0.0f;
                sample = std::clamp(sample, -1.0f, 1.0f);

                samples_.push_back({sample, session_generation});
            }
        }

        cv_.notify_one();
    }

    PopResult pop(
        std::vector<float>& out,
        size_t chunk_samples,
        std::uint64_t& session_generation
    ) {
        std::unique_lock<std::mutex> lock(mutex_);

        cv_.wait(lock, [&]() {
            return shutdown_ ||
                   stop_requested_ ||
                   samples_.size() >= chunk_samples;
        });

        if (shutdown_) {
            return PopResult::Shutdown;
        }

        // If there is a full chunk, process it first.
        // Even after stop, this allows all full chunks to be processed.
        if (samples_.size() >= chunk_samples) {
            out.resize(chunk_samples);
            session_generation = samples_.front().session_generation;

            for (size_t i = 0; i < chunk_samples; ++i) {
                out[i] = samples_.front().value;
                samples_.pop_front();
            }

            return PopResult::Chunk;
        }

        // Stop requested and less than one chunk remains.
        // Return all remaining audio.
        if (stop_requested_) {
            out.clear();
            out.reserve(samples_.size());
            session_generation =
                samples_.empty()
                    ? stop_session_generation_
                    : samples_.front().session_generation;

            while (!samples_.empty()) {
                out.push_back(samples_.front().value);
                samples_.pop_front();
            }

            stop_requested_ = false;

            return PopResult::StopRequested;
        }

        return PopResult::Shutdown;
    }

    void request_stop(std::uint64_t session_generation) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stop_requested_ = true;
            stop_session_generation_ = session_generation;
        }

        cv_.notify_one();
    }

    void reset() {
        {
            std::lock_guard<std::mutex> lock(mutex_);

            samples_.clear();
            stop_requested_ = false;
            stop_session_generation_ = 0;
        }

        cv_.notify_one();
    }

    void shutdown() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            shutdown_ = true;
        }

        cv_.notify_all();
    }

private:
    struct QueuedSample {
        float value = 0.0f;
        std::uint64_t session_generation = 0;
    };

    std::deque<QueuedSample> samples_;
    std::mutex mutex_;
    std::condition_variable cv_;

    bool stop_requested_ = false;
    bool shutdown_ = false;
    std::uint64_t stop_session_generation_ = 0;
};

// ============================================================
// Data structures
// ============================================================

struct whisper_vad_segment {
    std::vector<float> segment;
    bool is_speech = false;
    std::uint64_t start_sample = 0;

    // Gray preview text belonging to this buffered audio part.
    std::string preview_text;
};

struct whisper_transcription_segment {
    int counter = 0;

    std::vector<int> unconfirmed_text_indices;
    std::vector<std::string> unconfirmed_texts;
    std::vector<std::string> confirmed_texts;

    int last_confirmed = 0;
    std::uint64_t confirmed_samples = 0;
    std::uint64_t next_input_sample = 0;
};

static bool check_if_all_silence(
    const std::vector<whisper_vad_segment>& segments
) {
    for (const auto& seg : segments) {
        if (seg.is_speech) {
            return false;
        }
    }

    return true;
}

static AudioLevel compute_audio_level(const std::vector<float>& samples) {
    double sum_squares = 0.0;
    float peak = 0.0f;

    for (float sample : samples) {
        if (!std::isfinite(sample)) {
            continue;
        }

        const float abs_sample = std::fabs(sample);
        peak = std::max(peak, abs_sample);
        sum_squares += static_cast<double>(sample) * static_cast<double>(sample);
    }

    AudioLevel level;
    level.rms = samples.empty()
        ? 0.0
        : std::sqrt(sum_squares / static_cast<double>(samples.size()));
    level.peak = peak;
    return level;
}

static std::string audio_level_summary(const AudioLevel& level) {
    return "rms=" + std::to_string(level.rms) +
        ", peak=" + std::to_string(level.peak);
}

static bool has_speech_energy(const AudioLevel& level) {
    return level.rms >= ENERGY_SPEECH_RMS_THRESHOLD &&
        level.peak >= ENERGY_SPEECH_PEAK_THRESHOLD;
}

static int get_speech_count(
    const std::vector<whisper_vad_segment>& segments
) {
    int count = 0;

    for (const auto& seg : segments) {
        if (seg.is_speech) {
            count++;
        }
    }

    return count;
}

static bool has_two_trailing_silences_after_speech(
    const std::vector<whisper_vad_segment>& segments
) {
    if (segments.size() < 3) {
        return false;
    }

    if (segments[segments.size() - 1].is_speech ||
        segments[segments.size() - 2].is_speech) {
        return false;
    }

    for (size_t i = 0; i + 2 < segments.size(); ++i) {
        if (segments[i].is_speech) {
            return true;
        }
    }

    return false;
}

static std::string join_texts(const std::vector<std::string>& texts) {
    std::ostringstream ss;

    for (const auto& t : texts) {
        ss << t;
    }

    return ss.str();
}

static std::string build_unconfirmed_from_vad_segments(
    const std::vector<whisper_vad_segment>& vad_segments
) {
    std::ostringstream ss;

    for (const auto& seg : vad_segments) {
        if (seg.is_speech && !seg.preview_text.empty()) {
            ss << seg.preview_text;
        }
    }

    return ss.str();
}

// ============================================================
// App state
// ============================================================

struct ClientSession {
    connection_hdl hdl;
    AudioQueue audio_queue;
    std::atomic<bool> recording{false};
    std::atomic<std::uint64_t> session_generation{0};

    RuntimeSettings runtime_settings;
    std::vector<whisper_vad_segment> vad_segments;
    whisper_transcription_segment transcription;
};

struct AppState {
    server_t* server = nullptr;

    std::mutex connection_mutex;
    std::map<
        connection_hdl,
        std::shared_ptr<ClientSession>,
        std::owner_less<connection_hdl>
    > sessions;

    std::mutex processing_mutex;
    WhisperModelState whisper_model;
};

static std::uint64_t advance_session(ClientSession& session) {
    return session.session_generation.fetch_add(1) + 1;
}

static bool is_current_session(
    const ClientSession& session,
    std::uint64_t session_generation
) {
    return session.session_generation.load() == session_generation;
}

static void send_json(
    AppState& app,
    const std::shared_ptr<ClientSession>& session,
    const std::string& type,
    const std::string& text
) {
    if (!session || app.server == nullptr) {
        return;
    }

    std::string payload = make_json(type, text);

    app.server->get_io_service().post(
        [server = app.server, hdl_copy = session->hdl, payload]() {
            websocketpp::lib::error_code ec;

            server->send(
                hdl_copy,
                payload,
                websocketpp::frame::opcode::text,
                ec
            );
        }
    );
}

static void send_json_for_session(
    AppState& app,
    const std::shared_ptr<ClientSession>& session,
    std::uint64_t session_generation,
    const std::string& type,
    const std::string& text
) {
    if (!session || session->session_generation.load() != session_generation) {
        return;
    }

    if (app.server == nullptr) {
        return;
    }

    std::string payload = make_json(type, text);

    app.server->get_io_service().post(
        [
            server = app.server,
            session,
            hdl_copy = session->hdl,
            payload,
            session_generation
        ]() {
            if (session->session_generation.load() != session_generation) {
                return;
            }

            websocketpp::lib::error_code ec;

            server->send(
                hdl_copy,
                payload,
                websocketpp::frame::opcode::text,
                ec
            );
        }
    );
}

static void send_payload_for_session(
    AppState& app,
    const std::shared_ptr<ClientSession>& session,
    std::uint64_t session_generation,
    const std::string& payload
) {
    if (!session || session->session_generation.load() != session_generation) {
        return;
    }

    if (app.server == nullptr) {
        return;
    }

    app.server->get_io_service().post(
        [
            server = app.server,
            session,
            hdl_copy = session->hdl,
            payload,
            session_generation
        ]() {
            if (session->session_generation.load() != session_generation) {
                return;
            }

            websocketpp::lib::error_code ec;

            server->send(
                hdl_copy,
                payload,
                websocketpp::frame::opcode::text,
                ec
            );
        }
    );
}

// ============================================================
// ASR transcription
// ============================================================

static std::string trim_ascii_whitespace(const std::string& text) {
    size_t first = 0;
    size_t last = text.size();

    while (first < last &&
           std::isspace(static_cast<unsigned char>(text[first]))) {
        first++;
    }

    while (last > first &&
           std::isspace(static_cast<unsigned char>(text[last - 1]))) {
        last--;
    }

    return text.substr(first, last - first);
}

static void replace_all(
    std::string& text,
    const std::string& from,
    const std::string& to
) {
    if (from.empty()) {
        return;
    }

    size_t pos = 0;

    while ((pos = text.find(from, pos)) != std::string::npos) {
        text.replace(pos, from.size(), to);
        pos += to.size();
    }
}

static std::string remove_model_markers(std::string text) {
    replace_all(text, "[_EOT_]", " ");
    replace_all(text, "[_eot_]", " ");
    replace_all(text, "[_ئەئوت_]", " ");
    replace_all(text, "[ _ ئەئوت _ ]", " ");

    std::string normalized;
    bool previous_space = false;

    for (unsigned char ch : text) {
        if (std::isspace(ch)) {
            if (!previous_space) {
                normalized.push_back(' ');
            }

            previous_space = true;
            continue;
        }

        normalized.push_back(static_cast<char>(ch));
        previous_space = false;
    }

    return trim_ascii_whitespace(normalized);
}

static bool env_var_enabled(const char* name) {
    const char* value = std::getenv(name);

    if (value == nullptr) {
        return false;
    }

    std::string text(value);
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });

    return text == "1" || text == "true" || text == "yes" || text == "on";
}

static int env_var_int(
    const char* name,
    int default_value,
    int min_value,
    int max_value
) {
    const char* value = std::getenv(name);

    if (value == nullptr) {
        return default_value;
    }

    try {
        const int parsed = std::stoi(value);
        return std::clamp(parsed, min_value, max_value);
    } catch (...) {
        return default_value;
    }
}

static std::string env_var_string(
    const char* name,
    const std::string& default_value
) {
    const char* value = std::getenv(name);

    if (value == nullptr || value[0] == '\0') {
        return default_value;
    }

    return std::string(value);
}

static std::string model_mode_from_path(const std::string& path) {
    std::string file_name =
        std::filesystem::path(path).filename().string();

    std::transform(file_name.begin(), file_name.end(), file_name.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });

    if (file_name == "whisper-small-q5_0.bin") {
        return "non-uyghur";
    }

    if (file_name == "whisper-small-uyghur-q5_0.bin") {
        return "fast";
    }

    return "normal";
}

static bool json_number_value(
    const std::string& payload,
    const std::string& key,
    float& out
) {
    const std::string needle = "\"" + key + "\"";
    size_t pos = payload.find(needle);

    if (pos == std::string::npos) {
        return false;
    }

    pos = payload.find(':', pos + needle.size());

    if (pos == std::string::npos) {
        return false;
    }

    pos = payload.find_first_of("-+0123456789.", pos + 1);

    if (pos == std::string::npos) {
        return false;
    }

    size_t end = pos;

    while (end < payload.size() &&
           (std::isdigit(static_cast<unsigned char>(payload[end])) ||
            payload[end] == '-' ||
            payload[end] == '+' ||
            payload[end] == '.' ||
            payload[end] == 'e' ||
            payload[end] == 'E')) {
        ++end;
    }

    try {
        out = std::stof(payload.substr(pos, end - pos));
        return true;
    } catch (...) {
        return false;
    }
}

static std::string json_unescape(const std::string& value) {
    std::string out;
    out.reserve(value.size());

    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] != '\\' || i + 1 >= value.size()) {
            out.push_back(value[i]);
            continue;
        }

        const char escaped = value[++i];
        switch (escaped) {
            case '"': out.push_back('"'); break;
            case '\\': out.push_back('\\'); break;
            case '/': out.push_back('/'); break;
            case 'b': out.push_back('\b'); break;
            case 'f': out.push_back('\f'); break;
            case 'n': out.push_back('\n'); break;
            case 'r': out.push_back('\r'); break;
            case 't': out.push_back('\t'); break;
            default:
                out.push_back(escaped);
                break;
        }
    }

    return out;
}

static std::string json_string_value(
    const std::string& payload,
    const std::string& key
) {
    const std::string needle = "\"" + key + "\"";
    size_t pos = payload.find(needle);

    if (pos == std::string::npos) {
        return {};
    }

    pos = payload.find(':', pos + needle.size());
    if (pos == std::string::npos) {
        return {};
    }

    pos = payload.find('"', pos + 1);
    if (pos == std::string::npos) {
        return {};
    }

    std::string raw;
    bool escaped = false;

    for (size_t i = pos + 1; i < payload.size(); ++i) {
        const char ch = payload[i];

        if (!escaped && ch == '"') {
            return json_unescape(raw);
        }

        raw.push_back(ch);
        escaped = !escaped && ch == '\\';
        if (ch != '\\') {
            escaped = false;
        }
    }

    return {};
}

static std::string normalize_whisper_language(std::string language) {
    std::transform(language.begin(), language.end(), language.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });

    if (language == "ug") {
        return "uz";
    }

    if (language.empty() || language == "auto") {
        return "auto";
    }

    if (whisper_lang_id(language.c_str()) < 0) {
        log_stage("Unsupported ASR language '" + language + "', falling back to auto");
        return "auto";
    }

    return language;
}

static RuntimeSettings runtime_settings_from_start_payload(
    const std::string& payload
) {
    RuntimeSettings settings;
    float max_unconfirmed_sec = DEFAULT_MAX_UNCONFIRMED_SEC;
    const std::string language = json_string_value(payload, "asrLanguageCode");

    if (!language.empty()) {
        settings.language = normalize_whisper_language(language);
    }

    if (json_number_value(payload, "maxUnconfirmedSec", max_unconfirmed_sec)) {
        settings.max_unconfirmed_sec = std::clamp(
            max_unconfirmed_sec,
            MIN_MAX_UNCONFIRMED_SEC,
            MAX_MAX_UNCONFIRMED_SEC
        );
    }

    return settings;
}

static std::string lower_ascii(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });

    return text;
}

static bool contains_ascii_ci(
    const std::string& text,
    const std::string& needle
) {
    return lower_ascii(text).find(lower_ascii(needle)) != std::string::npos;
}

static const char* requested_backend_name(RequestedBackend backend) {
    switch (backend) {
    case RequestedBackend::Cpu:
        return "CPU";
    case RequestedBackend::Metal:
        return "Metal";
    case RequestedBackend::Vulkan:
        return "Vulkan";
    case RequestedBackend::Cuda:
        return "CUDA";
    case RequestedBackend::Auto:
    default:
        return "Auto";
    }
}

static RequestedBackend parse_requested_backend_text(const std::string& text) {
    const std::string value = lower_ascii(text);

    if (value == "cpu") {
        return RequestedBackend::Cpu;
    }

    if (value == "metal" || value == "mtl") {
        return RequestedBackend::Metal;
    }

    if (value == "vulkan") {
        return RequestedBackend::Vulkan;
    }

    if (value == "cuda" || value == "nvidia") {
        return RequestedBackend::Cuda;
    }

    return RequestedBackend::Auto;
}

static RequestedBackend requested_backend_from_runtime(
    const char* executable_name
) {
    const char* configured_backend = std::getenv("UGASR_REQUIRED_BACKEND");

    if (configured_backend == nullptr || configured_backend[0] == '\0') {
        configured_backend = std::getenv("UGASR_BACKEND");
    }

    if (configured_backend != nullptr && configured_backend[0] != '\0') {
        return parse_requested_backend_text(configured_backend);
    }

    if (executable_name != nullptr) {
        const std::string exe_name = lower_ascii(executable_name);

        if (exe_name == "asr-cuda.exe" || exe_name == "asr-cuda") {
            return RequestedBackend::Cuda;
        }

        if (exe_name == "asr-vulkan.exe" || exe_name == "asr-vulkan") {
            return RequestedBackend::Vulkan;
        }

#if defined(_WIN32)
        if (exe_name == "asr.exe") {
            return RequestedBackend::Cpu;
        }
#endif
    }

    return RequestedBackend::Auto;
}

static std::string backend_label_from_runtime(const char* executable_name) {
    const char* value = std::getenv("UGASR_BACKEND_LABEL");

    if (value != nullptr) {
        std::string label(value);

        if (!label.empty()) {
            return label;
        }
    }

    if (executable_name != nullptr) {
        const std::string exe_name(executable_name);

        if (exe_name == "ASR-cuda.exe" || exe_name == "ASR-cuda") {
            return "CUDA";
        }

        if (exe_name == "ASR-vulkan.exe" || exe_name == "ASR-vulkan") {
            return "Vulkan";
        }
    }

    return "Auto";
}

static bool is_gpu_device_type(enum ggml_backend_dev_type type) {
    return type == GGML_BACKEND_DEVICE_TYPE_GPU ||
           type == GGML_BACKEND_DEVICE_TYPE_IGPU;
}

static const char* backend_device_type_name(enum ggml_backend_dev_type type) {
    switch (type) {
    case GGML_BACKEND_DEVICE_TYPE_CPU:
        return "CPU";
    case GGML_BACKEND_DEVICE_TYPE_GPU:
        return "GPU";
    case GGML_BACKEND_DEVICE_TYPE_IGPU:
        return "iGPU";
    case GGML_BACKEND_DEVICE_TYPE_ACCEL:
        return "Accelerator";
    default:
        return "Unknown";
    }
}

static std::string safe_cstr(const char* text) {
    return text != nullptr ? std::string(text) : std::string();
}

static std::string backend_reg_name_for_device(ggml_backend_dev_t dev) {
    if (dev == nullptr) {
        return "";
    }

    ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);

    return reg != nullptr ? safe_cstr(ggml_backend_reg_name(reg)) : "";
}

static bool device_matches_requested_backend(
    ggml_backend_dev_t dev,
    RequestedBackend backend
) {
    if (dev == nullptr) {
        return false;
    }

    const enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
    const std::string dev_name = safe_cstr(ggml_backend_dev_name(dev));
    const std::string reg_name = backend_reg_name_for_device(dev);

    switch (backend) {
    case RequestedBackend::Cpu:
        return type == GGML_BACKEND_DEVICE_TYPE_CPU;
    case RequestedBackend::Metal:
        return is_gpu_device_type(type) &&
               (contains_ascii_ci(reg_name, "metal") ||
                contains_ascii_ci(reg_name, "mtl") ||
                contains_ascii_ci(dev_name, "metal") ||
                contains_ascii_ci(dev_name, "mtl"));
    case RequestedBackend::Vulkan:
        return is_gpu_device_type(type) &&
               (contains_ascii_ci(reg_name, "vulkan") ||
                contains_ascii_ci(dev_name, "vulkan"));
    case RequestedBackend::Cuda:
        return is_gpu_device_type(type) &&
               (contains_ascii_ci(reg_name, "cuda") ||
                contains_ascii_ci(dev_name, "cuda"));
    case RequestedBackend::Auto:
    default:
        return true;
    }
}

static int gpu_device_ordinal_for_backend(RequestedBackend backend) {
    int gpu_ordinal = 0;

    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        const enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);

        if (!is_gpu_device_type(type)) {
            continue;
        }

        if (device_matches_requested_backend(dev, backend)) {
            return gpu_ordinal;
        }

        gpu_ordinal++;
    }

    return -1;
}

static bool has_backend(RequestedBackend backend) {
    if (backend == RequestedBackend::Auto) {
        return true;
    }

    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);

        if (device_matches_requested_backend(dev, backend)) {
            return true;
        }
    }

    return false;
}

static void log_registered_backends() {
    log_stage(
        "Registered backend count: " +
        std::to_string(ggml_backend_reg_count())
    );

    for (size_t i = 0; i < ggml_backend_reg_count(); ++i) {
        ggml_backend_reg_t reg = ggml_backend_reg_get(i);

        log_stage(
            "Backend registry[" + std::to_string(i) + "]: " +
            safe_cstr(ggml_backend_reg_name(reg)) +
            ", devices=" + std::to_string(ggml_backend_reg_dev_count(reg))
        );
    }

    log_stage(
        "Registered device count: " +
        std::to_string(ggml_backend_dev_count())
    );

    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);

        log_stage(
            "Device[" + std::to_string(i) + "]: name=" +
            safe_cstr(ggml_backend_dev_name(dev)) +
            ", reg=" + backend_reg_name_for_device(dev) +
            ", type=" + backend_device_type_name(ggml_backend_dev_type(dev)) +
            ", desc=" + safe_cstr(ggml_backend_dev_description(dev))
        );
    }
}

static void load_backend_plugins_for_request(RequestedBackend backend) {
#if defined(_WIN32)
    if (backend == RequestedBackend::Cpu || env_var_enabled("UGASR_LOAD_BACKENDS")) {
        log_stage("Loading ggml backend plugins from current directory");
        ggml_backend_load_all_from_path(".");
    } else {
        log_stage(
            "Skipping ggml plugin auto-load for " +
            std::string(requested_backend_name(backend)) +
            " to avoid mixed backend DLL loading"
        );
    }
#else
    if (env_var_enabled("UGASR_LOAD_BACKENDS")) {
        log_stage("Loading ggml backend plugins from current directory");
        ggml_backend_load_all_from_path(".");
    }
#endif
}

static whisper_context* load_whisper_model(
    const std::string& model_path,
    RequestedBackend backend
) {
    whisper_context_params wctx_params =
        whisper_context_default_params();

    wctx_params.use_gpu = backend != RequestedBackend::Cpu;

    if (backend == RequestedBackend::Cuda ||
        backend == RequestedBackend::Metal ||
        backend == RequestedBackend::Vulkan) {
        const int gpu_ordinal = gpu_device_ordinal_for_backend(backend);

        if (gpu_ordinal < 0) {
            log_stage(
                std::string("Requested backend not available: ") +
                requested_backend_name(backend)
            );
            return nullptr;
        }

        wctx_params.gpu_device = gpu_ordinal;
    }

    log_stage(
        "Loading ASR model with requested backend " +
        std::string(requested_backend_name(backend)) +
        ", use_gpu=" +
        (wctx_params.use_gpu ? std::string("true") : std::string("false")) +
        ", gpu_device=" + std::to_string(wctx_params.gpu_device) +
        ": " + model_path
    );

    whisper_context* ctx = whisper_init_from_file_with_params(
        model_path.c_str(),
        wctx_params
    );

    log_stage(
        std::string("ASR model load ") +
        (ctx != nullptr ? "succeeded" : "failed") +
        " for backend " + requested_backend_name(backend)
    );

    return ctx;
}

static std::string transcribe_pcm_with_whisper(
    whisper_context* wctx,
    const std::vector<float>& pcm,
    int sample_rate,
    int n_threads,
    const std::string& language,
    int greedy_best_of = 1,
    bool no_context = false
) {
    if (sample_rate != 16000) {
        return "[ERROR] ASR expects 16000 Hz audio";
    }

    if (pcm.empty()) {
        return "";
    }

    whisper_full_params wparams =
        whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

    wparams.print_progress = false;
    wparams.print_special = false;
    wparams.print_realtime = false;

    wparams.print_timestamps = false;
    wparams.no_timestamps = true;

    wparams.translate = false;

    const std::string whisper_language = normalize_whisper_language(language);
    wparams.language =
        whisper_language == "auto" ? nullptr : whisper_language.c_str();

    wparams.strategy = WHISPER_SAMPLING_GREEDY;
    wparams.greedy.best_of = greedy_best_of;
    wparams.n_threads = n_threads;

    // Important: do not override this later.
    wparams.no_context = no_context;

    log_stage(
        "ASR inference begin: samples=" + std::to_string(pcm.size()) +
        ", threads=" + std::to_string(n_threads) +
        ", language=" + whisper_language +
        ", best_of=" + std::to_string(greedy_best_of) +
        ", no_context=" + (no_context ? std::string("true") : std::string("false"))
    );

    int ret = whisper_full(
        wctx,
        wparams,
        pcm.data(),
        static_cast<int>(pcm.size())
    );

    log_stage("ASR inference end: ret=" + std::to_string(ret));

    if (ret != 0) {
        return "[ERROR] ASR inference failed";
    }

    const int n_segments = whisper_full_n_segments(wctx);

    if (n_segments <= 0) {
        return "";
    }

    std::ostringstream result;

    for (int i = 0; i < n_segments; ++i) {
        const char* text = whisper_full_get_segment_text(wctx, i);

        if (text) {
            result << text;
        }
    }

    return result.str();
}

static std::string convert_model_text(
    umsc& converter,
    const std::string& text
) {
    const std::string safe = sanitize_utf8(text);

    try {
        return converter.convert(safe);
    } catch (const std::exception& err) {
        log_stage(std::string("Text conversion failed: ") + err.what());
        return safe;
    }
}

static bool confirm_audio_part(
    AppState& app,
    const std::shared_ptr<ClientSession>& session,
    std::uint64_t session_generation,
    std::uint64_t start_samples,
    const std::vector<float>& audio,
    whisper_context* wctx,
    umsc& converter,
    int n_threads,
    const RuntimeSettings& runtime_settings
) {
    if (audio.empty()) {
        return false;
    }

    log_stage(
        "confirm_audio_part begin: samples=" + std::to_string(audio.size()) +
        ", start_samples=" + std::to_string(start_samples)
    );

    std::string confirmed =
        transcribe_pcm_with_whisper(
            wctx,
            audio,
            TARGET_SAMPLE_RATE,
            n_threads,
            runtime_settings.language,
            runtime_settings.confirm_best_of,
            // false // if true have some problems, set to true
            true
        );

    confirmed = remove_model_markers(
        runtime_settings.convert_uyghur_script
            ? convert_model_text(converter, confirmed)
            : sanitize_utf8(confirmed)
    );

    if (!is_current_session(*session, session_generation)) {
        return false;
    }

    const std::uint64_t end_samples =
        start_samples + static_cast<std::uint64_t>(audio.size());

    if (!confirmed.empty()) {
        session->transcription.confirmed_texts.push_back(confirmed);
        send_payload_for_session(
            app,
            session,
            session_generation,
            make_segment_json(
                confirmed,
                start_samples * 1000 / TARGET_SAMPLE_RATE,
                end_samples * 1000 / TARGET_SAMPLE_RATE
            )
        );

        send_json_for_session(
            app,
            session,
            session_generation,
            "confirmed",
            confirmed
        );
    }

    session->transcription.last_confirmed =
        session->transcription.counter;

    session->transcription.counter++;
    session->transcription.confirmed_samples =
        std::max(session->transcription.confirmed_samples, end_samples);

    return true;
}

// ============================================================
// Keep only audio that has not been confirmed yet.
// ============================================================

static void keep_remaining_as_unconfirmed(
    AppState& app,
    const std::shared_ptr<ClientSession>& session,
    std::uint64_t session_generation,
    size_t confirmed_sample_count
) {
    if (!is_current_session(*session, session_generation)) {
        return;
    }

    std::vector<whisper_vad_segment> remaining_segments;
    size_t offset = 0;

    for (const auto& seg : session->vad_segments) {
        const size_t seg_start = offset;
        const size_t seg_end = seg_start + seg.segment.size();
        offset = seg_end;

        if (seg_end <= confirmed_sample_count) {
            continue;
        }

        if (seg_start >= confirmed_sample_count) {
            remaining_segments.push_back(seg);
            continue;
        }

        const size_t keep_from = confirmed_sample_count - seg_start;

        if (keep_from >= seg.segment.size()) {
            continue;
        }

        whisper_vad_segment trimmed;
        trimmed.segment.assign(
            seg.segment.begin() + keep_from,
            seg.segment.end()
        );
        trimmed.is_speech = seg.is_speech;
        trimmed.start_sample = seg.start_sample + keep_from;

        // A preview for a partly confirmed chunk may contain text from the
        // confirmed side, so do not reuse it as gray text.
        trimmed.preview_text.clear();

        remaining_segments.push_back(std::move(trimmed));
    }

    session->vad_segments = std::move(remaining_segments);
    session->transcription.unconfirmed_texts.clear();
    session->transcription.unconfirmed_text_indices.clear();

    send_json_for_session(
        app,
        session,
        session_generation,
        "unconfirmed",
        build_unconfirmed_from_vad_segments(session->vad_segments)
    );
}

// ============================================================
// Process one 16 kHz audio chunk
// ============================================================

static void release_vad_segments_for_backend(
    whisper_vad_segments*& segs,
    int n_segments,
    const PreviewSettings& preview_settings,
    const char* label
) {
    if (segs == nullptr) {
        return;
    }

    if (preview_settings.skip_speech_vad_segment_release && n_segments > 0) {
        log_stage(
            std::string("Skipping ") + label +
            " release for Windows GPU backend stability"
        );
        segs = nullptr;
        return;
    }

    whisper_vad_free_segments(segs);
    segs = nullptr;
    log_stage(std::string(label) + " released");
}

static void process_chunk_16k(
    AppState& app,
    const std::shared_ptr<ClientSession>& session,
    std::uint64_t session_generation,
    const std::vector<float>& chunk,
    whisper_vad_context* vctx,
    whisper_vad_params& vad_params,
    whisper_context* wctx,
    whisper_context* preview_wctx,
    umsc& converter,
    int n_threads,
    const RuntimeSettings& runtime_settings,
    const PreviewSettings& preview_settings
) {
    if (chunk.empty() || !is_current_session(*session, session_generation)) {
        return;
    }

    const AudioLevel chunk_level = compute_audio_level(chunk);

    log_stage(
        "process_chunk_16k begin: samples=" + std::to_string(chunk.size()) +
        ", " + audio_level_summary(chunk_level) +
        ", preview_enabled=" + (
            preview_settings.enabled ? std::string("true") : std::string("false")
        ) +
        ", model_mode=" + runtime_settings.model_mode +
        ", max_unconfirmed_sec=" +
        std::to_string(runtime_settings.max_unconfirmed_sec)
    );

    const std::uint64_t chunk_start_sample =
        session->transcription.next_input_sample;
    session->transcription.next_input_sample +=
        static_cast<std::uint64_t>(chunk.size());

    if (chunk.size() < CHUNK_SAMPLES) {
        log_stage("process_chunk_16k: partial chunk");
        whisper_vad_segment cur_seg;
        cur_seg.is_speech = true;
        cur_seg.segment = chunk;
        cur_seg.start_sample = chunk_start_sample;

        session->vad_segments.push_back(std::move(cur_seg));
        session->transcription.counter++;
        return;
    }

    whisper_vad_segments* segs =
        whisper_vad_segments_from_samples(
            vctx,
            vad_params,
            chunk.data(),
            chunk.size()
        );

    int n = 0;

    if (segs == nullptr) {
        log_stage(
            "VAD failed for " + std::to_string(chunk.size()) +
            " samples; treating as silence"
        );
    } else {
        n = whisper_vad_segments_n_segments(segs);
        log_stage("VAD segments=" + std::to_string(n));
    }

    const bool speech_energy_fallback = n == 0 && has_speech_energy(chunk_level);

    if (speech_energy_fallback) {
        log_stage(
            "VAD returned no speech, using energy fallback: " +
            audio_level_summary(chunk_level)
        );
    }

    const auto release_current_vad_segments = [&]() {
        if (speech_energy_fallback && n == 0) {
            log_stage("Skipping empty VAD segment release after energy fallback");
            segs = nullptr;
            return;
        }

        release_vad_segments_for_backend(
            segs,
            n,
            preview_settings,
            "VAD segments"
        );
    };

    if (!is_current_session(*session, session_generation)) {
        release_current_vad_segments();
        return;
    }

    release_current_vad_segments();

    if (n == 0 && !speech_energy_fallback) {
        whisper_vad_segment cur_seg;
        cur_seg.is_speech = false;
        cur_seg.segment = chunk;
        cur_seg.start_sample = chunk_start_sample;

        session->vad_segments.push_back(std::move(cur_seg));
        session->transcription.counter++;
    } else {
        whisper_vad_segment cur_seg;
        cur_seg.is_speech = true;
        cur_seg.segment = chunk;
        cur_seg.start_sample = chunk_start_sample;

        session->vad_segments.push_back(std::move(cur_seg));
        session->transcription.counter++;

        if (preview_settings.enabled) {
            log_stage("preview transcription begin");
            std::string preview = transcribe_pcm_with_whisper(
                preview_wctx,
                chunk,
                TARGET_SAMPLE_RATE,
                n_threads,
                runtime_settings.language,
                runtime_settings.preview_best_of,
                true
            );

            preview = runtime_settings.convert_uyghur_script
                ? convert_model_text(converter, preview)
                : sanitize_utf8(preview);
            log_stage("preview transcription end: text_len=" + std::to_string(preview.size()));

            if (!is_current_session(*session, session_generation)) {
                return;
            }

            if (!preview.empty()) {
                session->vad_segments.back().preview_text = preview;
                session->transcription.unconfirmed_texts.push_back(preview);
                session->transcription.unconfirmed_text_indices.push_back(
                    session->transcription.counter - 1
                );
            }

            send_json_for_session(
                app,
                session,
                session_generation,
                "unconfirmed",
                build_unconfirmed_from_vad_segments(session->vad_segments)
            );
            log_stage("sent unconfirmed preview");
            log_stage("post-preview flow continues");
        }
    }

    // If all buffered chunks are silence, keep only one recent silence chunk.
    if (check_if_all_silence(session->vad_segments)) {
        log_stage("buffer is all silence");
        if (session->vad_segments.size() > 1) {
            session->vad_segments.erase(
                session->vad_segments.begin(),
                session->vad_segments.end() - 1
            );
        }

        return;
    }

    if (has_two_trailing_silences_after_speech(session->vad_segments)) {
        log_stage("finalizing on trailing silence");
        std::vector<float> combined_segment;
        const std::uint64_t combined_start_sample =
            session->vad_segments.front().start_sample;

        for (const auto& seg : session->vad_segments) {
            combined_segment.insert(
                combined_segment.end(),
                seg.segment.begin(),
                seg.segment.end()
            );
        }

        const size_t last_silence_samples =
            session->vad_segments.back().segment.size();

        const size_t confirmed_sample_count =
            combined_segment.size() - last_silence_samples;

        std::vector<float> first_part(
            combined_segment.begin(),
            combined_segment.begin() + confirmed_sample_count
        );

        if (!confirm_audio_part(
            app,
            session,
            session_generation,
            combined_start_sample,
            first_part,
            wctx,
            converter,
            n_threads,
            runtime_settings
        )) {
            return;
        }

        keep_remaining_as_unconfirmed(
            app,
            session,
            session_generation,
            confirmed_sample_count
        );
        log_stage("kept remaining as unconfirmed");
        return;
    }

    // Need at least two speech parts before checking a split gap.
    if (get_speech_count(session->vad_segments) <= 1) {
        log_stage("not enough speech yet");
        return;
    }

    std::vector<float> combined_segment;
    const std::uint64_t combined_start_sample =
        session->vad_segments.front().start_sample;

    for (const auto& seg : session->vad_segments) {
        combined_segment.insert(
            combined_segment.end(),
            seg.segment.begin(),
            seg.segment.end()
        );
    }

    whisper_vad_segments* segs_whole =
        whisper_vad_segments_from_samples(
            vctx,
            vad_params,
            combined_segment.data(),
            combined_segment.size()
        );

    size_t last_idx = 0;
    float last_sec = 0.0f;
    bool did_split = false;

    if (segs_whole != nullptr) {
        int n_whole = whisper_vad_segments_n_segments(segs_whole);
        log_stage("VAD whole-buffer segments=" + std::to_string(n_whole));

        for (int i = 1; i < n_whole; ++i) {
            int curr_t0_cs =
                whisper_vad_segments_get_segment_t0(segs_whole, i);

            int prev_t1_cs =
                whisper_vad_segments_get_segment_t1(segs_whole, i - 1);

            float curr_t0_sec = curr_t0_cs / 100.0f;
            float prev_t1_sec = prev_t1_cs / 100.0f;

            float gap_sec = curr_t0_sec - prev_t1_sec;
            float middle_sec = (prev_t1_sec + curr_t0_sec) / 2.0f;

            log_stage("gap: " + std::to_string(gap_sec) + " sec");

            // Split if silence gap is big enough,
            // and avoid very short confirmed pieces.
            if (gap_sec > GAP_THRESHOLD_SEC &&
                (middle_sec - last_sec) > MIN_CONFIRMED_SEC) {

                size_t split_sample_idx =
                    static_cast<size_t>(middle_sec * TARGET_SAMPLE_RATE);

                if (split_sample_idx <= last_idx ||
                    split_sample_idx >= combined_segment.size()) {
                    continue;
                }

                std::vector<float> first_part(
                    combined_segment.begin() + last_idx,
                    combined_segment.begin() + split_sample_idx
                );

                if (!confirm_audio_part(
                    app,
                    session,
                    session_generation,
                    combined_start_sample + last_idx,
                    first_part,
                    wctx,
                    converter,
                    n_threads,
                    runtime_settings
                )) {
                    release_vad_segments_for_backend(
                        segs_whole,
                        n_whole,
                        preview_settings,
                        "VAD whole-buffer segments"
                    );
                    return;
                }

                last_idx = split_sample_idx;
                last_sec = middle_sec;
                did_split = true;
                log_stage("split at sample " + std::to_string(split_sample_idx));
            }
        }

        release_vad_segments_for_backend(
            segs_whole,
            n_whole,
            preview_settings,
            "VAD whole-buffer segments"
        );
    } else {
        log_stage("VAD failed for buffered audio; using max-buffer split fallback.");
    }

    if (!did_split) {
        const size_t max_unconfirmed_samples =
            static_cast<size_t>(
                runtime_settings.max_unconfirmed_sec * TARGET_SAMPLE_RATE
            );

        if (combined_segment.size() >= max_unconfirmed_samples) {
            log_stage("max-buffer split fallback");
            std::vector<float> first_part(
                combined_segment.begin(),
                combined_segment.begin() + max_unconfirmed_samples
            );

            if (!confirm_audio_part(
                app,
                session,
                session_generation,
                combined_start_sample,
                first_part,
                wctx,
                converter,
                n_threads,
                runtime_settings
            )) {
                return;
            }

            last_idx = max_unconfirmed_samples;
            did_split = true;
        }
    }

    if (did_split) {
        if (last_idx < combined_segment.size()) {
            keep_remaining_as_unconfirmed(
                app,
                session,
                session_generation,
                last_idx
            );
        } else {
            session->vad_segments.clear();
            session->transcription.unconfirmed_texts.clear();
            session->transcription.unconfirmed_text_indices.clear();

            send_json_for_session(
                app,
                session,
                session_generation,
                "unconfirmed",
                ""
            );
        }
    }
}

// ============================================================
// Finalize remaining buffered audio after user presses Stop
// ============================================================

static void finalize_remaining_audio(
    AppState& app,
    const std::shared_ptr<ClientSession>& session,
    std::uint64_t session_generation,
    whisper_context* wctx,
    umsc& converter,
    int n_threads,
    const RuntimeSettings& runtime_settings
) {
    if (!is_current_session(*session, session_generation)) {
        return;
    }

    if (session->vad_segments.empty()) {
        send_json_for_session(app, session, session_generation, "unconfirmed", "");
        send_json_for_session(app, session, session_generation, "status", "stopped");
        return;
    }

    if (check_if_all_silence(session->vad_segments)) {
        session->vad_segments.clear();
        session->transcription.unconfirmed_texts.clear();
        session->transcription.unconfirmed_text_indices.clear();

        send_json_for_session(app, session, session_generation, "unconfirmed", "");
        send_json_for_session(app, session, session_generation, "status", "stopped");
        return;
    }

    std::vector<float> combined_segment;
    const std::uint64_t combined_start_sample =
        session->vad_segments.front().start_sample;

    for (const auto& seg : session->vad_segments) {
        combined_segment.insert(
            combined_segment.end(),
            seg.segment.begin(),
            seg.segment.end()
        );
    }

    if (!confirm_audio_part(
        app,
        session,
        session_generation,
        combined_start_sample,
        combined_segment,
        wctx,
        converter,
        n_threads,
        runtime_settings
    )) {
        return;
    }

    session->vad_segments.clear();
    session->transcription.unconfirmed_texts.clear();
    session->transcription.unconfirmed_text_indices.clear();

    send_json_for_session(app, session, session_generation, "unconfirmed", "");
    send_json_for_session(app, session, session_generation, "status", "stopped");
}

// ============================================================
// Worker thread
// ============================================================

static void worker_loop(
    AppState& app,
    std::shared_ptr<ClientSession> session,
    whisper_vad_context* vctx,
    whisper_vad_params& vad_params,
    umsc& converter,
    int n_threads,
    PreviewSettings preview_settings
) {
    while (true) {
        std::vector<float> chunk;
        std::uint64_t chunk_session_generation = 0;

        log_stage("worker waiting");

        AudioQueue::PopResult result =
            session->audio_queue.pop(
                chunk,
                CHUNK_SAMPLES,
                chunk_session_generation
            );

        if (result == AudioQueue::PopResult::Shutdown) {
            log_stage("worker shutdown");
            break;
        }

        try {
            if (result == AudioQueue::PopResult::Chunk) {
                log_stage("worker got chunk");
                std::lock_guard<std::mutex> lock(app.processing_mutex);

	                process_chunk_16k(
	                    app,
                        session,
	                    chunk_session_generation,
	                    chunk,
	                    vctx,
	                    vad_params,
	                    app.whisper_model.ctx,
	                    app.whisper_model.ctx,
	                    converter,
	                    n_threads,
	                    session->runtime_settings,
	                    preview_settings
                );
            }

            if (result == AudioQueue::PopResult::StopRequested) {
                log_stage("worker got stop request");
                std::lock_guard<std::mutex> lock(app.processing_mutex);

                if (!chunk.empty()) {
	                    process_chunk_16k(
	                        app,
                            session,
	                        chunk_session_generation,
	                        chunk,
	                        vctx,
	                        vad_params,
	                        app.whisper_model.ctx,
	                        app.whisper_model.ctx,
	                        converter,
	                        n_threads,
	                        session->runtime_settings,
	                        preview_settings
                    );
                }

	                finalize_remaining_audio(
	                    app,
                        session,
	                    chunk_session_generation,
	                    app.whisper_model.ctx,
	                    converter,
	                    n_threads,
	                    session->runtime_settings
                );
            }
        } catch (const std::exception& err) {
            log_stage(std::string("ASR worker error: ") + err.what());

            session->recording = false;
            session->audio_queue.reset();
            send_json(app, session, "status", "model error");
        } catch (...) {
            log_stage("ASR worker error: unknown exception");

            session->recording = false;
            session->audio_queue.reset();
            send_json(app, session, "status", "model error");
        }
    }
}

// ============================================================
// Main
// ============================================================

int main(int argc, char** argv) {
    whisper_log_set(whisper_log_callback_silent, nullptr);

    const std::string executable_name =
        (argc > 0 && argv != nullptr && argv[0] != nullptr)
            ? std::filesystem::path(argv[0]).filename().string()
            : std::string();

    RequestedBackend requested_backend =
        requested_backend_from_runtime(
            executable_name.empty() ? nullptr : executable_name.c_str()
        );

    if (env_var_enabled("UGASR_DISABLE_GPU")) {
        requested_backend = RequestedBackend::Cpu;
    }

    log_stage(
        "Executable: " +
        (executable_name.empty() ? std::string("(unknown)") : executable_name)
    );
    log_stage(
        "Requested backend: " +
        std::string(requested_backend_name(requested_backend))
    );

    load_backend_plugins_for_request(requested_backend);
    log_registered_backends();

    const std::string vad_model_path =
        env_var_string("UGASR_HELPER_MODEL_PATH", "./silero-v6.2.1-ggml.bin");

    const std::string whisper_model_path =
        env_var_string(
            "UGASR_WHISPER_MODEL_PATH",
            env_var_string("UGASR_UYGHUR_MODEL_PATH", "./whisper-small-uyghur-q5_0.bin")
        );
    const std::string whisper_model_family =
        env_var_string("UGASR_ASR_MODEL_FAMILY", "uyghur");

    umsc converter("ULS", "UAS");
    const int n_threads =
        env_var_int("UGASR_CPU_THREADS", 8, 1, 16);

    PreviewSettings preview_settings;
    preview_settings.enabled =
        !env_var_enabled("UGASR_DISABLE_PREVIEW");

#if defined(_WIN32)
    preview_settings.skip_speech_vad_segment_release =
        requested_backend == RequestedBackend::Vulkan ||
        requested_backend == RequestedBackend::Cuda;

    if (preview_settings.skip_speech_vad_segment_release) {
        log_stage("Windows GPU VAD speech segment release workaround enabled");
    }
#endif

    // ---------------- VAD ----------------

    whisper_vad_context_params vad_ctx_params =
        whisper_vad_default_context_params();

    vad_ctx_params.n_threads = n_threads;
    vad_ctx_params.use_gpu = false;

    whisper_vad_context* vctx =
        whisper_vad_init_from_file_with_params(
            vad_model_path.c_str(),
            vad_ctx_params
        );

    if (!vctx) {
        log_stage("Failed to load VAD model: " + vad_model_path);
        return 1;
    }

    whisper_vad_params vad_params =
        whisper_vad_default_params();

    vad_params.threshold = 0.50f;
    vad_params.min_speech_duration_ms = 250;
    vad_params.min_silence_duration_ms = 300;

    // ---------------- ASR model ----------------

    const bool require_gpu = env_var_enabled("UGASR_REQUIRE_GPU");
    if (!has_backend(requested_backend)) {
        log_stage(
            "Required backend is unavailable: " +
            std::string(requested_backend_name(requested_backend))
        );

        whisper_vad_free(vctx);
        return 2;
    }

    if (require_gpu &&
        requested_backend == RequestedBackend::Auto &&
        gpu_device_ordinal_for_backend(RequestedBackend::Auto) < 0) {
        log_stage("GPU backend is required, but no GPU backend is available.");

        whisper_vad_free(vctx);
        return 2;
    }

    whisper_context* wctx =
        load_whisper_model(whisper_model_path, requested_backend);

    if (!wctx &&
        requested_backend == RequestedBackend::Auto &&
        !require_gpu) {
        log_stage("Failed to load ASR model with auto GPU. Retrying with CPU.");
        requested_backend = RequestedBackend::Cpu;
        wctx = load_whisper_model(whisper_model_path, requested_backend);
    } else if (!wctx) {
        log_stage(
            "Failed to load ASR model with required backend " +
            std::string(requested_backend_name(requested_backend))
        );
    }

    if (!wctx) {
        log_stage("Failed to load ASR model");

        whisper_vad_free(vctx);
        return 2;
    }

    log_stage(
        "Preview and confirmation use the same ASR backend: " +
        std::string(requested_backend_name(requested_backend))
    );
    log_stage("ASR model family: " + whisper_model_family);

    const std::string backend_label =
        requested_backend != RequestedBackend::Auto
            ? requested_backend_name(requested_backend)
            : backend_label_from_runtime(
                executable_name.empty() ? nullptr : executable_name.c_str()
              );

    // ---------------- Server ----------------

    AppState app;
    app.whisper_model.ctx = wctx;
    app.whisper_model.mode = model_mode_from_path(whisper_model_path);
    app.whisper_model.path = whisper_model_path;
    app.whisper_model.is_uyghur_model = whisper_model_family != "non-uyghur";
    app.whisper_model.backend = requested_backend;

    server_t server;
    app.server = &server;

    server.clear_access_channels(websocketpp::log::alevel::all);
    server.clear_error_channels(websocketpp::log::elevel::all);

    server.init_asio();
    server.set_reuse_addr(true);

    const std::string launch_id =
        std::getenv("UGASR_SERVER_LAUNCH_ID")
            ? std::getenv("UGASR_SERVER_LAUNCH_ID")
            : "";
    std::atomic<bool> shutdown_requested{false};

    server.set_http_handler([&](connection_hdl hdl) {
        websocketpp::lib::error_code ec;
        auto con = server.get_con_from_hdl(hdl, ec);

        if (ec || !con) {
            return;
        }

        const std::string method = con->get_request().get_method();
        const std::string resource = con->get_resource();

        con->replace_header("Content-Type", "application/json; charset=utf-8");
        con->replace_header("Connection", "close");

        if (method == "GET" && (resource == "/api/health" || resource == "/health")) {
            con->set_status(websocketpp::http::status_code::ok);
            con->set_body(
                "{\"ok\":true"
                ",\"app\":\"ugASR\""
                ",\"service\":\"ASR\""
                ",\"launchId\":\"" + json_escape(launch_id) + "\""
                ",\"model\":\"" + json_escape(app.whisper_model.mode) + "\""
                ",\"backend\":\"" + json_escape(backend_label) + "\""
                "}"
            );
            return;
        }

        if (method == "POST" && resource == "/api/shutdown") {
            con->set_status(websocketpp::http::status_code::ok);
            con->set_body("{\"ok\":true,\"app\":\"ugASR\",\"service\":\"ASR\",\"shuttingDown\":true}");

            if (!shutdown_requested.exchange(true)) {
                std::thread([&server]() {
                    std::this_thread::sleep_for(std::chrono::milliseconds(150));
                    websocketpp::lib::error_code stop_ec;
                    server.stop_listening(stop_ec);
                    server.stop();
                }).detach();
            }
            return;
        }

        con->set_status(websocketpp::http::status_code::not_found);
        con->set_body("{\"error\":\"not found\"}");
    });

    server.set_open_handler([&](connection_hdl hdl) {
        log_stage("websocket open");

        auto session = std::make_shared<ClientSession>();
        session->hdl = hdl;
        session->runtime_settings.model_mode = app.whisper_model.mode;

        {
            std::lock_guard<std::mutex> lock(app.connection_mutex);
            app.sessions[hdl] = session;
        }

        std::thread(
            worker_loop,
            std::ref(app),
            session,
            vctx,
            std::ref(vad_params),
            std::ref(converter),
            n_threads,
            preview_settings
        ).detach();

        log_stage("worker thread started");

        send_json(app, session, "status", "connected");
        send_json(app, session, "backend", backend_label);
        send_json(app, session, "model", app.whisper_model.mode);
    });

    server.set_close_handler([&](connection_hdl hdl) {
        log_stage("websocket close");

        std::shared_ptr<ClientSession> session;

        {
            std::lock_guard<std::mutex> lock(app.connection_mutex);
            auto it = app.sessions.find(hdl);
            if (it != app.sessions.end()) {
                session = it->second;
                app.sessions.erase(it);
            }
        }

        if (!session) {
            return;
        }

        session->recording = false;
        advance_session(*session);
        session->audio_queue.shutdown();

        if (app.processing_mutex.try_lock()) {
            session->vad_segments.clear();
            session->transcription =
                whisper_transcription_segment{};

            app.processing_mutex.unlock();
        }
    });

    server.set_message_handler(
        [&](connection_hdl hdl, server_t::message_ptr msg) {
            std::shared_ptr<ClientSession> session;

            {
                std::lock_guard<std::mutex> lock(app.connection_mutex);
                auto it = app.sessions.find(hdl);
                if (it != app.sessions.end()) {
                    session = it->second;
                }
            }

            if (!session) {
                return;
            }

            const auto opcode = msg->get_opcode();
            const std::string& payload = msg->get_payload();

            if (opcode == websocketpp::frame::opcode::text) {
                log_stage("text message: " + payload);
                if (payload.find("cancel") != std::string::npos) {
                    session->recording = false;
                    advance_session(*session);
                    session->audio_queue.reset();

                    if (app.processing_mutex.try_lock()) {
                        session->vad_segments.clear();
                        session->transcription =
                            whisper_transcription_segment{};

                        app.processing_mutex.unlock();
                    }

                    send_json(app, session, "reset", "");
                    send_json(app, session, "status", "cancelled");
                }
                else if (payload.find("setModel") != std::string::npos) {
                    log_stage("setModel ignored: model selection is app-only");
                    send_json(app, session, "model", app.whisper_model.mode);
                }
                else if (payload.find("start") != std::string::npos) {
                    RuntimeSettings runtime_settings =
                        runtime_settings_from_start_payload(payload);
                    runtime_settings.model_mode = app.whisper_model.mode;
                    runtime_settings.convert_uyghur_script =
                        app.whisper_model.is_uyghur_model;
                    if (app.whisper_model.is_uyghur_model) {
                        runtime_settings.language = "uz";
                    }

                    log_stage("start requested");
                    log_stage(
                        "runtime settings: model_mode=" +
                        runtime_settings.model_mode +
                        ", language=" +
                        runtime_settings.language +
                        ", convert_uyghur_script=" +
                        (runtime_settings.convert_uyghur_script ? "true" : "false") +
                        ", max_unconfirmed_sec=" +
                        std::to_string(runtime_settings.max_unconfirmed_sec) +
                        ", confirm_best_of=" +
                        std::to_string(runtime_settings.confirm_best_of)
                    );
                    advance_session(*session);
                    session->audio_queue.reset();

                    {
                        std::lock_guard<std::mutex> lock(app.processing_mutex);

                        session->vad_segments.clear();
                        session->transcription =
                            whisper_transcription_segment{};
                        session->runtime_settings = runtime_settings;
                    }

                    session->recording = true;
                    send_json(app, session, "reset", "");
                    send_json(app, session, "status", "recording");
                }
                else if (payload.find("stop") != std::string::npos) {
                    log_stage("stop requested");
                    session->recording = false;

                    send_json(app, session, "status", "processing remaining audio");

                    session->audio_queue.request_stop(
                        session->session_generation.load()
                    );
                }

                return;
            }

            if (opcode == websocketpp::frame::opcode::binary) {
                if (!session->recording) {
                    log_stage("binary ignored because recording=false");
                    return;
                }

                if (payload.size() % sizeof(float) != 0) {
                    log_stage("binary payload size not aligned: " + std::to_string(payload.size()));
                    return;
                }

                size_t n_float = payload.size() / sizeof(float);

                if (n_float == 0) {
                    log_stage("binary payload had zero floats");
                    return;
                }

                std::vector<float> samples(n_float);

                std::memcpy(
                    samples.data(),
                    payload.data(),
                    payload.size()
                );

                session->audio_queue.push(
                    samples.data(),
                    samples.size(),
                    session->session_generation.load()
                );
                log_stage("binary pushed: floats=" + std::to_string(samples.size()));
            }
        }
    );

    const uint16_t port = 47831;

    server.listen(port);
    server.start_accept();

    log_stage("WebSocket ASR server running");

    try {
        server.run();
    } catch (const std::exception& err) {
        log_stage(std::string("server.run exception: ") + err.what());
        throw;
    }

    {
        std::lock_guard<std::mutex> lock(app.connection_mutex);
        for (const auto& item : app.sessions) {
            item.second->audio_queue.shutdown();
        }
        app.sessions.clear();
    }

    if (app.whisper_model.ctx != nullptr) {
        whisper_free(app.whisper_model.ctx);
        app.whisper_model.ctx = nullptr;
    }
    whisper_vad_free(vctx);

    return 0;
}
