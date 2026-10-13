/**
 * McpManager: owns every configured MCP server for one RevCode run and
 * exposes their tools as ordinary `RegisteredTool`s.
 *
 *   const mcp = new McpManager(await loadMcpConfig(cwd), { cwd });
 *   await mcp.start();                       // never rejects, never hangs
 *   for (const tool of mcp.tools()) registry.register(tool);
 *   ...
 *   await mcp.dispose();
 *
 * Design notes:
 * - Startup is concurrent and individually bounded (default 15s per server).
 *   One server that is missing, crashes, or hangs in its handshake becomes a
 *   `failed` status with a reason; it can never delay the others or the agent.
 * - Tool calls never throw. Every failure (server crashed, timeout, JSON-RPC
 *   error, tool-reported error) comes back as `{ error: string }`, the shape
 *   the agent engine counts as a failed tool call.
 * - Tool names are `mcp__<server>__<tool>`, made API-safe, length-capped and
 *   collision-free by `assignToolNames`. Descriptions are prefixed
 *   `[MCP:<server>] ` so provenance is visible to the model, and capped at
 *   1,000 characters so a verbose server cannot flood the prompt.
 * - MCP tools are NOT assumed read-only: a tool is only reported by
 *   `readOnlyToolNames()` when the server annotates `readOnlyHint: true`. The
 *   registry runs read-only tools in parallel, so an unannotated tool must
 *   stay serialized with everything else.
 * - Results are capped at 30,000 characters (head + tail kept, with a note)
 *   so one chatty tool cannot consume the context window.
 * - `dispose()` is idempotent and safe while startup is in flight: in-flight
 *   handshakes are aborted, children are signalled synchronously, and servers
 *   that were still starting end up `failed` ("disposed during startup").
 * - Limitations: no automatic reconnect (a server that exits stays failed for
 *   the rest of the run), no OAuth for HTTP servers, and only text reaches the
 *   model (images/audio are replaced by placeholders).
 */

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  McpClient,
  type McpToolInfo,
  type McpServerInfo,
} from "./client.js";
import type { McpServerConfig, McpTransportKind } from "./config.js";
import { assignToolNames } from "./tool-names.js";
import type { McpToolOutput } from "./tool-result.js";
import { StdioTransport } from "./transport-stdio.js";
import { createHttpTransport } from "./transport-http.js";
import { ErrorCode, McpError, isRecord, type McpTransport } from "./types.js";
import type { RegisteredTool } from "../tools/index.js";

export interface McpManagerOptions {
  /** Default working directory for stdio servers that do not configure `cwd`. Default `process.cwd()`. */
  cwd?: string;
  /** Per-server startup budget (connect + handshake + first tool list). Default 15s. */
  startupTimeoutMs?: number;
  /** Default timeout for a single tool call (a server's `timeoutMs` overrides it). Default 60s. */
  requestTimeoutMs?: number;
  /** Maximum characters of tool result text returned to the model. Default 30,000. */
  maxResultChars?: number;
  /** Maximum characters of each tool description. Default 1,000. */
  maxDescriptionChars?: number;
  clientInfo?: { name: string; version: string };
  /** Receives config warnings and runtime diagnostics. Default: collected only. */
  onWarning?: (message: string) => void;
  /** Test seam: build the transport for a server. */
  transportFactory?: (config: McpServerConfig, cwd: string) => McpTransport;
}

export type McpServerState = "connecting" | "connected" | "failed" | "disabled";

export interface McpServerStatus {
  name: string;
  /** `connecting` is only observable while `start()` is in flight. */
  state: McpServerState;
  toolCount: number;
  /** Why the server failed (includes the stderr tail for stdio servers). */
  error?: string;
  transport: McpTransportKind;
  serverInfo?: McpServerInfo;
  /** Config file this server was defined in. */
  source: string;
}

export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESULT_CHARS = 30_000;
export const DEFAULT_MAX_DESCRIPTION_CHARS = 1_000;

