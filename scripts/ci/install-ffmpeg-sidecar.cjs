const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const frontendDir = path.resolve(process.argv[2] || "frontend");
const serverDir = path.join(frontendDir, "src-tauri", "server");
const requireFromFrontend = createRequire(path.join(frontendDir, "package.json"));
const ffmpegPath = requireFromFrontend("ffmpeg-static");

if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  throw new Error("ffmpeg-static did not provide a usable ffmpeg binary");
}

fs.mkdirSync(serverDir, { recursive: true });

const outputName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const outputPath = path.join(serverDir, outputName);

fs.copyFileSync(ffmpegPath, outputPath);

if (process.platform !== "win32") {
  fs.chmodSync(outputPath, 0o755);
}

console.log(`Installed ffmpeg sidecar: ${outputPath}`);
