/**
 * multi-step-serve-manifest — run a generator, then leave a server running.
 *
 * The state graded here is a LIVE process, which is the point: a foreground
 * server hangs the tool call, a server tied to the shell call dies with it, and
 * `/health` is not something `python3 -m http.server` provides, so a small
 * custom handler has to be written. The grader talks to the real port with a
 * retry loop, then ALWAYS kills whatever is listening, so a graded attempt never
 * leaks a server.
 *
 * Grading is therefore not repeatable once it has run: a second grade finds the
 * port closed. The oracle is written to be re-run (it restarts the server) so
 * the suite's idempotence check can bring the state back.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import {
  clip,
  fail,
  httpGet,
  httpGetWithRetry,
  killListeners,
  pass,
  python,
  readText,
  sha256,
  sleep,
  stableStringify,
  startDetached,
  writeFiles,
} from "../helpers.js";

/** Below the Linux ephemeral range (32768+) so outgoing connections never collide with it. */
export const SERVE_PORT = 18417;

const ASSETS: Record<string, string> = {
  "assets/app.js": "console.log('inventory ui v3');\n",
  "assets/style.css": "body { font-family: sans-serif; margin: 2rem; }\n",
  "assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#036"/></svg>\n',
  "assets/data/items.json": '{"items": [1, 2, 3], "version": 3}\n',
};

const INDEX_HTML = '<!doctype html>\n<title>Inventory</title>\n<script src="assets/app.js"></script>\n';

const BUILD_TOOL = String.raw`#!/usr/bin/env python3
"""Copy assets/ into public/assets/ and describe them in public/manifest.json."""

import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public"


def main():
    target = OUT / "assets"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(ROOT / "assets", target)
    files = []
    for path in sorted(p for p in target.rglob("*") if p.is_file()):
        data = path.read_bytes()
        files.append(
            {"path": path.relative_to(OUT).as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        )
    (OUT / "manifest.json").write_text(json.dumps({"version": 1, "files": files}, indent=2) + "\n")
    print(f"wrote {len(files)} entries to {OUT / 'manifest.json'}")


if __name__ == "__main__":
    main()
`;

const REFERENCE_SERVER = String.raw`#!/usr/bin/env python3
"""Serve public/ on 127.0.0.1:${SERVE_PORT}, plus GET /health."""

import functools
import http.server


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] == "/health":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *args):
        pass


handler = functools.partial(Handler, directory="public")
http.server.ThreadingHTTPServer(("127.0.0.1", ${SERVE_PORT}), handler).serve_forever()
`;

/** What tools/build_manifest.py must have produced, computed independently of it. */
function expectedManifest(): unknown {
  const files = Object.keys(ASSETS)
    .sort()
    .map((relative) => {
      const data = Buffer.from(ASSETS[relative] ?? "", "utf8");
      return { path: relative, bytes: data.length, sha256: sha256(data) };
    });
  return { version: 1, files };
}

export const multiStepServeManifest: DynoTask = {
  id: "multi-step-serve-manifest",
  title: "Generate a manifest and serve it from a background HTTP server",
  category: "multi-step",
  difficulty: 2,
  instruction:
    "Run `python3 tools/build_manifest.py` to generate `public/manifest.json` from the files in `assets/`. Then serve the " +
    `\`public/\` directory over HTTP on 127.0.0.1 port ${SERVE_PORT}, in the background, so that ` +
    `\`http://127.0.0.1:${SERVE_PORT}/manifest.json\` returns the manifest and \`/index.html\` works. In addition, ` +
    "`GET /health` must answer 200 with the body `ok` (a plain static file server won't do that by itself). Use only the " +
    "Python standard library, and leave the server running when you're done because other services will start polling it " +
    "right away.",
  maxIterations: 25,
  timeoutSec: 150,

  setup(dir) {
    writeFiles(dir, {
      ...ASSETS,
      "public/index.html": INDEX_HTML,
      "tools/build_manifest.py": BUILD_TOOL,
    });
  },

  async grade(dir) {
    try {
      const onDisk = readText(dir, "public/manifest.json");
      if (onDisk === undefined) return fail("public/manifest.json was not generated");
      const want = expectedManifest();
      let parsedDisk: unknown;
      try {
        parsedDisk = JSON.parse(onDisk);
      } catch {
        return fail("public/manifest.json is not valid JSON");
      }
      if (stableStringify(parsedDisk) !== stableStringify(want)) return fail("public/manifest.json does not describe the files in assets/");

      const base = `http://127.0.0.1:${SERVE_PORT}`;
      let manifest;
      try {
        manifest = await httpGetWithRetry(`${base}/manifest.json`, 6_000);
      } catch (error) {
        return fail(`nothing is serving ${base} (${error instanceof Error ? error.message : String(error)}); the server must still be running`);
      }
      if (manifest.status !== 200) return fail(`GET /manifest.json returned ${manifest.status}`);
      let served: unknown;
      try {
        served = JSON.parse(manifest.body);
      } catch {
        return fail(`GET /manifest.json is not JSON: ${clip(manifest.body, 120)}`);
      }
      if (stableStringify(served) !== stableStringify(want)) return fail("the served manifest differs from the expected one");

      const index = await httpGet(`${base}/index.html`);
      if (index.status !== 200 || index.body !== INDEX_HTML) return fail(`GET /index.html returned ${index.status} with unexpected content`);

      const health = await httpGet(`${base}/health`);
      if (health.status !== 200 || health.body.trim() !== "ok") return fail(`GET /health returned ${health.status} ${JSON.stringify(clip(health.body, 60))}, expected 200 "ok"`);

      const asset = await httpGet(`${base}/assets/app.js`);
      if (asset.status !== 200 || asset.body !== ASSETS["assets/app.js"]) return fail("GET /assets/app.js did not return the copied asset");

      const missing = await httpGet(`${base}/definitely-not-here`);
      if (missing.status !== 404) return fail(`unknown paths must 404, got ${missing.status}`);
      return pass(`server on :${SERVE_PORT} serves the manifest, assets and /health`);
    } catch (error) {
      return fail(`HTTP check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await killListeners(SERVE_PORT);
    }
  },

  async oracle(dir) {
    const built = await python(["tools/build_manifest.py"], { cwd: dir, timeoutMs: 20_000 });
    if (built.code !== 0) throw new Error(`build_manifest.py failed: ${built.stderr}`);
    fs.writeFileSync(path.join(dir, "serve.py"), REFERENCE_SERVER);

    await killListeners(SERVE_PORT);
    startDetached("python3", ["-B", "serve.py"], dir);
    await httpGetWithRetry(`http://127.0.0.1:${SERVE_PORT}/health`, 8_000);
    await sleep(50);
  },
};
