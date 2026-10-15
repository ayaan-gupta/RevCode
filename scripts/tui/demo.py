"""Drive the real TUI in a pty against the scripted mock model and write PNG screenshots.

    pip install pyte pillow
    node scripts/tui/mock-server.mjs 8799 &
    python3 scripts/tui/demo.py /tmp/tui-shots

Open the PNGs to see exactly what a terminal would show — prompt, streaming, tool cards,
the permission prompt with its diff. Extend it with `Session.type`, `Session.key("enter")`,
`Session.resize`, `Session.shot`.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ptyshot import Session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tui-shots"
os.makedirs(OUT, exist_ok=True)

project = os.path.join(OUT, "project")
os.makedirs(project, exist_ok=True)
with open(os.path.join(project, "README.md"), "w") as f:
    f.write("# Demo\n\nA tiny project.\n")
with open(os.path.join(project, "hello.txt"), "w") as f:
    f.write("hello world\nsecond line\n")

env = {
    "REVCODE_HOME": os.path.join(OUT, "home"),
    "REVCODE_BASE_URL": "http://127.0.0.1:8799/v1",
    "REVCODE_API_KEY": "x",
    "NO_PROXY": "127.0.0.1",
}
tsx = os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
s = Session(
    ["node", tsx, os.path.join(ROOT, "src", "index.ts"), "--provider", "openai-compat", "--model", "mock", "--no-snapshot"],
    cols=100, rows=40, cwd=project, env=env,
)
s.wait(4)
s.shot(os.path.join(OUT, "1-start.png"))
s.type("demo please")
s.key("enter")
s.wait(5)
s.shot(os.path.join(OUT, "2-permission.png"))
s.type("y")
s.wait(4)
s.type("a")
s.wait(4)
s.shot(os.path.join(OUT, "3-answer.png"))
print(s.text())
s.close()
