import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-sonnet-4-6"
MAX_TOOL_OUTPUT = 30000

SYSTEM_PROMPT = (
    "You are a terminal assistant. You help users accomplish tasks on their local machine "
    "by reading and writing files, running shell commands, and exploring directories. "
    "Prefer the smallest number of tool calls needed. Use list_directory before read_file "
    "when you do not know exact paths. Use run_command with ripgrep (rg) for content search "
    "across files instead of reading files one by one. When writing scripts, write the full "
    "file in one write_file call, then run it. Be direct and report results clearly."
)

TOOL_FUNCTIONS = {}
TRAJECTORY = []


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def record_trajectory(event):
    TRAJECTORY.append(event)


def read_file(path: str) -> str:
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"File not found: {path}")
    if not p.is_file():
        raise IsADirectoryError(f"Not a file: {path}")
    content = p.read_text(encoding="utf-8", errors="replace")
    line_count = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
    header = f"[{p} — {line_count} lines, {len(content)} chars]\n"
    if len(content) > MAX_TOOL_OUTPUT:
        return header + content[:MAX_TOOL_OUTPUT] + f"\n\n[truncated at {MAX_TOOL_OUTPUT} chars]"
    return header + content


def write_file(path: str, content: str) -> str:
    p = Path(path).expanduser().resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"Wrote {len(content)} bytes to {p}"


def run_command(cmd: str) -> str:
    result = subprocess.run(
        cmd,
        shell=True,
        capture_output=True,
        text=True,
        timeout=120,
        cwd=os.getcwd(),
    )
    parts = []
    if result.stdout:
        parts.append(result.stdout)
    if result.stderr:
        parts.append(result.stderr)
    output = "\n".join(parts).strip() or "(no output)"
    if len(output) > MAX_TOOL_OUTPUT:
        output = output[:MAX_TOOL_OUTPUT] + f"\n\n[truncated at {MAX_TOOL_OUTPUT} chars]"
    if result.returncode != 0:
        return f"exit code {result.returncode}\n{output}"
    return output


def list_directory(path: str) -> str:
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"Directory not found: {path}")
    if not p.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    entries = []
    for item in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        suffix = "/" if item.is_dir() else ""
        entries.append(f"{item.name}{suffix}")
    if not entries:
        return f"(empty directory: {p})"
    return f"[{p} — {len(entries)} entries]\n" + "\n".join(entries)


TOOL_FUNCTIONS["read_file"] = read_file
TOOL_FUNCTIONS["write_file"] = write_file
TOOL_FUNCTIONS["run_command"] = run_command
TOOL_FUNCTIONS["list_directory"] = list_directory

TOOL_SCHEMAS = [
    {
        "name": "read_file",
        "description": (
            "Read the full text content of a single file at the given path. "
            "Use when you need to inspect a specific file's contents. "
            "Do not use for directories — use list_directory instead. "
            "Do not use to search across many files — use run_command with rg instead."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or relative path to the file to read.",
                }
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": (
            "Create or overwrite a file at the given path with the provided content. "
            "Parent directories are created automatically. "
            "Use for creating scripts, configs, or any text file. "
            "Write the complete file content in one call."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or relative path where the file should be written.",
                },
                "content": {
                    "type": "string",
                    "description": "Full text content to write to the file.",
                },
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "run_command",
        "description": (
            "Execute a shell command and return its combined stdout/stderr. "
            "Use for running scripts, installing packages, git operations, and searching file contents. "
            "For searching text across files, prefer: rg 'pattern' path or rg --files -g '*.ext' path. "
            "For counting lines: wc -l or find combined with wc. "
            "Do not use ls/find for simple directory listing — use list_directory instead. "
            "Commands run in the current working directory with a 120 second timeout."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "cmd": {
                    "type": "string",
                    "description": "Shell command to execute.",
                }
            },
            "required": ["cmd"],
        },
    },
    {
        "name": "list_directory",
        "description": (
            "List files and subdirectories in a directory. "
            "Directories are marked with a trailing slash. "
            "Use before read_file when you need to discover what files exist. "
            "Use when the user asks what is in a folder or you need to locate a file by name."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or relative path to the directory to list.",
                }
            },
            "required": ["path"],
        },
    },
]


def initial_messages():
    record_trajectory({"type": "system", "timestamp": now_iso(), "content": SYSTEM_PROMPT})
    return [{"role": "system", "content": SYSTEM_PROMPT}]


def get_system_prompt(messages):
    for msg in messages:
        if msg["role"] == "system":
            return msg["content"]
    return SYSTEM_PROMPT


def api_messages(messages):
    return [m for m in messages if m["role"] != "system"]


def execute_tool(name, tool_input):
    fn = TOOL_FUNCTIONS.get(name)
    if fn is None:
        return f"Unknown tool: {name}"
    try:
        return str(fn(**tool_input))
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


def content_blocks_to_dicts(content):
    if isinstance(content, str):
        return content
    blocks = []
    for block in content:
        if block.type == "text":
            blocks.append({"type": "text", "text": block.text})
        elif block.type == "tool_use":
            blocks.append(
                {
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                }
            )
    return blocks


