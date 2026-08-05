import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { minify as terserMinify } from "terser";

const require = createRequire(import.meta.url);
const JavaScriptObfuscator = require("javascript-obfuscator");
const buildMode = process.argv.includes("--dev") ? "dev" : "production";
const isDevBuild = buildMode === "dev";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const srcDir = path.join(projectDir, "src");
const distDir = path.join(projectDir, "dist");
const generatedIntegrityPath = path.join(
  projectDir,
  "src-tauri",
  "src",
  "generated_frontend_integrity.rs",
);

const textFiles = [
  { source: "index.html", kind: "html" },
  { source: "main.js", kind: "js" },
  { source: "asr.js", kind: "js" },
  { source: "styles.css", kind: "css" },
];

const binaryFiles = ["assets/sf-arabic-regular.ttf"];

function stripJsComments(source) {
  let output = "";
  let state = "code";
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === "line-comment") {
      if (char === "\n") {
        output += char;
        state = "code";
      }
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        i += 1;
        state = "code";
      }
      continue;
    }

    if (state === "single" || state === "double" || state === "template") {
      output += char;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (
        (state === "single" && char === "'") ||
        (state === "double" && char === "\"") ||
        (state === "template" && char === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line-comment";
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      state = "block-comment";
      i += 1;
      continue;
    }

    if (char === "'") {
      state = "single";
    } else if (char === "\"") {
      state = "double";
    } else if (char === "`") {
      state = "template";
    }

    output += char;
  }

  return output;
}

async function minifyJs(source, relativePath) {
  const compactSource = stripJsComments(source)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
  const minified = await terserMinify(compactSource, {
    module: true,
    compress: {
      passes: 2,
    },
    mangle: {
      module: true,
      toplevel: false,
    },
    format: {
      comments: false,
    },
  });

  if (!minified.code) {
    throw new Error(`Terser produced empty output for ${relativePath}`);
  }

  return quietObfuscator(() =>
    JavaScriptObfuscator.obfuscate(minified.code, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: "hexadecimal",
      renameGlobals: false,
      rotateStringArray: true,
      seed: 20260517,
      selfDefending: false,
      simplify: true,
      splitStrings: false,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayEncoding: ["base64"],
      stringArrayThreshold: relativePath === "main.js" ? 0.45 : 0.25,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
    }).getObfuscatedCode(),
  );
}

function minifyCss(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function minifyHtml(source) {
  return source.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function quietObfuscator(fn) {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;

  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};

  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
}

async function transform(source, kind, relativePath) {
  if (isDevBuild) {
    return source.trimEnd();
  }

  if (kind === "html") {
    return minifyHtml(source);
  }

  if (kind === "css") {
    return minifyCss(source);
  }

  return await minifyJs(source, relativePath);
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function writeTextFile(relativePath, kind) {
  const sourcePath = path.join(srcDir, relativePath);
  const targetPath = path.join(distDir, relativePath);
  const source = await fs.readFile(sourcePath, "utf8");
  const output = `${await transform(source, kind, relativePath)}\n`;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, output);
}

async function copyBinaryFile(relativePath) {
  const sourcePath = path.join(srcDir, relativePath);
  const targetPath = path.join(distDir, relativePath);

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function fileHash(relativePath) {
  const bytes = await fs.readFile(path.join(distDir, relativePath));
  return sha256Hex(bytes);
}

function rustString(value) {
  return JSON.stringify(value);
}

async function writeFileIfChanged(filePath, content) {
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === content) {
      return;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  await fs.writeFile(filePath, content);
}

async function writeIntegrityManifest(files) {
  const entries = [];

  for (const relativePath of files) {
    const hash = await fileHash(relativePath);
    entries.push(`    FrontendIntegrityFile {
        path: ${rustString(relativePath)},
        sha256: ${rustString(hash)},
        bytes: include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../dist/${relativePath}")),
    }`);
  }

  const output = `// @generated by frontend/scripts/build-frontend.mjs
const FRONTEND_INTEGRITY_FILES: &[FrontendIntegrityFile] = &[
${entries.join(",\n")}
];
`;

  await writeFileIfChanged(generatedIntegrityPath, output);
}

await fs.rm(distDir, { recursive: true, force: true });

for (const file of textFiles) {
  await writeTextFile(file.source, file.kind);
}

for (const file of binaryFiles) {
  await copyBinaryFile(file);
}

await writeIntegrityManifest([
  ...textFiles.map((file) => file.source),
  ...binaryFiles,
]);
