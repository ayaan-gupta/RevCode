/**
 * MCP (Model Context Protocol) client for RevCode.
 *
 *   const config = await loadMcpConfig(cwd);
 *   const mcp = new McpManager(config, { cwd });
 *   await mcp.start();
 *   for (const tool of mcp.tools()) registry.register(tool);
 *
 * See `manager.ts` for behaviour and `config.ts` for the config format.
 */

export {
  loadMcpConfig,
  mcpConfigPaths,
  parseMcpConfig,
  expandEnv,
  type LoadedMcpConfig,
  type LoadMcpConfigOptions,
  type McpServerConfig,
  type McpStdioServerConfig,
  type McpRemoteServerConfig,
  type McpTransportKind,
} from "./config.js";
export {
  McpManager,
  truncateMiddle,
  type McpManagerOptions,
  type McpServerState,
  type McpServerStatus,
} from "./manager.js";
export {
  McpClient,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type McpClientOptions,
  type McpInitializeResult,
  type McpToolInfo,
} from "./client.js";
export { StdioTransport, type StdioTransportOptions } from "./transport-stdio.js";
export {
  StreamableHttpTransport,
  LegacySseTransport,
  createHttpTransport,
  type HttpTransportOptions,
} from "./transport-http.js";
export { convertToolResult, type McpToolOutput } from "./tool-result.js";
export { assignToolNames, sanitizeNamePart, MAX_TOOL_NAME_LENGTH } from "./tool-names.js";
export { McpError, ErrorCode, type McpTransport } from "./types.js";
