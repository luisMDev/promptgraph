import { type CSSProperties, createContext, type ReactNode, useContext } from "react";
import { AbsoluteFill, Audio, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { type Box, frameAt, recording } from "./recording";

export const FPS = 30;
/** Size of the recorded frames. */
const SRC = { w: 1920, h: 1080 };

export type Orientation = "landscape" | "portrait";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  portrait: boolean;
  /** The app window: always the whole footage, scaled (never cropped). */
  win: Rect;
  caption: { top: number; title: number; subtitle: number; width: number };
  /** Portrait only: the area under the window where the magnified detail of each shot goes. */
  detail?: Rect;
}

const LAYOUTS: Record<Orientation, Layout> = {
  // 1920x1080: the window at 0.85, below the caption band.
  landscape: { portrait: false, win: { w: 1632, h: 918, x: 144, y: 150 }, caption: { top: 26, title: 54, subtitle: 28, width: 1800 } },
  // 1080x1920: caption on top, the whole window, then a magnified detail of the region that matters.
  portrait: {
    portrait: true,
    win: { w: 1000, h: 563, x: 40, y: 340 },
    caption: { top: 120, title: 64, subtitle: 34, width: 960 },
    detail: { x: 40, y: 950, w: 1000, h: 790 },
  },
};

const LayoutContext = createContext<Layout>(LAYOUTS.landscape);
const useLayout = () => useContext(LayoutContext);
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
  /** Portrait: the region shown magnified under the window (fractions of the frame). */
  detail: Box;
}

/** Grows a box by `dx`/`dy` on each side (fractions), clamped to the frame. */
function grow(b: Box | undefined, dx: number, dy: number, fallback: Box): Box {
  if (!b) return fallback;
  const x = Math.max(0, b.x - dx);
  const y = Math.max(0, b.y - dy);
  return { x, y, w: Math.min(1 - x, b.w + 2 * dx), h: Math.min(1 - y, b.h + 2 * dy) };
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
    detail: { x: 0.18, y: 0.3, w: 0.5, h: 0.48 },
  },
  {
    from: m.run + 0.4,
    to: m.fanout + 2.2,
    seconds: 4.6,
    title: "Hit run.",
    focus: "lanes",
    subtitle: "Independent steps fan out, each in its own git worktree.",
    detail: grow(recording.boxes.lanes, 0.04, 0.04, { x: 0.12, y: 0.28, w: 0.4, h: 0.5 }),
  },
  {
    from: m.terminal - 0.5,
    to: Math.min(m.terminal + 6, m["review-waiting"] - 1),
    seconds: 5,
    title: "Every step is a real Claude Code session.",
    focus: "terminal",
    subtitle: "Watch it work, or jump in and type.",
    detail: { x: 0, y: 0.62, w: 0.62, h: 0.38 },
  },
  {
    from: Math.min(m.terminal + 6, m["review-waiting"] - 1),
    to: m.approval,
    seconds: 2.8,
    title: "Lanes merge, Claude commits.",
    subtitle: "Then the run stops where you want a say.",
    detail: { x: 0.02, y: 0.28, w: 0.72, h: 0.5 },
  },
  {
    from: m.approval,
    to: m.pr + 2,
    seconds: 6.6,
    title: "Nothing ships without you.",
    subtitle: "Review the exact diff. Approve the pull request.",
    detail: { x: 0.05, y: 0.32, w: 0.6, h: 0.64 },
  },
  {
    from: m.report - 0.2,
    to: m.end,
    seconds: Math.min(4.6, m.end - m.report + 0.2),
    title: "Know exactly what happened.",
    subtitle: "Every step's result, diff, timing and cost.",
    detail: { x: 0.05, y: 0.1, w: 0.6, h: 0.62 },
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

export function Launch({ orientation = "landscape" }: { orientation?: Orientation }) {
  const clipsStart = CLIPS_START;
  const starts = STARTS;
  const layout = LAYOUTS[orientation];
  return (
    <LayoutContext.Provider value={layout}>
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
      {layout.portrait && (
        <Sequence from={clipsStart} durationInFrames={CLIPS_FRAMES} name="Footer">
          <Footer />
        </Sequence>
      )}
      <Soundtrack />
    </AbsoluteFill>
    </LayoutContext.Provider>
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
  const { win, detail } = useLayout();
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

  const src = staticFile(`recording/${frameAt(t)}`);
  const shown = Math.min(enter, exit);
  return (
    <>
    <div
      style={{
        position: "absolute",
        left: win.x,
        top: win.y,
        width: win.w,
        height: win.h,
        borderRadius: 18,
        overflow: "hidden",
        border: "1px solid #2e2e33",
        boxShadow: "0 50px 140px -30px rgb(0 0 0 / 0.95), 0 0 120px -30px rgb(255 255 255 / 0.10)",
        opacity: shown,
        transform: `translateY(${(1 - enter) * 60}px) scale(${0.96 + 0.04 * enter})`,
      }}
    >
      <Img src={src} style={{ width: "100%", height: "100%", display: "block" }} />
      {focus && <Spotlight box={focus} amount={spot} win={win} />}
      {speed > 1.6 && <SpeedChip speed={speed} />}
    </div>
    {detail && <Detail area={detail} region={shot.detail} src={src} shown={shown} local={local} />}
    </>
  );
}

/**
 * Portrait: the shot's region of the footage, magnified to fit `area` (aspect kept, nothing stretched), so the
 * text that matters reads on a phone. The whole screen stays visible in the window above.
 */
function Detail({ area, region, src, shown, local }: { area: Rect; region: Box; src: string; shown: number; local: number }) {
  const rw = region.w * SRC.w;
  const rh = region.h * SRC.h;
  const scale = Math.min(area.w / rw, area.h / rh);
  const w = rw * scale;
  const h = rh * scale;
  const fade = interpolate(local, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        left: area.x + (area.w - w) / 2,
        top: area.y + (area.h - h) / 2,
        width: w,
        height: h,
        overflow: "hidden",
        borderRadius: 18,
        border: "1px solid #3f3f46",
        boxShadow: "0 40px 100px -30px rgb(0 0 0 / 0.95)",
        opacity: shown * fade,
      }}
    >
      <Img
        src={src}
        style={{
          position: "absolute",
          left: -region.x * SRC.w * scale,
          top: -region.y * SRC.h * scale,
          width: SRC.w * scale,
          height: SRC.h * scale,
          maxWidth: "none",
        }}
      />
    </div>
  );
}

