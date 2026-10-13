/**
 * Bundle RevCode into a single self-contained ESM file (dist/revcode.mjs).
 *
 * This is what the Harbor eval adapter ships: shipping one prebuilt file lets
 * the container skip `npm install && npm run build` (~2 minutes of cold start
 * per trial that previously caused AgentTimeoutError).
 *
 * The banner shims the CommonJS globals (`require`, `__filename`, `__dirname`)
 * that some dependencies (e.g. figlet) reference at import time but which do
 * not exist in ESM scope.
 */

import { build } from "esbuild";

// esbuild injects its own `__dirname`/`__filename` shims (for CJS deps like
// figlet); we only need to provide a global `require` for any bundled CJS code
// that calls it at runtime.
const cjsShim = ["import { createRequire as __createRequire } from 'module';", "const require = __createRequire(import.meta.url);"].join("\n");

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // An optional argument builds somewhere else (e.g. an A/B candidate) without touching dist/revcode.mjs.
  outfile: process.argv[2] ?? "dist/revcode.mjs",
  banner: { js: cjsShim },
  logLevel: "info",
});
