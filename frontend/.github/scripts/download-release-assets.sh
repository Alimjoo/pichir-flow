#!/usr/bin/env bash
set -euo pipefail

server_dir="${1:-src-tauri/server}"
mkdir -p "$server_dir"

curl_args=(
  --fail
  --location
  --retry 5
  --retry-delay 10
  --connect-timeout 30
)

if [[ -n "${MODEL_DOWNLOAD_TOKEN:-}" ]]; then
  curl_args+=(--header "Authorization: Bearer ${MODEL_DOWNLOAD_TOKEN}")
fi

download_asset() {
  local mode="$1"
  local secret_name="$2"
  local url="$3"
  local output="$4"

  if [[ -z "$url" ]]; then
    if [[ "$mode" == "required" ]]; then
      echo "::error::Missing required GitHub secret: ${secret_name}"
      exit 1
    fi

    echo "Skipping optional asset ${output}; ${secret_name} is not set."
    return
  fi

  echo "Downloading ${output} from ${secret_name}..."
  curl "${curl_args[@]}" --output "${server_dir}/${output}.download" "$url"
  mv "${server_dir}/${output}.download" "${server_dir}/${output}"
}

download_asset required NON_UYGHUR_MODEL_URL "${NON_UYGHUR_MODEL_URL:-}" non-uyghur.model
download_asset required TTS_MODEL_URL "${TTS_MODEL_URL:-}" tts.model
download_asset required TTS_HELPER_MODEL_URL "${TTS_HELPER_MODEL_URL:-}" tts-helper.model

download_asset optional UGASR_HELPER_MODEL_URL "${UGASR_HELPER_MODEL_URL:-}" helper.model
download_asset optional UGASR_UYGHUR_MODEL_URL "${UGASR_UYGHUR_MODEL_URL:-}" uyghur.model
download_asset optional UGASR_UYGHUR_FAST_MODEL_URL "${UGASR_UYGHUR_FAST_MODEL_URL:-}" uyghur-fast.model
download_asset optional UGASR_UYGHUR_ULTRA_MODEL_URL "${UGASR_UYGHUR_ULTRA_MODEL_URL:-}" uyghur-ultra.model

echo "Bundled server assets:"
ls -lh "$server_dir"
