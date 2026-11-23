const sampleRateHz = 16_000;
const maxVoiceSeconds = 10;
const headerBytes = 44;
const sampleBytes = 2;

export const maxVoicePcmBytes = sampleRateHz * maxVoiceSeconds * sampleBytes;
export const maxVoiceWavBytes = headerBytes + maxVoicePcmBytes;
export const maxVoiceMs = maxVoiceSeconds * 1_000;

export function encodePcm16ToWav(
  chunks: readonly Uint8Array[], sampleRate = sampleRateHz, maxSeconds = maxVoiceSeconds,
): Uint8Array<ArrayBuffer> {
  const maxBytes = Math.floor(maxSeconds * sampleRate) * sampleBytes;
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || sampleRate * sampleBytes > 0xffffffff ||
      !Number.isSafeInteger(maxBytes) || maxSeconds < 0 || maxBytes + 36 > 0xffffffff) {
    throw new RangeError("Invalid PCM sample rate or duration");
  }
  let size = 0;
  for (const chunk of chunks) {
    size = Math.min(maxBytes, size + chunk.length);
    if (size === maxBytes) break;
  }
  size -= size % sampleBytes;

  const wav = new Uint8Array(headerBytes + size);
  const header = new DataView(wav.buffer);
  header.setUint32(0, 0x52494646); // RIFF
  header.setUint32(4, wav.length - 8, true);
  header.setUint32(8, 0x57415645); // WAVE
  header.setUint32(12, 0x666d7420); // fmt
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * sampleBytes, true);
  header.setUint16(32, sampleBytes, true);
  header.setUint16(34, 16, true);
  header.setUint32(36, 0x64617461); // data
  header.setUint32(40, size, true);
  let offset = headerBytes;
  for (const chunk of chunks) {
    if (offset === wav.length) break;
    const samples = chunk.subarray(0, wav.length - offset);
    wav.set(samples, offset);
    offset += samples.length;
  }
  return wav;
}

// Accept the layout produced by the WebView, not duration values declared by arbitrary WAV chunks.
export function isVoiceWav(wav: Uint8Array): boolean {
  const size = wav.byteLength - headerBytes;
  if (size < sampleBytes || size > maxVoicePcmBytes || size % sampleBytes !== 0) return false;
  const header = new DataView(wav.buffer, wav.byteOffset, headerBytes);
  return header.getUint32(0) === 0x52494646 && header.getUint32(4, true) === wav.byteLength - 8 &&
    header.getUint32(8) === 0x57415645 && header.getUint32(12) === 0x666d7420 && header.getUint32(16, true) === 16 &&
    header.getUint16(20, true) === 1 && header.getUint16(22, true) === 1 && header.getUint32(24, true) === sampleRateHz &&
    header.getUint32(28, true) === sampleRateHz * sampleBytes && header.getUint16(32, true) === sampleBytes &&
    header.getUint16(34, true) === 16 && header.getUint32(36) === 0x64617461 && header.getUint32(40, true) === size;
}