def extract_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if hasattr(block, "text"):
            parts.append(block.text)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(block["text"])
    return "\n".join(parts)


def has_tool_use(content):
    if isinstance(content, list):
        for block in content:
            if (hasattr(block, "type") and block.type == "tool_use") or (
                isinstance(block, dict) and block.get("type") == "tool_use"
            ):
                return True
    return False


def run_tool_loop(client, messages):
    while True:
        response = client.messages.create(
            model=MODEL,
            max_tokens=8096,
            system=get_system_prompt(messages),
            messages=api_messages(messages),
            tools=TOOL_SCHEMAS,
        )

        assistant_content = content_blocks_to_dicts(response.content)
        messages.append({"role": "assistant", "content": assistant_content})

        if not has_tool_use(response.content):
            final_text = extract_text(response.content)
            if final_text:
                record_trajectory(
                    {"type": "assistant", "timestamp": now_iso(), "content": final_text}
                )
            return final_text

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            print(f"  [{block.name}({json.dumps(block.input, ensure_ascii=False)})]")
            record_trajectory(
                {
                    "type": "tool_call",
                    "timestamp": now_iso(),
                    "name": block.name,
                    "arguments": block.input,
                    "toolCallId": block.id,
                }
            )
            result = execute_tool(block.name, block.input)
            record_trajectory(
                {
                    "type": "tool_result",
                    "timestamp": now_iso(),
                    "name": block.name,
                    "result": result,
                    "toolCallId": block.id,
                }
            )
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                }
            )

        messages.append({"role": "user", "content": tool_results})


def handle_slash_command(cmd, messages):
    parts = cmd.strip().split(maxsplit=1)
    name = parts[0].lower()

    if name == "/help":
        print(
            "/memory  — show full message history sent to the LLM\n"
            "/tools   — show tool schemas\n"
            "/clear   — reset conversation to system prompt only\n"
            "/help    — show this help"
        )
        return True

    if name == "/memory":
        print(json.dumps(messages, indent=2, default=str))
        return True

    if name == "/tools":
        print(json.dumps(TOOL_SCHEMAS, indent=2))
        return True

    if name == "/clear":
        messages.clear()
        messages.extend(initial_messages())
        print("Conversation cleared.")
        return True

    if name.startswith("/"):
        print(f"Unknown command: {name}. Type /help for available commands.")
        return True

    return False


def write_trajectory(path):
    with open(path, "w", encoding="utf-8") as handle:
        for event in TRAJECTORY:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def run_headless(prompt, trajectory_out=None):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Set ANTHROPIC_API_KEY in .env", file=sys.stderr)
        sys.exit(1)

    client = Anthropic(api_key=api_key)
    messages = initial_messages()
    record_trajectory({"type": "user", "timestamp": now_iso(), "content": prompt})
    messages.append({"role": "user", "content": prompt})

    reply = run_tool_loop(client, messages)
    if reply:
        print(f"\n{reply}\n")

    if trajectory_out:
        write_trajectory(trajectory_out)


def run_interactive():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Set ANTHROPIC_API_KEY in .env", file=sys.stderr)
        sys.exit(1)

    client = Anthropic(api_key=api_key)
    messages = initial_messages()

    print(f"Agent ready ({MODEL}). Type 'exit' to quit.\n")

    try:
        while True:
            try:
                user_input = input("> ").strip()
            except EOFError:
                print()
                break

            if not user_input:
                continue

            if user_input.lower() == "exit":
                break

            if user_input.startswith("/"):
                handle_slash_command(user_input, messages)
                continue

            record_trajectory({"type": "user", "timestamp": now_iso(), "content": user_input})
            messages.append({"role": "user", "content": user_input})

            try:
                reply = run_tool_loop(client, messages)
                print(f"\n{reply}\n")
            except Exception as e:
                print(f"\nAPI error: {e}\n", file=sys.stderr)
                messages.pop()

    except KeyboardInterrupt:
        print("\nBye.")


def parse_args():
    parser = argparse.ArgumentParser(description="RevCode Python agent prototype")
    parser.add_argument("--headless", action="store_true", help="Run a single task and exit")
    parser.add_argument("--prompt", help="Task instruction for headless mode")
    parser.add_argument("--cwd", help="Working directory for the agent")
    parser.add_argument("--trajectory-out", help="Write JSONL trajectory log to this path")
    return parser.parse_args()


def main():
    args = parse_args()

    if args.cwd:
        os.chdir(args.cwd)

    if args.headless:
        prompt = args.prompt
        if not prompt and not sys.stdin.isatty():
            prompt = sys.stdin.read().strip()
        if not prompt:
            print("Headless mode requires --prompt or piped stdin instruction", file=sys.stderr)
            sys.exit(1)
        run_headless(prompt, trajectory_out=args.trajectory_out)
        return

    run_interactive()


if __name__ == "__main__":
    main()