const DEFAULT_PARAMETERS: Record<string, unknown> = { type: "object", properties: {} };

interface ServerEntry {
  config: McpServerConfig;
  state: McpServerState;
  error?: string;
  client?: McpClient;
  tools: McpToolInfo[];
}

interface BuiltTool {
  registered: RegisteredTool;
  readOnly: boolean;
}

export class McpManager {
  private readonly entries: ServerEntry[];
  private readonly options: McpManagerOptions;
  private readonly cwd: string;
  private readonly configWarnings: string[];
  private readonly runtimeWarnings: string[] = [];
  private readonly listeners = new Set<() => void>();
  private built: BuiltTool[] = [];
  private startPromise: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  /** Accepts the result of `loadMcpConfig` directly (its `warnings` are surfaced via `warnings()`). */
  constructor(
    config: { servers: readonly McpServerConfig[]; warnings?: readonly string[] },
    options: McpManagerOptions = {},
  ) {
    this.options = options;
    this.cwd = options.cwd ?? process.cwd();
    this.configWarnings = [...(config.warnings ?? [])];
    this.entries = config.servers.map((server) => ({
      config: server,
      state: server.disabled ? "disabled" : "connecting",
      tools: [],
    }));
  }

  /**
   * Start every enabled server concurrently. Resolves once each has either
   * connected or failed; never rejects. Calling it again returns the same promise.
   */
  start(): Promise<void> {
    this.startPromise ??= this.doStart();
    return this.startPromise;
  }

  /** The tools of all connected servers, ready for `ToolRegistry.register`. */
  tools(): RegisteredTool[] {
    return this.built.map((tool) => tool.registered);
  }

  /** Registered names of tools whose server annotated `readOnlyHint: true`. */
  readOnlyToolNames(): string[] {
    return this.built.filter((tool) => tool.readOnly).map((tool) => tool.registered.definition.name);
  }

  statuses(): McpServerStatus[] {
    return this.entries.map((entry) => ({
      name: entry.config.name,
      state: entry.state,
      toolCount: entry.state === "connected" ? entry.tools.length : 0,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      transport: entry.config.type,
      ...(entry.client?.serverInfo ? { serverInfo: entry.client.serverInfo } : {}),
      source: entry.config.source,
    }));
  }

  /** Config warnings plus anything noteworthy that happened while running. */
  warnings(): string[] {
    return [...this.configWarnings, ...this.runtimeWarnings];
  }

  /** Per-server `instructions` strings from the initialize handshake (for optional prompt inclusion). */
  instructions(): Array<{ server: string; instructions: string }> {
    const out: Array<{ server: string; instructions: string }> = [];
    for (const entry of this.entries) {
      const text = entry.state === "connected" ? entry.client?.instructions : undefined;
      if (text) {
        out.push({ server: entry.config.name, instructions: text });
      }
    }
    return out;
  }

  /** Recent stderr / transport diagnostics for one server (empty if none). */
  diagnostics(serverName: string): string {
    return this.entries.find((entry) => entry.config.name === serverName)?.client?.diagnostics() ?? "";
  }

