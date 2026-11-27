import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'rakuten-rms-mcp';
import { guardMcp, installOutboundGuard } from './security.js';
installOutboundGuard();
import {
  authorizeGet,
  authorizePost,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  registerClient,
  resourceBaseUrl,
  tokenEndpoint,
  tokenVerifier,
} from './oauth.js';

function hostFromUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const withScheme = raw.includes('://') ? raw : `https://${raw}`;
    return new URL(withScheme).hostname;
  } catch {
    return raw.trim().split(':')[0] || undefined;
  }
}

function parseAllowedHosts(): string[] {
  const hosts = new Set<string>(['localhost', '127.0.0.1']);

  const raw = process.env.ALLOWED_HOSTS?.trim();
  if (raw) {
    for (const part of raw.split(',')) {
      const h = part.trim();
      if (h) hosts.add(h);
    }
  }

  // Vercel sets these at runtime — avoid requiring ALLOWED_HOSTS on first deploy
  for (const key of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
    const h = hostFromUrl(process.env[key]);
    if (h) hosts.add(h);
  }

  return [...hosts];
}

/**
 * SDK `requireBearerAuth` + path-aware `resource_metadata` URL (RFC 9728).
 * Host is derived per request so we stay simple without PUBLIC_BASE_URL.
 */
function mcpBearerAuth(req: Request, res: Response, next: NextFunction): void {
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    new URL(`${resourceBaseUrl(req)}/mcp`),
  );
  void requireBearerAuth({
    verifier: tokenVerifier,
    resourceMetadataUrl,
  })(req, res, next);
}

export function buildApp() {
  const allowedHosts = parseAllowedHosts();
  const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts,
  });

  // Needed behind Vercel / reverse proxies for correct https + host in OAuth metadata
  app.set('trust proxy', 1);

  // Urlencoded form for /oauth/authorize POST (passcode form)
  app.use(express.urlencoded({ extended: false }));
  app.use('/oauth', (_req, res, next) => {
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'"});
    next();
  });

  app.get('/health', (_req, res) => {
    res.type('text').send('ok');
  });

  app.get('/.well-known/oauth-authorization-server', oauthAuthorizationServerMetadata);
  // Root + path-aware (/.well-known/oauth-protected-resource/mcp) for RFC 9728 clients
  app.get('/.well-known/oauth-protected-resource', oauthProtectedResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', oauthProtectedResourceMetadata);
  app.post('/oauth/register', registerClient);
  app.get('/oauth/authorize', authorizeGet);
  app.post('/oauth/authorize', authorizePost);
  app.post('/oauth/token', tokenEndpoint);

  const mcpHandler = createMcpHandler(createServer);
  const node = toNodeHandler(mcpHandler);

  const mcpMount = (req: Request, res: Response) => {
    void node(req, res, req.body);
  };

  // Bearer only on /mcp (OAuth AS routes stay public)
  app.all('/mcp', mcpBearerAuth, guardMcp, mcpMount);
  app.all('/mcp/', mcpBearerAuth, guardMcp, mcpMount);

  return app;
}

// Vercel Express entry looks for src/app.ts default export
export default buildApp();

