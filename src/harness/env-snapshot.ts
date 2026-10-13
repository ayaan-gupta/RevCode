/**
 * Environment snapshot: a compact, one-shot survey of the working directory and
 * toolchain injected into the system prompt. It saves the model several
 * exploration turns (what language? what's installed? is this a git repo?) —
 * a technique credited by the Meta-Harness Terminal-Bench work.
 *
 * The probe script is static (no interpolated input) and bounded by a hard
 * timeout, so it can never wedge startup.
 */

import { spawn } from "node:child_process";

const MAX_SNAPSHOT_CHARS = 3_500;

const PROBE_SCRIPT = String.raw`
exec 2>/dev/null
echo "os: $(uname -sr) $(uname -m)"
echo "user: $(id -un) | cpus: $(nproc 2>/dev/null || echo ?) | mem: $(free -m 2>/dev/null | awk '/Mem:/{print $2"MB"}')"
echo "git: $(git rev-parse --is-inside-work-tree 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null | head -1 || echo none)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "git-status:"; git status --short 2>/dev/null | head -8
fi
echo "top-level:"; ls -A1 2>/dev/null | head -40 | tr '\n' ' '; echo
tools=""
for t in python3 pip3 node npm yarn pnpm bun deno go cargo rustc gcc g++ clang make cmake java mvn gradle ruby php dotnet git rg jq curl wget sqlite3 docker tmux vim nano sed awk; do
  command -v "$t" >/dev/null 2>&1 && tools="$tools $t"
done
echo "available:$tools"
ver() { command -v "$1" >/dev/null 2>&1 && echo "$1: $(timeout 2 "$@" 2>&1 | head -1)"; }
ver python3 --version
ver node --version
ver go version
ver rustc --version
ver gcc --version
ver java -version
markers=""
for f in package.json pyproject.toml requirements.txt setup.py Cargo.toml go.mod pom.xml build.gradle Makefile CMakeLists.txt Dockerfile docker-compose.yml tsconfig.json pytest.ini tox.ini .env; do
  [ -e "$f" ] && markers="$markers $f"
done
echo "project-files:$markers"
echo "disk-free: $(df -h . 2>/dev/null | awk 'NR==2{print $4}')"
`;

export interface EnvSnapshotOptions {
  timeoutMs?: number;
}

/** Collect the snapshot. Resolves to "" on any failure (it is strictly best-effort). */
export function collectEnvSnapshot(cwd: string, options: EnvSnapshotOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 6_000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (text: string): void => {
      if (!settled) {
        settled = true;
        resolve(text);
      }
    };

    let stdout = "";
    let child;
    try {
      child = spawn("bash", ["--norc", "--noprofile", "-c", PROBE_SCRIPT], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish("");
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(clamp(stdout));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 20_000) {
        child.kill("SIGKILL");
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(clamp(stdout));
    });
  });
}

function clamp(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SNAPSHOT_CHARS ? `${trimmed.slice(0, MAX_SNAPSHOT_CHARS)}\n…(truncated)` : trimmed;
}
