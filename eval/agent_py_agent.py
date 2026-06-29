"""Harbor installed agent adapter for the Python agent.py prototype."""

from __future__ import annotations

import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class AgentPyAgent(BaseInstalledAgent):
    """Install and run agent.py inside Harbor task containers."""

    TRAJECTORY_PATH = "/tmp/agent-py-trajectory.jsonl"

    @staticmethod
    def name() -> str:
        return "agent-py"

    def version(self) -> str | None:
        return "0.0.1"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y python3 python3-pip python3-venv ripgrep git",
        )

        repo_root = Path(__file__).resolve().parents[1]
        await environment.upload_dir(str(repo_root), "/opt/revcode")

        await self.exec_as_agent(
            environment,
            command=(
                "cd /opt/revcode && python3 -m venv .venv "
                "&& . .venv/bin/activate "
                "&& pip install -r requirements.txt"
            ),
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
            "cd /opt/revcode && . .venv/bin/activate && "
            "python3 agent.py --headless "
            f"--prompt {quoted_instruction} "
            f"--trajectory-out {quoted_trajectory}"
        )
        await self.exec_as_agent(environment, command=command)

        local_trajectory = Path("/tmp/agent-py-trajectory-host.jsonl")
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
