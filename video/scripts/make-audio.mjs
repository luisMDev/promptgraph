#!/usr/bin/env node
// Synthesises the launch video's soundtrack and sound effects into video/public/audio/ (16-bit WAV).
// Everything is generated here from oscillators and noise, so the audio is ours and needs no licence.
//
//   node video/scripts/make-audio.mjs
//
// music.wav  ~40 s, A minor, 100 BPM: soft pad, bass pulse, plucked arpeggio with echo, light kick and hats
//            (the beat comes in after the intro card). The composition fades it in and out.
// whoosh.wav scene transition · click.wav pointer click · impact.wav outro accent

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/audio");
const SR = 44_100;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------------------------------------ helpers

/** Deterministic noise, so every run produces the same files. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

const midiHz = (n) => 440 * 2 ** ((n - 69) / 12);

function buffers(seconds) {
  const n = Math.ceil(seconds * SR);
  return [new Float32Array(n), new Float32Array(n)];
}

/** Attack / exponential release envelope. */
function env(t, attack, release, length) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  if (t < length) return 1;
  return Math.exp(-(t - length) / release);
}

/** One-pole low-pass, in place. */
function lowpass(buf, hz) {
  const a = 1 - Math.exp((-TAU * hz) / SR);
  let y = 0;
  for (let i = 0; i < buf.length; i++) buf[i] = y += a * (buf[i] - y);
  return buf;
}

/** Schroeder reverb (4 combs + 2 all-pass) of a mono send, added to both channels with a small spread. */
function reverb(send, [l, r], mix = 0.3) {
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ d, buf: new Float32Array(d), i: 0, fb: 0.8, lp: 0 }));
  const aps = [225, 556].map((d) => ({ d, buf: new Float32Array(d), i: 0 }));
  for (let n = 0; n < send.length; n++) {
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * 0.7 + c.lp * 0.3;
      c.buf[c.i] = send[n] + c.lp * c.fb;
      c.i = (c.i + 1) % c.d;
      acc += y;
    }
    let y = acc / combs.length;
    for (const a of aps) {
      const b = a.buf[a.i];
      a.buf[a.i] = y + b * 0.5;
      y = b - y * 0.5;
      a.i = (a.i + 1) % a.d;
    }
    l[n] += y * mix;
    if (n + 23 < r.length) r[n + 23] += y * mix;
  }
}

