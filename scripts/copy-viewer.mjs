// Stage the standalone single-file viewer where the main app can fetch it as a
// template (public/ is copied verbatim into the build). Run after the
// standalone build, before the main build.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("public", { recursive: true });
copyFileSync("dist-standalone/index.html", "public/viewer.html");
console.log("staged dist-standalone/index.html → public/viewer.html");
