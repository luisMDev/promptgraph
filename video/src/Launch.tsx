import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Audio, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { type Box, frameAt, recording } from "./recording";

export const FPS = 30;
const W = 1920;
/** The app window: the whole 1920x1080 footage scaled to 0.85 (never cropped), below the caption band. */
const WIN = { w: 1632, h: 918, x: (W - 1632) / 2, y: 150 };
const FONT = "Geist, ui-sans-serif, system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, monospace";
const INK = "#f4f4f5";
const DIM = "#8b8b94";


interface ClipShot {
  /** Footage span (seconds, from the recording markers). */
  from: number;
  to: number;
  /** On-screen length; shorter than the span = sped up. */
  seconds: number;
  title: string;
  subtitle: string;
  /** A region (from the recording) to spotlight: the rest of the window dims, nothing is cropped. */
  focus?: keyof typeof recording.boxes;
}

const m = recording.markers;
const INTRO_S = 3.4;
const OUTRO_S = 4.6;

const SHOTS: ClipShot[] = [
  {
    from: m.editor - 0.2,
    to: m.run + 0.4,
    seconds: Math.min(4.2, m.run + 0.6 - m.editor),
    title: "Draw your workflow.",
    subtitle: "Prompts, slash commands, shell steps, approvals and PRs.",
  },
  {
    from: m.run + 0.4,
    to: m.fanout + 2.2,
    seconds: 4.6,
    title: "Hit run.",
    focus: "lanes",
    subtitle: "Independent steps fan out, each in its own git worktree.",
  },
  {
    from: m.terminal - 0.5,
    to: Math.min(m.terminal + 6, m["review-waiting"] - 1),
    seconds: 5,
    title: "Every step is a real Claude Code session.",
    focus: "terminal",
    subtitle: "Watch it work, or jump in and type.",
  },
  {
    from: Math.min(m.terminal + 6, m["review-waiting"] - 1),
    to: m.approval,
    seconds: 2.8,
    title: "Lanes merge, Claude commits.",
    subtitle: "Then the run stops where you want a say.",
  },
  {
    from: m.approval,
    to: m.pr + 2,
    seconds: 6.6,
    title: "Nothing ships without you.",
    subtitle: "Review the exact diff. Approve the pull request.",
  },
  {
    from: m.report - 0.2,
    to: m.end,
    seconds: Math.min(4.6, m.end - m.report + 0.2),
    title: "Know exactly what happened.",
    subtitle: "Every step's result, diff, timing and cost.",
  },
];

const f = (s: number) => Math.round(s * FPS);
const shotFrames = SHOTS.map((s) => f(s.seconds));
const CLIPS_FRAMES = shotFrames.reduce((a, b) => a + b, 0);
export const DURATION = f(INTRO_S) + CLIPS_FRAMES + f(OUTRO_S);

const CLIPS_START = f(INTRO_S);
const STARTS = (() => {
  let at = CLIPS_START;
  return shotFrames.map((d) => {
    const s = at;
    at += d;
    return s;
  });
})();

/** Output frame showing the footage at recording time `t`, if a shot covers it. */
function frameOfRecording(t: number): number | null {
  for (let i = 0; i < SHOTS.length; i++) {
    const s = SHOTS[i]!;
    if (t >= s.from && t < s.to) return STARTS[i]! + Math.round(((t - s.from) / (s.to - s.from)) * shotFrames[i]!);
  }
  return null;
}

