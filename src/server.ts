import { createServer as createRmsServer } from 'rakuten-rms-mcp';
import { registerContentsTools } from './contents/index.js';

/**
 * The single McpServer for /mcp: existing RMS tools from the core package
 * plus the Contents / R-Cabinet tools. Used as the factory passed to
 * createMcpHandler, so all tools are registered before any request is served.
 */
export function createUnifiedServer() {
  const server = createRmsServer();
  registerContentsTools(server);
  return server;
}
