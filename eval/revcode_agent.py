"""Harbor installed agent adapter for the TypeScript RevCode CLI."""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

#: API keys passed into the container's agent process (never written to disk).
_API_KEY_NAMES = ("Z_AI_API_KEY", "ZAI_API_KEY", "ANTHROPIC_API_KEY", "Z_AI_BASE_URL")


def _load_repo_env(repo_root: Path) -> dict[str, str]:
    """Parse simple KEY=VALUE lines from the repo .env (best effort)."""
    values: dict[str, str] = {}
    env_path = repo_root / ".env"
    if not env_path.exists():
        return values
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip("'").strip('"')
        values[key.strip()] = value
    return values


def _resolve_api_env(repo_root: Path) -> dict[str, str]:
    """Collect API keys from the host environment, falling back to repo .env."""
    file_values = _load_repo_env(repo_root)
    resolved: dict[str, str] = {}
    for name in _API_KEY_NAMES:
        value = os.environ.get(name) or file_values.get(name)
        if value:
            resolved[name] = value
    return resolved


class RevCodeAgent(BaseInstalledAgent):
    """Install and run the RevCode Node CLI inside Harbor task containers.

    Cold-start optimization: instead of uploading the whole repo and running
    `npm install && npm run build` (~2 min per trial, which previously caused
    AgentTimeoutError), we ship a single prebuilt ESM bundle (dist/revcode.mjs)
    and only install Node + ripgrep. Run `npm run bundle` on the host before
    launching Harbor.
    """

    TRAJECTORY_PATH = "/tmp/revcode-trajectory.jsonl"
    BUNDLE_REMOTE_PATH = "/opt/revcode/revcode.mjs"
    MODEL = "glm-5.2"
    MAX_ITERATIONS = 50

    @staticmethod
    def name() -> str:
        return "revcode"

    def version(self) -> str | None:
        return "0.0.2"

    async def install(self, environment: BaseEnvironment) -> None:
        # Node + ripgrep only — no npm install/build inside the container.
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && apt-get install -y curl ca-certificates gnupg ripgrep "
                "&& curl -fsSL https://deb.nodesource.com/setup_20.x | bash - "
                "&& apt-get install -y nodejs "
                "&& mkdir -p /opt/revcode"
            ),
        )

        bundle = Path(__file__).resolve().parents[1] / "dist" / "revcode.mjs"
        if not bundle.exists():
            raise FileNotFoundError(
                f"Prebuilt bundle not found at {bundle}. Run `npm run bundle` before launching Harbor."
            )
        await environment.upload_file(str(bundle), self.BUNDLE_REMOTE_PATH)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        quoted_instruction = shlex.quote(instruction)
        quoted_trajectory = shlex.quote(self.TRAJECTORY_PATH)
        command = (
            f"node {self.BUNDLE_REMOTE_PATH} --headless "
            f"--prompt {quoted_instruction} "
            f"--trajectory-out {quoted_trajectory} "
            "--cwd /app "
            "--provider zai "
            f"--model {self.MODEL} "
            f"--max-iterations {self.MAX_ITERATIONS}"
        )
        api_env = _resolve_api_env(Path(__file__).resolve().parents[1])
        await self.exec_as_agent(environment, command=command, env=api_env)

        local_trajectory = Path("/tmp/revcode-trajectory-host.jsonl")
        try:
            await environment.download_file(self.TRAJECTORY_PATH, local_trajectory)
            self._local_trajectory = local_trajectory
        except Exception:
            self._local_trajectory = None

    def populate_context_post_run(self, context: AgentContext) -> None:
        trajectory_path = getattr(self, "_local_trajectory", None)
        if trajectory_path is None or not trajectory_path.exists():
            return

        events = []
        for line in trajectory_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue

        if context.metadata is None:
            context.metadata = {}

        context.metadata["trajectory"] = events
        context.metadata["tool_call_count"] = sum(
            1 for event in events if event.get("type") == "tool_call"
        )

        assistant_messages = [
            event.get("content", "")
            for event in events
            if event.get("type") == "assistant" and event.get("content")
        ]
        if assistant_messages:
            context.metadata["final_response"] = assistant_messages[-1]
