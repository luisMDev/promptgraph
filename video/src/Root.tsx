import { loadFont } from "@remotion/fonts";
import { Composition, staticFile } from "remotion";
import { DURATION, FPS, Launch } from "./Launch";

// Geist, as on the landing page. loadFont delays rendering until the files are loaded.
loadFont({ family: "Geist", url: staticFile("fonts/geist.woff2"), weight: "100 900" });
loadFont({ family: "Geist Mono", url: staticFile("fonts/geist-mono.woff2"), weight: "100 900" });

export function Root() {
  return <Composition id="launch" component={Launch} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />;
}