export function Launch() {
  const clipsStart = CLIPS_START;
  const starts = STARTS;
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0b", fontFamily: FONT, color: INK }}>
      <Backdrop />
      <Sequence durationInFrames={f(INTRO_S) + 8} name="Intro">
        <Intro />
      </Sequence>
      <Sequence from={clipsStart} durationInFrames={CLIPS_FRAMES} name="App">
        <AppWindow starts={starts.map((s) => s - clipsStart)} />
      </Sequence>
      {SHOTS.map((s, i) => (
        <Sequence key={s.title} from={starts[i]} durationInFrames={shotFrames[i]} name={`Caption: ${s.title}`}>
          <Caption title={s.title} subtitle={s.subtitle} />
        </Sequence>
      ))}
      <Sequence from={clipsStart + CLIPS_FRAMES - 6} name="Outro">
        <Outro />
      </Sequence>
      <Soundtrack />
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------------------------------------ backdrop

function Backdrop() {
  return (
    <AbsoluteFill>
      <Img src={staticFile("brand/dark-corners.webp")} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.55 }} />
      <AbsoluteFill style={{ background: "radial-gradient(60% 55% at 50% 60%, rgb(255 255 255 / 0.05), transparent 70%)" }} />
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------------------------------------ app window

function AppWindow({ starts }: { starts: number[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Which shot is on, and where inside it.
  let i = starts.findLastIndex((s) => s <= frame);
  if (i < 0) i = 0;
  const shot = SHOTS[i]!;
  const local = frame - starts[i]!;
  const len = shotFrames[i]!;
  const t = interpolate(local, [0, len], [shot.from, shot.to], { extrapolateRight: "clamp" });
  const speed = (shot.to - shot.from) / shot.seconds;

  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 22 });
  const exit = interpolate(frame, [CLIPS_FRAMES - 10, CLIPS_FRAMES], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const focus = shot.focus ? recording.boxes[shot.focus] : undefined;
  const spot = Math.min(
    interpolate(local, [8, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    interpolate(local, [len - 10, len], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  );

  return (
    <div
      style={{
        position: "absolute",
        left: WIN.x,
        top: WIN.y,
        width: WIN.w,
        height: WIN.h,
        borderRadius: 18,
        overflow: "hidden",
        border: "1px solid #2e2e33",
        boxShadow: "0 50px 140px -30px rgb(0 0 0 / 0.95), 0 0 120px -30px rgb(255 255 255 / 0.10)",
        opacity: Math.min(enter, exit),
        transform: `translateY(${(1 - enter) * 60}px) scale(${0.96 + 0.04 * enter})`,
      }}
    >
      <Img src={staticFile(`recording/${frameAt(t)}`)} style={{ width: "100%", height: "100%", display: "block" }} />
      {focus && <Spotlight box={focus} amount={spot} />}
      {speed > 1.6 && <SpeedChip speed={speed} />}
    </div>
  );
}

/** Dims the window around `box` and outlines it; the footage stays whole. */
function Spotlight({ box, amount }: { box: Box; amount: number }) {
  const pad = 10;
  return (
    <div
      style={{
        position: "absolute",
        left: box.x * WIN.w - pad,
        top: box.y * WIN.h - pad,
        width: box.w * WIN.w + pad * 2,
        height: box.h * WIN.h + pad * 2,
        borderRadius: 16,
        opacity: amount,
        border: "2px solid rgb(255 255 255 / 0.85)",
        boxShadow: "0 0 0 4000px rgb(5 5 6 / 0.55), 0 0 40px rgb(255 255 255 / 0.25)",
        pointerEvents: "none",
      }}
    />
  );
}

function SpeedChip({ speed }: { speed: number }) {
  return (
    <div
      style={{
        position: "absolute",
        right: 20,
        bottom: 20,
        padding: "8px 16px",
        borderRadius: 999,
        background: "rgb(10 10 11 / 0.8)",
        border: "1px solid #3f3f46",
        fontFamily: MONO,
        fontSize: 24,
        color: INK,
      }}
    >
      ▶▶ {Math.round(speed)}×
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ captions

function Caption({ title, subtitle }: { title: string; subtitle: string }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const inT = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  const inS = spring({ frame: frame - 5, fps, config: { damping: 200 }, durationInFrames: 16 });
  const out = interpolate(frame, [durationInFrames - 7, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const line = (p: number): CSSProperties => ({ opacity: p * out, transform: `translateY(${(1 - p) * 18}px)` });
  return (
    <div style={{ position: "absolute", top: 26, left: 0, right: 0, textAlign: "center" }}>
      <div style={{ fontSize: 54, fontWeight: 500, letterSpacing: "-0.035em", lineHeight: 1.05, ...line(inT) }}>{title}</div>
      <div style={{ marginTop: 8, fontSize: 28, color: DIM, letterSpacing: "-0.01em", ...line(inS) }}>{subtitle}</div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ intro / outro

function Logo({ size }: { size: number }) {
  return <Img src={staticFile("brand/logo.svg")} style={{ width: size, height: size, borderRadius: size * 0.22 }} />;
}

function Reveal({ delay, children, style }: { delay: number; children: ReactNode; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 20 });
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * 26}px)`, ...style }}>{children}</div>;
}

/** The headline is on screen from frame 0: X can use the first frame as the poster. */
function Intro() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const out = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const drift = interpolate(frame, [0, durationInFrames], [1.04, 1.12]);
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <AbsoluteFill style={{ backgroundColor: "#0a0a0b" }} />
      <Img
        src={staticFile("brand/dark-glow.webp")}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.7, transform: `scale(${drift})` }}
      />
      <AbsoluteFill style={{ background: "radial-gradient(55% 60% at 50% 50%, rgb(10 10 11 / 0.82), rgb(10 10 11 / 0.35))" }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <Reveal delay={-30} style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 40 }}>
          <Logo size={56} />
          <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>promptgraph</span>
        </Reveal>
        <Reveal delay={-30} style={{ fontSize: 112, fontWeight: 450, letterSpacing: "-0.05em", lineHeight: 1 }}>
          Claude Code, in parallel.
        </Reveal>
        <Reveal delay={4} style={{ fontSize: 112, fontWeight: 450, letterSpacing: "-0.05em", lineHeight: 1.1, color: DIM }}>
          Drawn as a graph.
        </Reveal>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

function Outro() {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <AbsoluteFill style={{ backgroundColor: "#0a0a0b" }} />
      <Img
        src={staticFile("brand/dark-waves.webp")}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.8 }}
      />
      <AbsoluteFill style={{ background: "linear-gradient(90deg, rgb(10 10 11 / 0.96) 0%, rgb(10 10 11 / 0.6) 60%, rgb(10 10 11 / 0.2) 100%)" }} />
      <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 160 }}>
        <Reveal delay={4} style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <Logo size={84} />
          <span style={{ fontSize: 76, fontWeight: 600, letterSpacing: "-0.035em" }}>promptgraph</span>
        </Reveal>
        <Reveal delay={10} style={{ marginTop: 30, fontSize: 52, fontWeight: 450, letterSpacing: "-0.03em", lineHeight: 1.15 }}>
          Draw the flow once.
          <br />
          <span style={{ color: DIM }}>Let Claude Code run it in parallel.</span>
        </Reveal>
        <Reveal delay={18} style={{ marginTop: 44, display: "flex", gap: 16, alignItems: "center" }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 32,
              padding: "14px 26px",
              borderRadius: 999,
              background: "#fff",
              color: "#0a0a0b",
            }}
          >
            github.com/luisMDev/promptgraph
          </span>
        </Reveal>
        <Reveal delay={24} style={{ marginTop: 26, fontSize: 26, color: DIM }}>
          Open source · MIT · Runs locally on Linux &amp; WSL
        </Reveal>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------------------------------------ sound

/** Music bed (fades in and out), a whoosh on every cut, the pointer's clicks and an accent on the outro. */
function Soundtrack() {
  const outro = CLIPS_START + CLIPS_FRAMES - 6;
  const clickFrames = recording.clicks.map(frameOfRecording).filter((x): x is number => x !== null);
  return (
    <>
      <Audio
        src={staticFile("audio/music.wav")}
        volume={(fr) =>
          interpolate(fr, [0, 12, DURATION - 40, DURATION - 2], [0, 0.75, 0.75, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        }
      />
      {[...STARTS, outro].map((at, i) => (
        <Sequence key={`whoosh-${i}`} from={Math.max(0, at - 8)} durationInFrames={24} name="whoosh">
          <Audio src={staticFile("audio/whoosh.wav")} volume={0.32} />
        </Sequence>
      ))}
      {clickFrames.map((at, i) => (
        <Sequence key={`click-${i}`} from={at} durationInFrames={6} name="click">
          <Audio src={staticFile("audio/click.wav")} volume={0.45} />
        </Sequence>
      ))}
      <Sequence from={outro + 4} durationInFrames={66} name="impact">
        <Audio src={staticFile("audio/impact.wav")} volume={0.55} />
      </Sequence>
    </>
  );
}
