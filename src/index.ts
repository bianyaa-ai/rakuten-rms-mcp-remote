#!/usr/bin/env node
import { hasCredentials } from 'rakuten-rms-mcp';
import { buildApp } from './app.js';

const app = buildApp();

function requireAuthConfig(): void {
  const hasPass = Boolean(process.env.RMS_MCP_OAUTH_PASSCODE?.trim());
  const hasKey = Boolean(process.env.RMS_MCP_API_KEY?.trim());
  if (!hasPass && !hasKey) {
    console.error(
      'Set RMS_MCP_OAUTH_PASSCODE (for Claude/ChatGPT OAuth) and/or RMS_MCP_API_KEY (static Bearer).',
    );
    process.exit(1);
  }
}

function startLocal(): void {
  requireAuthConfig();
  if (!hasCredentials()) {
    console.error('Set RMS_SERVICE_SECRET and RMS_LICENSE_KEY before starting.');
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? '8000');
  app.listen(port, '0.0.0.0', () => {
    console.error(`rakuten-rms-mcp-remote listening on 0.0.0.0:${port}`);
    console.error(`MCP endpoint: http://127.0.0.1:${port}/mcp`);
  });
}

// Vercel imports this module and uses the default export (no listen).
if (!process.env.VERCEL) {
  startLocal();
}

export default app;
