#!/usr/bin/env bash
set -euo pipefail

server_dir="${1:?server directory is required}"
mkdir -p "$server_dir"

moltenvk_prefix="$(brew --prefix molten-vk)"
vulkan_loader_prefix="$(brew --prefix vulkan-loader)"

moltenvk_lib="$(
  find "$moltenvk_prefix" -type f -name 'libMoltenVK.dylib' | head -n 1
)"
moltenvk_icd="$(
  find "$moltenvk_prefix" -type f -name 'MoltenVK_icd.json' | head -n 1
)"
vulkan_loader="$(
  find "$vulkan_loader_prefix" -type f \( -name 'libvulkan.1.dylib' -o -name 'libvulkan.dylib' \) | head -n 1
)"

if [[ -z "$moltenvk_lib" || -z "$moltenvk_icd" || -z "$vulkan_loader" ]]; then
  echo "::error::MoltenVK runtime files were not found under ${moltenvk_prefix}"
  find "$moltenvk_prefix" -maxdepth 5 -print
  echo "::error::Vulkan loader files under ${vulkan_loader_prefix}:"
  find "$vulkan_loader_prefix" -maxdepth 5 -print
  exit 1
fi

cp "$moltenvk_lib" "${server_dir}/libMoltenVK.dylib"
cp "$moltenvk_icd" "${server_dir}/MoltenVK_icd.json"
cp "$vulkan_loader" "${server_dir}/$(basename "$vulkan_loader")"

if [[ "$(basename "$vulkan_loader")" != "libvulkan.1.dylib" ]]; then
  cp "$vulkan_loader" "${server_dir}/libvulkan.1.dylib"
fi

node -e '
const fs = require("node:fs");
const path = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
manifest.ICD = manifest.ICD || {};
manifest.ICD.library_path = "./libMoltenVK.dylib";
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
' "${server_dir}/MoltenVK_icd.json"

echo "Bundled macOS Vulkan runtime:"
ls -lh "${server_dir}/libMoltenVK.dylib" "${server_dir}/MoltenVK_icd.json" "${server_dir}"/libvulkan*.dylib
