#!/usr/bin/env bash
set -euo pipefail

bundle_dir="frontend/src-tauri/target/release/bundle"
artifact_dir="release-artifacts"

rm -rf "$artifact_dir"
mkdir -p "$artifact_dir"

if [[ ! -d "$bundle_dir" ]]; then
  echo "::error::Tauri bundle directory was not found: ${bundle_dir}"
  exit 1
fi

while IFS= read -r artifact; do
  cp "$artifact" "$artifact_dir/"
done < <(
  find "$bundle_dir" -type f \( \
    -name '*.AppImage' -o \
    -name '*.deb' -o \
    -name '*.dmg' -o \
    -name '*.exe' -o \
    -name '*.msi' \
  \) | sort
)

if ! find "$artifact_dir" -type f | grep -q .; then
  echo "::error::No installer packages were produced under ${bundle_dir}"
  find "$bundle_dir" -maxdepth 4 -print
  exit 1
fi

echo "Release artifacts:"
ls -lh "$artifact_dir"
