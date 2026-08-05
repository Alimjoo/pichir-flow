export const TARGET_SAMPLE_RATE = 16000;

export const FILE_CHUNK_MS = 100;

export const IS_WINDOWS =
  navigator.userAgentData?.platform === "Windows" ||
  /Windows/i.test(navigator.userAgent);

export const FILE_STREAM_SPEED = IS_WINDOWS ? 1 : 4;

export const NATIVE_EXTRACTED_FILE_STREAM_SPEED = IS_WINDOWS ? 1 : 8;

export const MAX_WS_BUFFERED_BYTES = 2 * 1024 * 1024;

export function isMediaSelection(media) {
  const type = String(media?.type || media?.mediaType || "").toLowerCase();
  const name = String(media?.name || media?.path || media?.mediaName || "").toLowerCase();

  return (
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    /\.(aac|aiff|aif|avi|flac|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|oga|ogg|opus|wav|webm)$/i.test(name)
  );
}

export function nativeMediaFileFromPath(path, name = fileNameFromPath(path)) {
  return {
    path,
    name: name || fileNameFromPath(path),
    type: mediaTypeFromFileName(name || path),
  };
}

export function supportedMediaFiles(mediaFiles) {
  return mediaFiles.filter((mediaFile) => mediaFile && isMediaSelection(mediaFile));
}

export function isWavSelection(media) {
  const type = String(media?.type || media?.mediaType || "").toLowerCase();
  const name = String(media?.name || media?.path || media?.mediaName || "").toLowerCase();

  return type === "audio/wav" || type === "audio/x-wav" || /\.wav$/i.test(name);
}

export function looksLikeVideoMedia(media) {
  const type = String(media?.type || media?.mediaType || "").toLowerCase();

  if (type.startsWith("video/")) {
    return true;
  }

  if (type.startsWith("audio/")) {
    return false;
  }

  return /\.(avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)$/i.test(
    String(media?.name || media?.mediaName || media?.sourceName || ""),
  );
}

export function mediaTypeFromFileName(fileName) {
  const name = String(fileName || "").toLowerCase();

  if (name.endsWith(".wav")) {
    return "audio/wav";
  }

  if (name.endsWith(".mp3")) {
    return "audio/mpeg";
  }

  if (name.endsWith(".m4a") || name.endsWith(".aac")) {
    return "audio/mp4";
  }

  if (name.endsWith(".flac")) {
    return "audio/flac";
  }

  if (name.endsWith(".ogg")) {
    return "audio/ogg";
  }

  if (name.endsWith(".opus")) {
    return "audio/opus";
  }

  if (name.endsWith(".aiff")) {
    return "audio/aiff";
  }

  if (name.endsWith(".mov")) {
    return "video/quicktime";
  }

  if (name.endsWith(".mp4") || name.endsWith(".m4v")) {
    return "video/mp4";
  }

  if (name.endsWith(".webm")) {
    return "video/webm";
  }

  if (name.endsWith(".mpeg") || name.endsWith(".mpg")) {
    return "video/mpeg";
  }

  if (name.endsWith(".mkv")) {
    return "video/x-matroska";
  }

  if (name.endsWith(".avi")) {
    return "video/x-msvideo";
  }

  return "application/octet-stream";
}

export function resampleBuffer(input, inputSampleRate, outputSampleRate) {
  if (input.length === 0) {
    return new Float32Array();
  }

  if (outputSampleRate === inputSampleRate) {
    return new Float32Array(input);
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; ++i) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const weight = position - left;

    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }

  return output;
}

export function audioBufferToMono(audioBuffer) {
  const output = new Float32Array(audioBuffer.length);
  const channels = audioBuffer.numberOfChannels;

  for (let channel = 0; channel < channels; ++channel) {
    const data = audioBuffer.getChannelData(channel);

    for (let i = 0; i < data.length; ++i) {
      output[i] += data[i] / channels;
    }
  }

  return output;
}

export function pcmI16BytesToFloat32(bytes) {
  let byteArray;

  if (bytes instanceof ArrayBuffer) {
    byteArray = new Uint8Array(bytes);
  } else if (ArrayBuffer.isView(bytes)) {
    byteArray = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else {
    byteArray = Uint8Array.from(bytes || []);
  }

  const sampleCount = Math.floor(byteArray.byteLength / 2);
  const view = new DataView(
    byteArray.buffer,
    byteArray.byteOffset,
    sampleCount * 2,
  );
  const output = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; ++i) {
    output[i] = view.getInt16(i * 2, true) / 32768;
  }

  return output;
}

export function pcmI16BytesToWavBlob(bytes, sampleRate = TARGET_SAMPLE_RATE) {
  let pcmBytes;

  if (bytes instanceof ArrayBuffer) {
    pcmBytes = new Uint8Array(bytes);
  } else if (ArrayBuffer.isView(bytes)) {
    pcmBytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else {
    pcmBytes = Uint8Array.from(bytes || []);
  }

  const headerSize = 44;
  const dataSize = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);
  const output = new Uint8Array(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; ++i) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  output.set(pcmBytes, headerSize);

  return new Blob([buffer], { type: "audio/wav" });
}

export function float32ToPcmI16Bytes(samples) {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);

  for (let i = 0; i < samples.length; ++i) {
    const clamped = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(
      i * 2,
      clamped < 0 ? clamped * 32768 : clamped * 32767,
      true,
    );
  }

  return output;
}

export function float32ToWavBlob(samples, sampleRate = TARGET_SAMPLE_RATE) {
  return pcmI16BytesToWavBlob(float32ToPcmI16Bytes(samples), sampleRate);
}

export function concatFloat32Chunks(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

export function bytesToArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) {
    return bytes;
  }

  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  }

  return Uint8Array.from(bytes || []).buffer;
}
