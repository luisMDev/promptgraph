import { VOICE_BYTES_PER_SAMPLE, VOICE_CHANNELS, VOICE_SAMPLE_RATE } from "@promptgraph/shared";

/** Size of the canonical RIFF/WAVE header written by wavHeader. */
export const WAV_HEADER_BYTES = 44;

/**
 * 44-byte RIFF header of a PCM16 mono 16 kHz WAV (the format whisper-cli reads) for `dataBytes` of samples.
 * `dataBytes` must be even (whole Int16 samples).
 */
export function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  const blockAlign = VOICE_CHANNELS * VOICE_BYTES_PER_SAMPLE;
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(VOICE_CHANNELS, 22);
  h.writeUInt32LE(VOICE_SAMPLE_RATE, 24);
  h.writeUInt32LE(VOICE_SAMPLE_RATE * blockAlign, 28); // byte rate
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(VOICE_BYTES_PER_SAMPLE * 8, 34); // bits per sample
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Header + samples. An odd trailing byte (half a sample) is dropped. */
export function encodeWav(pcm: Buffer): Buffer {
  const data = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1);
  return Buffer.concat([wavHeader(data.length), data]);
}
