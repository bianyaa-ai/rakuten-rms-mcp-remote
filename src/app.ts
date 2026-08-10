import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'rakuten-rms-mcp';
import {
  authorizeGet,
  authorizePost,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  registerClient,
  resourceBaseUrl,
  tokenEndpoint,
  validateBearer,
} from './oauth.js';

const PUBLIC_PATHS = new Set([
  '/health',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
]);

function parseAllowedHosts(): string[] {
  const raw = process.env.ALLOWED_HOSTS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return ['localhost', '127.0.0.1'];
}

function bearerGuard(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/oauth/')) {
    next();
    return;
  }

  const auth = req.header('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${resourceBaseUrl(req)}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({ error: 'Missing Bearer token' });
    return;
  }

  const token = auth.slice('Bearer '.length).trim();
  if (!validateBearer(token)) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer error="invalid_token", resource_metadata="${resourceBaseUrl(req)}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  next();
}

export function buildApp() {
  const allowedHosts = parseAllowedHosts();
  const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts,
  });

  // Urlencoded form for /oauth/authorize POST (passcode form)
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (_req, res) => {
    res.type('text').send('ok');
  });

  app.get('/.well-known/oauth-authorization-server', oauthAuthorizationServerMetadata);
  app.get('/.well-known/oauth-protected-resource', oauthProtectedResourceMetadata);
  app.post('/oauth/register', registerClient);
  app.get('/oauth/authorize', authorizeGet);
  app.post('/oauth/authorize', authorizePost);
  app.post('/oauth/token', tokenEndpoint);

  const mcpHandler = createMcpHandler(createServer);
  const node = toNodeHandler(mcpHandler);

  // Auth for MCP only. Path normalize: clients may hit /mcp without slash.
  const mcpMount = (req: Request, res: Response) => {
    void node(req, res, req.body);
  };

  app.all('/mcp', bearerGuard, mcpMount);
  app.all('/mcp/', bearerGuard, mcpMount);

  return app;
}
