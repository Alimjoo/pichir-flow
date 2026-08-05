#!/usr/bin/env bash
set -euo pipefail

server_dir="${1:-frontend/src-tauri/server}"
mkdir -p "$server_dir"

download_model() {
  local url="$1"
  local output="$2"
  local min_bytes="$3"
  local output_path="${server_dir}/${output}"
  local temp_path="${output_path}.download"

  if [[ -z "$url" ]]; then
    echo "::error::Missing URL for ${output}"
    exit 1
  fi

  echo "Downloading ${output}..."
  curl \
    --fail \
    --location \
    --retry 5 \
    --retry-delay 10 \
    --connect-timeout 30 \
    --output "$temp_path" \
    "$url"

  local bytes
  bytes="$(wc -c < "$temp_path" | tr -d '[:space:]')"

  if [[ "$bytes" -lt "$min_bytes" ]]; then
    echo "::error::Downloaded ${output} is too small: ${bytes} bytes"
    rm -f "$temp_path"
    exit 1
  fi

  mv "$temp_path" "$output_path"
}

download_model "$SILERO_MODEL_URL" "silero-v6.2.1-ggml.bin" 100000
download_model "$WHISPER_SMALL_MODEL_URL" "whisper-small-q5_0.bin" 30000000
download_model "$WHISPER_SMALL_UYGHUR_MODEL_URL" "whisper-small-uyghur-q5_0.bin" 30000000

echo "Bundled model assets:"
ls -lh "$server_dir"