function writeWav(file, [l, r]) {
  let peak = 0;
  for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  const gain = peak > 0 ? 0.89 / peak : 1; // about -1 dBFS
  const data = Buffer.alloc(l.length * 4);
  for (let i = 0; i < l.length; i++) {
    data.writeInt16LE(Math.round(Math.tanh(l[i] * gain) * 32767), i * 4);
    data.writeInt16LE(Math.round(Math.tanh(r[i] * gain) * 32767), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(2, 22); // stereo
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(OUT, file), Buffer.concat([h, data]));
  console.log(`[audio] ${file} ${(l.length / SR).toFixed(1)}s`);
}

// ------------------------------------------------------------------------------------------------ music

function music(seconds = 40) {
  const [L, R] = buffers(seconds);
  const send = new Float32Array(L.length);
  const noise = rng(7);
  const bpm = 100;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const beatStart = 3.4; // the intro card: pad only
  // i – VI – III – VII in A minor: Am, F, C, G (MIDI notes, root first).
  const chords = [
    [45, 57, 60, 64],
    [41, 57, 60, 65],
    [48, 55, 60, 64],
    [43, 55, 59, 62],
  ];
  const add = (i, v, pan = 0, wet = 0) => {
    if (i < 0 || i >= L.length) return;
    L[i] += v * (1 - pan) * 0.5;
    R[i] += v * (1 + pan) * 0.5;
    send[i] += v * wet;
  };

  const bars = Math.ceil(seconds / bar);
  for (let b = 0; b < bars; b++) {
    const chord = chords[b % chords.length];
    const t0 = b * bar;
    // Pad: soft triangle + sine voices, slow attack, overlapping releases.
    const pad = new Float32Array(Math.ceil((bar + 2.5) * SR));
    chord.slice(1).forEach((note, v) => {
      const f = midiHz(note);
      for (let i = 0; i < pad.length; i++) {
        const t = i / SR;
        const ph = (t * f) % 1;
        const tri = 4 * Math.abs(ph - 0.5) - 1;
        const s = (tri * 0.6 + Math.sin(TAU * f * 1.003 * t) * 0.4) * env(t, 0.7, 0.9, bar);
        pad[i] += s * 0.06 * (v === 0 ? 1 : 0.8);
      }
    });
    lowpass(pad, 1400);
    for (let i = 0; i < pad.length; i++) add(Math.round(t0 * SR) + i, pad[i], Math.sin(i / SR) * 0.3, 0.5);

    // Bass: a sine pulse on every beat once the beat is in, a long note before.
    const bassHz = midiHz(chord[0] - 12);
    for (let k = 0; k < 4; k++) {
      const start = t0 + k * beat;
      const len = start < beatStart ? bar : beat * 0.9;
      if (start < beatStart && k > 0) continue;
      const n = Math.ceil((len + 0.3) * SR);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        add(Math.round(start * SR) + i, Math.sin(TAU * bassHz * t) * 0.16 * env(t, 0.01, 0.12, len * 0.6));
      }
    }

    // Arpeggio: eighth-note plucks over the chord tones, with a dotted-eighth echo.
    if (t0 + bar > beatStart) {
      const tones = [chord[1] + 12, chord[2] + 12, chord[3] + 12, chord[2] + 24];
      for (let k = 0; k < 8; k++) {
        const start = t0 + (k * beat) / 2;
        if (start < beatStart) continue;
        const f = midiHz(tones[k % tones.length]);
        const pan = k % 2 ? 0.35 : -0.35;
        for (const [delay, gain] of [
          [0, 0.07],
          [beat * 0.75, 0.03],
          [beat * 1.5, 0.012],
        ]) {
          const n = Math.ceil(0.45 * SR);
          for (let i = 0; i < n; i++) {
            const t = i / SR;
            const s = (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * 2 * f * t)) * Math.exp(-t / 0.12);
            add(Math.round((start + delay) * SR) + i, s * gain, delay ? -pan : pan, 0.4);
          }
        }
      }
    }

    // Drums: soft kick on beats, closed hat on off-beats.
    for (let k = 0; k < 8; k++) {
      const start = t0 + (k * beat) / 2;
      if (start < beatStart) continue;
      if (k % 2 === 0) {
        const n = Math.ceil(0.3 * SR);
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / SR;
          ph += (45 + 75 * Math.exp(-t / 0.03)) / SR;
          add(Math.round(start * SR) + i, Math.sin(TAU * ph) * 0.22 * Math.exp(-t / 0.11));
        }
      } else if (start > beatStart + bar) {
        const n = Math.ceil(0.05 * SR);
        let prev = 0;
        for (let i = 0; i < n; i++) {
          const w = noise();
          const hp = w - prev; // crude high-pass
          prev = w;
          add(Math.round(start * SR) + i, hp * 0.025 * Math.exp(-(i / SR) / 0.012), 0.2);
        }
      }
    }
  }
  reverb(send, [L, R], 0.25);
  return [L, R];
}

// ------------------------------------------------------------------------------------------------ effects

function whoosh() {
  const [L, R] = buffers(0.7);
  const noise = rng(3);
  // State-variable band-pass sweeping 300 Hz → 3.5 kHz, rising then falling.
  let low = 0;
  let band = 0;
  for (let i = 0; i < L.length; i++) {
    const t = i / SR;
    const k = t / 0.7;
    const f = 300 + 3200 * Math.sin(Math.PI * Math.min(1, k * 1.1)) ** 2;
    const fc = 2 * Math.sin((Math.PI * f) / SR);
    const high = noise() - low - 0.6 * band;
    band += fc * high;
    low += fc * band;
    const e = Math.sin(Math.PI * k) ** 1.5;
    L[i] = band * e * (1 - k * 0.5);
    R[i] = band * e * (0.5 + k * 0.5);
  }
  return [L, R];
}

function click() {
  const [L, R] = buffers(0.06);
  const noise = rng(5);
  for (let i = 0; i < L.length; i++) {
    const t = i / SR;
    const v = (Math.sin(TAU * 2400 * t) * 0.6 + noise() * 0.4) * Math.exp(-t / 0.008);
    L[i] = v;
    R[i] = v;
  }
  return [L, R];
}

function impact() {
  const [L, R] = buffers(2.2);
  const send = new Float32Array(L.length);
  const noise = rng(9);
  let ph = 0;
  for (let i = 0; i < L.length; i++) {
    const t = i / SR;
    ph += (40 + 60 * Math.exp(-t / 0.06)) / SR;
    const boom = Math.sin(TAU * ph) * Math.exp(-t / 0.5);
    const air = noise() * 0.12 * Math.exp(-t / 0.25);
    const shimmer = (Math.sin(TAU * midiHz(81) * t) + Math.sin(TAU * midiHz(88) * t)) * 0.05 * Math.exp(-t / 0.9);
    L[i] = boom + air + shimmer;
    R[i] = boom + air * 0.8 + shimmer;
    send[i] = shimmer + air;
  }
  reverb(send, [L, R], 0.5);
  return [L, R];
}

fs.mkdirSync(OUT, { recursive: true });
writeWav("music.wav", music());
writeWav("whoosh.wav", whoosh());
writeWav("click.wav", click());
writeWav("impact.wav", impact());
