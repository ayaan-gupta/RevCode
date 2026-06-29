"""Harbor installed agent adapter for the TypeScript RevCode CLI."""

from __future__ import annotations

import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class RevCodeAgent(BaseInstalledAgent):
    """Install and run the RevCode Node CLI inside Harbor task containers."""

    TRAJECTORY_PATH = "/tmp/revcode-trajectory.jsonl"

    @staticmethod
    def name() -> str:
        return "revcode"

    def version(self) -> str | None:
        return "0.0.1"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && apt-get install -y curl ca-certificates gnupg ripgrep git "
                "&& curl -fsSL https://deb.nodesource.com/setup_20.x | bash - "
                "&& apt-get install -y nodejs"
            ),
        )

        repo_root = Path(__file__).resolve().parents[1]
        await environment.upload_dir(str(repo_root), "/opt/revcode")

        await self.exec_as_agent(
            environment,
            command="cd /opt/revcode && npm install && npm run build",
        )

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
            "cd /opt/revcode && node dist/index.js --headless "
            f"--prompt {quoted_instruction} "
            f"--trajectory-out {quoted_trajectory} "
            "--cwd /app "
            "--provider zai"
        )
        await self.exec_as_agent(environment, command=command)

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