  /**
   * Subscribe to tool-list changes (a server sent `tools/list_changed`, or a
   * server died). Re-read `tools()` and re-register. Returns an unsubscribe function.
   */
  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Stop all servers. Idempotent; safe before, during and after `start()`.
   * Child processes are signalled synchronously, so not awaiting this at
   * process exit still reaps them.
   */
  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true;
      const closes = this.entries.map((entry) => entry.client?.close() ?? Promise.resolve());
      this.listeners.clear();
      this.built = [];
      this.disposePromise = Promise.allSettled(closes).then(() => undefined);
    }
    return this.disposePromise;
  }

  // --- startup -------------------------------------------------------------

  private async doStart(): Promise<void> {
    await Promise.all(this.entries.map((entry) => this.startServer(entry)));
    this.rebuildTools();
  }

  /** Never rejects: every outcome is recorded on the entry. */
  private async startServer(entry: ServerEntry): Promise<void> {
    const { config } = entry;
    if (config.disabled) {
      entry.state = "disabled";
      return;
    }
    if (this.disposed) {
      return this.fail(entry, "MCP manager was disposed before this server started.");
    }
    if (config.error) {
      return this.fail(entry, config.error);
    }

    const timeoutMs = config.startupTimeoutMs ?? this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let client: McpClient | undefined;
    try {
      const transport = (this.options.transportFactory ?? defaultTransportFactory)(config, this.cwd);
      // The client-wide default covers the handshake and tools/list refreshes, so it
      // follows the startup budget; tool calls get their own (usually longer) timeout.
      client = new McpClient(transport, {
        label: config.name,
        requestTimeoutMs: timeoutMs,
        ...(this.options.clientInfo ? { clientInfo: this.options.clientInfo } : {}),
      });
      entry.client = client;
      client.on("toolsChanged", (tools) => {
        entry.tools = tools;
        this.rebuildTools();
        this.notifyToolsChanged();
      });
      client.on("closed", (error) => this.onServerClosed(entry, error));
      client.on("log", (message) => this.warn(`[mcp:${config.name}] ${message}`));

      const connected = client;
      await withTimeout(
        (async () => {
          await connected.connect();
          entry.tools = await listToolsTolerant(connected);
        })(),
        timeoutMs,
        `Startup timed out after ${timeoutMs}ms (connect, initialize handshake and tools/list).`,
      );
      if (this.disposed) {
        throw new McpError(ErrorCode.ConnectionClosed, "MCP manager was disposed during startup.");
      }
      entry.state = "connected";
    } catch (error) {
      entry.tools = [];
      this.fail(entry, this.describeFailure(error, client));
      // Reap a half-started server without making startup wait for it.
      client?.close().catch(() => undefined);
    }
  }

  private fail(entry: ServerEntry, message: string): void {
    entry.state = "failed";
    entry.error = message;
  }

  /** Error text plus the stderr tail when the error does not already carry it. */
  private describeFailure(error: unknown, client: McpClient | undefined): string {
    if (this.disposed) {
      return "MCP manager was disposed during startup.";
    }
    const message = error instanceof Error ? error.message : String(error);
    const stderr = client?.diagnostics().trim() ?? "";
    if (stderr === "" || message.includes("stderr:")) {
      return message;
    }
    return `${message}\nstderr:\n${stderr.slice(-2_000)}`;
  }

  /** A connected server went away (crash, dropped stream). */
  private onServerClosed(entry: ServerEntry, error: Error | undefined): void {
    if (this.disposed || entry.state !== "connected") {
      return;
    }
    entry.state = "failed";
    entry.error = error?.message ?? "MCP server closed the connection.";
    this.warn(`[mcp:${entry.config.name}] connection lost: ${entry.error}`);
    this.rebuildTools();
    this.notifyToolsChanged();
  }

  // --- tools ---------------------------------------------------------------

  /** Recompute registered names/definitions for every connected server, in config order. */
  private rebuildTools(): void {
    if (this.disposed) {
      return;
    }
    const sources: Array<{ entry: ServerEntry; tool: McpToolInfo }> = [];
    for (const entry of this.entries) {
      if (entry.state === "connected") {
        for (const tool of entry.tools) {
          sources.push({ entry, tool });
        }
      }
    }
    const names = assignToolNames(sources.map(({ entry, tool }) => ({ server: entry.config.name, tool: tool.name })));
    const maxDescription = this.options.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS;
    this.built = sources.map(({ entry, tool }, index) => ({
      readOnly: tool.annotations?.readOnlyHint === true,
      registered: {
        definition: {
          name: names[index],
          description: buildDescription(entry.config.name, tool, maxDescription),
          parameters: buildParameters(tool.inputSchema),
        },
        handler: (input) => this.callTool(entry, tool.name, input),
      },
    }));
  }

  private async callTool(entry: ServerEntry, toolName: string, input: unknown): Promise<unknown> {
    const server = entry.config.name;
    if (this.disposed) {
      return { error: `MCP server "${server}" is no longer available (RevCode is shutting down).` };
    }
    if (entry.state !== "connected" || !entry.client) {
      return { error: `MCP server "${server}" is not connected: ${entry.error ?? "unknown reason"}` };
    }
    const args = isRecord(input) ? input : {};
    try {
      const output = await entry.client.callTool(toolName, args, {
        timeoutMs: entry.config.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      });
      return limitOutput(output, this.options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `MCP tool "${toolName}" on server "${server}" failed: ${message}` };
    }
  }

  private notifyToolsChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.warn(`onToolsChanged listener threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private warn(message: string): void {
    this.runtimeWarnings.push(message);
    if (this.runtimeWarnings.length > 100) {
      this.runtimeWarnings.shift();
    }
    this.options.onWarning?.(message);
  }
}

function defaultTransportFactory(config: McpServerConfig, cwd: string): McpTransport {
  if (config.type === "stdio") {
    return new StdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd ?? cwd,
      label: config.name,
    });
  }
  return createHttpTransport(config.type, { url: config.url, headers: config.headers, label: config.name });
}

/**
 * `tools/list` for a server that may not implement tools at all (a
 * resources-only server answers -32601): that is zero tools, not a failure.
 */
async function listToolsTolerant(client: McpClient): Promise<McpToolInfo[]> {
  try {
    return await client.listTools();
  } catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) {
      return [];
    }
    throw error;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  // If the timeout wins, `work` is abandoned and may reject later; that must not be unhandled.
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpError(ErrorCode.RequestTimeout, message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function buildDescription(server: string, tool: McpToolInfo, max: number): string {
  const body = (tool.description ?? tool.title ?? tool.annotations?.title ?? `MCP tool "${tool.name}"`).trim();
  return truncateEnd(`[MCP:${server}] ${body}`, max);
}

/** Use the tool's `inputSchema`, minus `$schema` (several LLM APIs reject it), defaulting to "no arguments". */
function buildParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || (schema.type !== undefined && schema.type !== "object")) {
    return { ...DEFAULT_PARAMETERS };
  }
  const { $schema: _ignored, ...rest } = schema;
  return {
    ...rest,
    type: "object",
    ...(rest.properties === undefined ? { properties: {} } : {}),
  };
}

function truncateEnd(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** Apply the size cap to the text of a tool output (and to oversized structured data). */
function limitOutput(output: McpToolOutput, max: number): McpToolOutput {
  const structured = limitStructured(output.structured, max);
  if (output.error !== undefined) {
    return { error: truncateMiddle(output.error, max), ...(structured !== undefined ? { structured } : {}) };
  }
  return {
    ...(output.text !== undefined ? { text: truncateMiddle(output.text, max) } : {}),
    ...(structured !== undefined ? { structured } : {}),
  };
}

function limitStructured(structured: unknown, max: number): unknown {
  if (structured === undefined) {
    return undefined;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(structured);
  } catch {
    return structured;
  }
  if (serialized === undefined || serialized.length <= max) {
    return structured;
  }
  return truncateMiddle(serialized, max);
}

/** Keep the head and tail of long text, with a marker saying how much was dropped. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const omitted = (kept: number) => text.length - kept;
  const marker = (kept: number) => `\n\n[... ${omitted(kept)} characters truncated by RevCode (result was ${text.length} characters) ...]\n\n`;
  // Reserve room for the marker, then split the rest 2:1 between head and tail.
  const budget = Math.max(0, max - marker(0).length);
  const head = Math.ceil((budget * 2) / 3);
  const tail = budget - head;
  return `${text.slice(0, head)}${marker(head + tail)}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}
