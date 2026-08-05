#!/usr/bin/env bash
set -euo pipefail

server_dir="${1:?server directory is required}"
target_name="${2:?target sidecar name is required}"

mkdir -p "$server_dir"

if [[ "$RUNNER_OS" == "Windows" ]]; then
  built_name="ASR.exe"
else
  built_name="ASR"
fi

built_path="${server_dir}/${built_name}"
target_path="${server_dir}/${target_name}"

if [[ ! -f "$built_path" ]]; then
  echo "::error::Expected ASR sidecar was not produced: ${built_path}"
  find "$server_dir" -maxdepth 1 -type f -print
  exit 1
fi

if [[ "$built_name" != "$target_name" ]]; then
  rm -f "$target_path"
  mv "$built_path" "$target_path"
fi

if [[ "$RUNNER_OS" != "Windows" ]]; then
  chmod +x "$target_path"
fi

echo "Bundled ASR sidecar:"
ls -lh "$target_path"
