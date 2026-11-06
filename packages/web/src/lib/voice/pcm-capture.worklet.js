// AudioWorklet processor of voice dictation (DESIGN §21). Plain JavaScript on purpose: it is loaded with
// `audioWorklet.addModule(new URL("./pcm-capture.worklet.js", import.meta.url))`, which Vite emits as a static
// asset (it is not transpiled). It only mixes the input to mono and posts Float32 blocks of ~50 ms at the context's
// sample rate; resampling to 16 kHz Int16, chunking and the level meter happen on the main thread (pcm.ts, tested).

const BLOCK_SECONDS = 0.05;

class PgPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global of the AudioWorkletGlobalScope.
    this.size = Math.max(128, Math.round(sampleRate * BLOCK_SECONDS));
    this.block = new Float32Array(this.size);
    this.filled = 0;
    // `{type: "flush"}` (the recording stops): post the partial block, then `{type: "flushed"}`, so the main
    // thread gets every sample captured up to the stop before it releases the microphone.
    this.port.onmessage = (ev) => {
      if (!ev.data || ev.data.type !== "flush") return;
      if (this.filled > 0) {
        const out = this.block.slice(0, this.filled);
        this.port.postMessage(out, [out.buffer]);
        this.filled = 0;
      }
      this.port.postMessage({ type: "flushed" });
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      this.block[this.filled++] = sum / channels.length;
      if (this.filled === this.size) {
        // The buffer is transferred: `out` is detached (length 0) afterwards, so the next block uses `this.size`.
        const out = this.block;
        this.port.postMessage(out, [out.buffer]);
        this.block = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pg-pcm-capture", PgPcmCapture);
