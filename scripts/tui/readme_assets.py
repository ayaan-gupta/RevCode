"""Regenerate the README's terminal visuals (docs/assets/hero.svg, logo-dark.svg, logo-light.svg) from a real session.

Runs the bundled CLI in a pty against a live model, inside a Parallel Universe, on a tiny project
with a failing test; records what the terminal showed, and renders chosen moments as vector SVG.

    pip install pyte pillow
    npm run bundle
    Z_AI_API_KEY=... python3 scripts/tui/readme_assets.py            # or --provider/--model flags
    python3 scripts/tui/readme_assets.py --tape /tmp/tape.pkl        # re-render from a saved recording

Needs a model that can fix the bug, so the result is a real transcript, not a script. Frames are
picked by what they show (banner, prompt, first tool cards, diff, receipt, land), so a different
run still yields the same story.
"""
import argparse
import os
import pickle
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from ptyshot import Session  # noqa: E402
from svgshot import render_svg, snapshot  # noqa: E402

PROMPT = "slugify is broken. make the tests pass, and keep your summary to two lines"
COLS, ROWS = 100, 34

FILES = {
    "package.json": '{\n  "name": "slugify",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
    "slugify.js": 'export function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]/g, "-");\n}\n',
    "slugify.test.js": (
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\n'
        'import { slugify } from "./slugify.js";\n\n'
        'test("lowercases and joins words", () => {\n  assert.equal(slugify("Hello, World!"), "hello-world");\n});\n\n'
        'test("trims and collapses separators", () => {\n  assert.equal(slugify("  trim   me  "), "trim-me");\n});\n\n'
        'test("strips accents", () => {\n  assert.equal(slugify("Crème Brûlée"), "creme-brulee");\n});\n'
    ),
}


def make_project(home):
    proj = os.path.join(home, "slugify")
    shutil.rmtree(proj, ignore_errors=True)
    os.makedirs(proj)
    for name, body in FILES.items():
        with open(os.path.join(proj, name), "w") as f:
            f.write(body)
    git = ["git", "-c", "user.name=dev", "-c", "user.email=dev@example.com"]
    subprocess.run(["git", "init", "-q"], cwd=proj, check=True)
    subprocess.run(["git", "add", "-A"], cwd=proj, check=True)
    subprocess.run(git + ["commit", "-qm", "slugify"], cwd=proj, check=True)
    return proj


