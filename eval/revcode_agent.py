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
_API_KEY_NAMES = (
    "Z_AI_API_KEY",
    "ZAI_API_KEY",
    "Z_AI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENROUTER_API_KEY",
    "REVCODE_API_KEY",
    "REVCODE_BASE_URL",
    # Wall-clock budget (seconds): RevCode nudges the model as time runs out and stops cleanly.
    "REVCODE_TIME_BUDGET_SEC",
)


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
    PROFILE_REMOTE_PATH = "/opt/revcode/profile.json"
    # Overridable from the host environment so the same adapter can benchmark any
    # provider/model, optionally with a Dyno-tuned profile (`revcode tune`).
    MODEL = os.environ.get("REVCODE_EVAL_MODEL", "glm-5.2")
    PROVIDER = os.environ.get("REVCODE_EVAL_PROVIDER", "zai")
    # Iterations are a safety net, not the limit: the wall-clock budget is.
    MAX_ITERATIONS = int(os.environ.get("REVCODE_EVAL_MAX_ITERATIONS", "300"))
    NODE_MAJOR = os.environ.get("REVCODE_EVAL_NODE_MAJOR", "22")

    @staticmethod
    def name() -> str:
        return "revcode"

    def version(self) -> str | None:
        return "0.1.0"

    async def install(self, environment: BaseEnvironment) -> None:
        # End-of-life Debian releases (buster, bullseye, ...) lose their packages from the main
        # mirrors while the old indexes still list them, which breaks every apt install with 404s.
        # Their archives live on archive.debian.org; no-op on supported releases and non-Debian images.
        await self.exec_as_root(
            environment,
            command=(
                '. /etc/os-release 2>/dev/null; '
                'if [ "$ID" = debian ] && { [ "$VERSION_CODENAME" = bullseye ] || [ "$VERSION_CODENAME" = buster ]; }; then '
                'rm -f /etc/apt/sources.list.d/*.list; '
                "printf 'deb http://archive.debian.org/debian %s main\\ndeb http://archive.debian.org/debian-security %s-security main\\n' "
                '"$VERSION_CODENAME" "$VERSION_CODENAME" > /etc/apt/sources.list; '
                "echo 'Acquire::Check-Valid-Until \"false\";' > /etc/apt/apt.conf.d/99archive; "
                'fi; true'
            ),
        )
        # (The egress step below rewrites apt mirrors to https, so it must run after this one.)

        # Optional: containers that reach the network only through a TLS-intercepting egress
        # proxy (REVCODE_EVAL_CA_BUNDLE = host path of that proxy's CA). Trust the CA for apt
        # (verification stays ON) and switch apt mirrors to https, since such proxies tunnel
        # only CONNECT. Not set in normal runs, which then behave exactly as before.
        ca_bundle = os.environ.get("REVCODE_EVAL_CA_BUNDLE")
        self._egress_ca = bool(ca_bundle and Path(ca_bundle).expanduser().exists())
        if self._egress_ca:
            await environment.upload_file(str(Path(ca_bundle).expanduser()), "/tmp/egress-ca.crt")
            await self.exec_as_root(
                environment,
                command=(
                    "mkdir -p /opt/revcode /usr/local/share/ca-certificates "
                    "&& cp /tmp/egress-ca.crt /opt/revcode/ca.crt "
                    "&& cp /tmp/egress-ca.crt /usr/local/share/ca-certificates/egress-proxy.crt "
                    "&& printf 'Acquire::https::CaInfo \"/opt/revcode/ca.crt\";\\n' > /etc/apt/apt.conf.d/99egress-ca "
                    "&& (sed -i 's|http://|https://|g' /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null || true)"
                ),
            )

        # Node + ripgrep + tmux (the interactive `terminal` tool registers only when tmux exists) — no npm install/build inside the container.
        # Node 22: its fetch can honor HTTPS_PROXY (NODE_USE_ENV_PROXY), which RevCode enables itself.
        update_ca = "&& update-ca-certificates " if self._egress_ca else ""
        # Package mirrors are occasionally inconsistent for a moment (index newer than pool -> 404),
        # so the whole apt step is retried rather than failing the trial before the agent starts.
        apt_install = (
            "ok=0; for i in 1 2 3 4; do "
            "if apt-get update && apt-get install -y --fix-missing -o Acquire::Retries=3 "
            "curl ca-certificates gnupg ripgrep tmux; then ok=1; break; fi; sleep $((i * 5)); done; "
            '[ "$ok" = 1 ]'
        )
        await self.exec_as_root(
            environment,
            command=(
                f"{apt_install} "
                f"{update_ca}"
                f"&& curl -fsSL https://deb.nodesource.com/setup_{self.NODE_MAJOR}.x | bash - "
                "&& apt-get install -y -o Acquire::Retries=3 nodejs "
                "&& mkdir -p /opt/revcode"
            ),
        )

        # REVCODE_EVAL_BUNDLE selects another prebuilt bundle (for A/B runs of a candidate build).
        override = os.environ.get("REVCODE_EVAL_BUNDLE")
        bundle = (
            Path(override).expanduser()
            if override
            else Path(__file__).resolve().parents[1] / "dist" / "revcode.mjs"
        )
        if not bundle.exists():
            raise FileNotFoundError(
                f"Prebuilt bundle not found at {bundle}. Run `npm run bundle` before launching Harbor."
            )
        await environment.upload_file(str(bundle), self.BUNDLE_REMOTE_PATH)

        profile = os.environ.get("REVCODE_EVAL_PROFILE")
        if profile and Path(profile).expanduser().exists():
            await environment.upload_file(str(Path(profile).expanduser()), self.PROFILE_REMOTE_PATH)
            self._uploaded_profile = True

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Work where the task image says to: WORKDIR differs per task (/app, /app/subdir,
        # /workspace, ...) and a hard-coded directory that does not exist breaks every shell call.
        workdir = "/app"
        try:
            probe = await self.exec_as_agent(environment, command="pwd")
            lines = (getattr(probe, "stdout", None) or "").strip().splitlines()
            if lines and lines[-1].startswith("/"):
                workdir = lines[-1].strip()
        except Exception:
            pass

        quoted_instruction = shlex.quote(instruction)
        quoted_trajectory = shlex.quote(self.TRAJECTORY_PATH)
        profile_flag = (
            f"--profile {self.PROFILE_REMOTE_PATH} "
            if getattr(self, "_uploaded_profile", False)
            else "--profile default "
        )
        # Hermetic by design: never read project instructions, hooks or MCP config from
        # the task directory, so results depend only on the model and the harness.
        command = (
            f"node {self.BUNDLE_REMOTE_PATH} --headless "
            f"--prompt {quoted_instruction} "
            f"--trajectory-out {quoted_trajectory} "
            f"--cwd {shlex.quote(workdir)} "
            f"--provider {self.PROVIDER} "
            f"--model {self.MODEL} "
            f"--max-iterations {self.MAX_ITERATIONS} "
            f"{profile_flag}"
            "--no-instructions --no-hooks --no-mcp"
        )
        api_env = _resolve_api_env(Path(__file__).resolve().parents[1])
        if getattr(self, "_egress_ca", False):
            # Node ignores the system trust store; shell tools use the merged system bundle.
            bundle = "/etc/ssl/certs/ca-certificates.crt"
            api_env.update(
                NODE_EXTRA_CA_CERTS="/opt/revcode/ca.crt",
                SSL_CERT_FILE=bundle,
                REQUESTS_CA_BUNDLE=bundle,
                CURL_CA_BUNDLE=bundle,
            )
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