function Footer() {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", bottom: 70, left: 0, right: 0, display: "flex", justifyContent: "center", alignItems: "center", gap: 14, opacity: o * 0.9 }}>
      <Logo size={40} />
      <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em" }}>promptgraph</span>
    </div>
  );
}

/** Dims the window around `box` and outlines it; the footage stays whole. */
function Spotlight({ box, amount, win }: { box: Box; amount: number; win: Rect }) {
  const pad = 10;
  return (
    <div
      style={{
        position: "absolute",
        left: box.x * win.w - pad,
        top: box.y * win.h - pad,
        width: box.w * win.w + pad * 2,
        height: box.h * win.h + pad * 2,
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
  const { caption } = useLayout();
  const { fps, durationInFrames } = useVideoConfig();
  const inT = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  const inS = spring({ frame: frame - 5, fps, config: { damping: 200 }, durationInFrames: 16 });
  const out = interpolate(frame, [durationInFrames - 7, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const line = (p: number): CSSProperties => ({ opacity: p * out, transform: `translateY(${(1 - p) * 18}px)` });
  return (
    <div style={{ position: "absolute", top: caption.top, left: 0, right: 0, margin: "0 auto", width: caption.width, textAlign: "center" }}>
      <div style={{ fontSize: caption.title, fontWeight: 500, letterSpacing: "-0.035em", lineHeight: 1.05, textWrap: "balance", ...line(inT) }}>{title}</div>
      <div style={{ marginTop: 10, fontSize: caption.subtitle, color: DIM, letterSpacing: "-0.01em", lineHeight: 1.25, textWrap: "balance", ...line(inS) }}>
        {subtitle}
      </div>
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
  const { portrait } = useLayout();
  const big: CSSProperties = { fontSize: portrait ? 118 : 112, fontWeight: 450, letterSpacing: "-0.05em", maxWidth: portrait ? 900 : undefined, textWrap: "balance" };
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
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: portrait ? 60 : 0 }}>
        <Reveal delay={-30} style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 40 }}>
          <Logo size={56} />
          <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>promptgraph</span>
        </Reveal>
        <Reveal delay={-30} style={{ ...big, lineHeight: 1 }}>
          Claude Code, in parallel.
        </Reveal>
        <Reveal delay={4} style={{ ...big, lineHeight: 1.1, marginTop: portrait ? 24 : 0, color: DIM }}>
          Drawn as a graph.
        </Reveal>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

function Outro() {
  const frame = useCurrentFrame();
  const { portrait } = useLayout();
  const fadeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <AbsoluteFill style={{ backgroundColor: "#0a0a0b" }} />
      <Img
        src={staticFile("brand/dark-waves.webp")}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.8 }}
      />
      <AbsoluteFill
        style={{
          background: portrait
            ? "linear-gradient(180deg, rgb(10 10 11 / 0.25) 0%, rgb(10 10 11 / 0.92) 45%, rgb(10 10 11 / 0.92) 75%, rgb(10 10 11 / 0.4) 100%)"
            : "linear-gradient(90deg, rgb(10 10 11 / 0.96) 0%, rgb(10 10 11 / 0.6) 60%, rgb(10 10 11 / 0.2) 100%)",
        }}
      />
      <AbsoluteFill
        style={
          portrait
            ? { justifyContent: "center", alignItems: "center", textAlign: "center", padding: "0 60px" }
            : { justifyContent: "center", paddingLeft: 160 }
        }
      >
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