def record(args):
    home = args.home
    os.makedirs(home, exist_ok=True)
    proj = make_project(home)
    revcode_home = tempfile.mkdtemp(prefix="revcode-home-")
    env = {"HOME": home, "REVCODE_HOME": revcode_home}
    for key in ("Z_AI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    argv = ["node", os.path.join(ROOT, "dist", "revcode.mjs"), "--universe", "--no-snapshot", "--no-mcp"] + args.rest
    s = Session(argv, cols=COLS, rows=ROWS, cwd=proj, env=env)
    tape, t0, last = [], time.time(), [None]

    def cap(label):
        text = s.text()
        if text != last[0]:
            tape.append((round(time.time() - t0, 2), label, snapshot(s.screen), text))
            last[0] = text

    def run(secs, label):
        end = time.time() + secs
        while time.time() < end:
            s.pump(0.12)
            cap(label)

    def until(pred, timeout, label):
        end = time.time() + timeout
        while time.time() < end:
            s.pump(0.12)
            cap(label)
            if pred(s.text()):
                return True
        return False

    if not until(lambda t: "Ask RevCode" in t, 40, "start"):
        sys.exit("RevCode never showed its prompt:\n" + s.text())
    run(1.0, "start")
    for i, ch in enumerate(PROMPT):
        s.send(ch, settle=0.03)
        if i % 3 == 0:
            cap("typing")
    cap("typed")
    run(0.6, "typed")
    s.key("enter", settle=0.1)
    started = time.time()
    finished = until(lambda t: time.time() - started > 8 and "Worked for" in t and "Ask RevCode" in t, 240, "work")
    if not finished:
        sys.exit("the turn never finished:\n" + s.text())
    run(1.5, "done")
    for ch in "/land":
        s.send(ch, settle=0.05)
    cap("land-typed")
    run(0.8, "land-typed")
    s.key("enter", settle=0.1)
    run(2.5, "land-confirm")
    s.key("enter", settle=0.1)
    run(3, "landed")
    s.close()
    shutil.rmtree(revcode_home, ignore_errors=True)
    return tape


def first(tape, pred, start=0):
    for i in range(start, len(tape)):
        if pred(tape[i][3]):
            return i
    raise SystemExit("recording is missing an expected moment; re-run it")


def pick(tape):
    """Indexes of the moments to show, with how long each stays on screen."""
    typing = [i for i, f in enumerate(tape) if f[1] == "typing"]
    typed = first(tape, lambda t: "two lines" in t and "❯ slugify" in t)
    cards = first(tape, lambda t: t.count("●") >= 3 and "Read" in t)
    diff = first(tape, lambda t: "Write" in t or "Edit" in t, cards)
    diff = first(tape, lambda t: "+6" in t or "(+" in t, diff)
    ran = first(tape, lambda t: "exit 0" in t, diff)
    receipt = first(tape, lambda t: "receipt" in t and "last check" in t, ran)
    confirm = first(tape, lambda t: "Apply these changes" in t, receipt)
    landed = first(tape, lambda t: "Landed:" in t, confirm)
    return [
        (first(tape, lambda t: "Ask RevCode" in t), 2.6),
        (typing[len(typing) // 3], 0.5),
        (typing[2 * len(typing) // 3], 0.5),
        (typed, 0.9),
        (cards, 1.5),
        (diff, 1.9),
        (ran, 1.7),
        (receipt, 2.8),
        (confirm, 1.8),
        (landed, 3.6),
    ]


def render(tape, out):
    os.makedirs(out, exist_ok=True)
    chosen = pick(tape)
    frames = [tape[i][2] for i, _ in chosen]
    svg = render_svg(frames, title="revcode", durations=[d for _, d in chosen], rows=ROWS, backdrop=True)
    with open(os.path.join(out, "hero.svg"), "w") as f:
        f.write(svg)
    for theme in ("dark", "light"):
        logo = render_logo(banner_frame(theme))
        with open(os.path.join(out, f"logo-{theme}.svg"), "w") as f:
            f.write(logo)
    print("wrote", os.path.join(out, "hero.svg"), f"({len(svg) // 1024} KB) and logo-dark/light.svg")


def banner_frame(theme):
    """The start-up banner in a theme's colors. Needs no model: the provider points nowhere."""
    home = tempfile.mkdtemp(prefix="revcode-banner-")
    env = {"HOME": home, "REVCODE_HOME": home, "REVCODE_API_KEY": "x", "REVCODE_BASE_URL": "http://127.0.0.1:9/v1"}
    argv = ["node", os.path.join(ROOT, "dist", "revcode.mjs"), "--provider", "openai-compat", "--model", "m", "--theme", theme, "--no-snapshot", "--no-mcp", "--no-hooks", "--no-instructions"]
    s = Session(argv, cols=COLS, rows=30, cwd=home, env=env)
    for _ in range(160):
        s.pump(0.25)
        if "Ask RevCode" in s.text():
            break
    s.pump(0.5)
    frame = snapshot(s.screen, cursor=False)
    s.close()
    shutil.rmtree(home, ignore_errors=True)
    return frame


def render_logo(frame):
    """Just the banner glyphs: no window, transparent background, cropped to the letters."""
    ys = [y for y, row in enumerate(frame.rows) if any(c.data == "█" for c in row)]
    width = max(x for y in ys for x, c in enumerate(frame.rows[y]) if c.data.strip()) + 2
    return render_svg([frame], chrome=False, background=False, rows=ys[-1] + 2, first_row=ys[0] - 1, cols=width, pad=4, title="RevCode")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "assets"))
    ap.add_argument("--home", default="/home/dev", help="HOME for the demo (paths show as ~/slugify)")
    ap.add_argument("--tape", help="pickle file: load the recording if present, else save one there")
    args, args.rest = ap.parse_known_args()  # anything else goes to revcode, e.g. --provider zai --model glm-5.2
    if args.tape and os.path.exists(args.tape):
        tape = pickle.load(open(args.tape, "rb"))
    else:
        tape = record(args)
        if args.tape:
            pickle.dump(tape, open(args.tape, "wb"))
    render(tape, args.out)


if __name__ == "__main__":
    main()
