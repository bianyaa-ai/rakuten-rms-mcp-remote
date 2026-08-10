/**
 * Minimal OAuth 2.0 + PKCE for Claude.ai / ChatGPT MCP connectors.
 * Gate is a shared passcode (RMS_MCP_OAUTH_PASSCODE), same model as Python rms-mcp.
 *
 * Token verification follows the MCP Resource Server shape
 * (`OAuthTokenVerifier` → `AuthInfo` with `expiresAt`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';

const ACCESS_TOKEN_TTL = 30 * 24 * 3600;
const AUTH_CODE_TTL = 600;

type ClientRecord = {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_name: string;
};

type AuthCode = {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  expires_at: number;
  used: boolean;
};

type AccessToken = {
  token: string;
  client_id: string;
  scope: string;
  expires_at: number;
};

type PendingAuth = {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  expires_at: number;
};

const store = {
  clients: new Map<string, ClientRecord>(),
  authCodes: new Map<string, AuthCode>(),
  accessTokens: new Map<string, AccessToken>(),
};

const pendingAuth = new Map<string, PendingAuth>();

function storePath(): string | undefined {
  const raw = process.env.RMS_MCP_OAUTH_STORE_PATH?.trim();
  return raw || undefined;
}

function loadFromDisk(): void {
  const p = storePath();
  if (!p || !fs.existsSync(p)) return;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      clients?: Record<string, ClientRecord>;
      access_tokens?: Record<
        string,
        { client_id: string; scope: string; expires_at: number }
      >;
    };
    const now = Date.now() / 1000;
    for (const [id, c] of Object.entries(data.clients ?? {})) {
      store.clients.set(id, c);
    }
    for (const [tok, t] of Object.entries(data.access_tokens ?? {})) {
      if (t.expires_at > now) {
        store.accessTokens.set(tok, {
          token: tok,
          client_id: t.client_id,
          scope: t.scope,
          expires_at: t.expires_at,
        });
      }
    }
  } catch {
    // ignore corrupt store
  }
}

function saveToDisk(): void {
  const p = storePath();
  if (!p) return;
  const now = Date.now() / 1000;
  const payload = {
    clients: Object.fromEntries(store.clients),
    access_tokens: Object.fromEntries(
      [...store.accessTokens.entries()]
        .filter(([, t]) => t.expires_at > now)
        .map(([tok, t]) => [
          tok,
          { client_id: t.client_id, scope: t.scope, expires_at: t.expires_at },
        ]),
    ),
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, p);
}

loadFromDisk();

export function resetOAuthStoreForTests(): void {
  store.clients.clear();
  store.authCodes.clear();
  store.accessTokens.clear();
  pendingAuth.clear();
}

function passcode(): string | undefined {
  return process.env.RMS_MCP_OAUTH_PASSCODE?.trim() || undefined;
}

export function resourceBaseUrl(req: Request): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
    req.protocol;
  const host =
    (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ||
    req.get('host') ||
    'localhost';
  return `${proto}://${host}`;
}

function constantTimeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
  return constantTimeEq(digest, challenge);
}

function scopesFrom(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

/**
 * MCP `OAuthTokenVerifier`: populates `expiresAt` (required by SDK bearer auth).
 */
export async function verifyAccessToken(token: string): Promise<AuthInfo> {
  const apiKey = process.env.RMS_MCP_API_KEY?.trim();
  if (apiKey && constantTimeEq(token, apiKey)) {
    return {
      token,
      clientId: 'api-key',
      scopes: ['mcp'],
      expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL,
    };
  }

  const rec = store.accessTokens.get(token);
  if (!rec || rec.expires_at < Date.now() / 1000) {
    if (rec) store.accessTokens.delete(token);
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired token');
  }

  return {
    token,
    clientId: rec.client_id,
    scopes: scopesFrom(rec.scope || 'mcp'),
    expiresAt: Math.floor(rec.expires_at),
  };
}

export const tokenVerifier: OAuthTokenVerifier = { verifyAccessToken };

export function oauthAuthorizationServerMetadata(req: Request, res: Response): void {
  const base = resourceBaseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
}

export function oauthProtectedResourceMetadata(req: Request, res: Response): void {
  const base = resourceBaseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  });
}

export async function registerClient(req: Request, res: Response): Promise<void> {
  const body = req.body as { redirect_uris?: unknown; client_name?: string };
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris is required',
    });
    return;
  }
  const clientId = `client_${crypto.randomBytes(16).toString('base64url')}`;
  const record: ClientRecord = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris.map(String),
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_name: body.client_name ?? 'mcp-client',
  };
  store.clients.set(clientId, record);
  saveToDisk();
  res.status(201).json(record);
}

function authorizeForm(opts: {
  clientName: string;
  stateToken: string;
  redirectUri: string;
  errorHtml?: string;
}): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<title>rakuten-rms-mcp-remote authorize</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:420px;margin:80px auto;padding:0 20px;color:#222}
h1{font-size:20px}
.box{border:1px solid #ddd;border-radius:8px;padding:20px}
input[type=password]{width:100%;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:10px;font-size:16px;background:#225533;color:#fff;border:0;border-radius:6px;cursor:pointer}
.err{color:#b33;margin-top:10px}
.meta{color:#666;font-size:13px;margin-top:14px}
</style></head>
<body>
<h1>rakuten-rms-mcp に接続を許可</h1>
<div class="box">
  <p>${opts.clientName} から接続要求があります。</p>
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="state_token" value="${opts.stateToken}">
    <input type="password" name="passcode" placeholder="共有パスコード" autofocus required>
    <button type="submit">許可する</button>
  </form>
  ${opts.errorHtml ?? ''}
  <p class="meta">redirect_uri: ${opts.redirectUri}</p>
</div>
</body></html>`;
}

export function authorizeGet(req: Request, res: Response): void {
  const clientId = String(req.query.client_id ?? '');
  const redirectUri = String(req.query.redirect_uri ?? '');
  const responseType = String(req.query.response_type ?? '');
  const state = String(req.query.state ?? '');
  const codeChallenge = String(req.query.code_challenge ?? '');
  const codeChallengeMethod = String(req.query.code_challenge_method ?? '');
  const scope = String(req.query.scope ?? 'mcp');

  if (responseType !== 'code') {
    res.status(400).send('unsupported_response_type');
    return;
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    res.status(400).send('PKCE S256 required');
    return;
  }
  const client = store.clients.get(clientId);
  if (!client) {
    res.status(400).send('unknown client_id');
    return;
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    res.status(400).send('redirect_uri not registered');
    return;
  }

  const stateToken = crypto.randomBytes(24).toString('base64url');
  pendingAuth.set(stateToken, {
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    scope,
    expires_at: Date.now() / 1000 + 600,
  });

  res.type('html').send(
    authorizeForm({
      clientName: client.client_name || 'MCP client',
      stateToken,
      redirectUri,
    }),
  );
}

export function authorizePost(req: Request, res: Response): void {
  const stateToken = String(req.body?.state_token ?? '');
  const submitted = String(req.body?.passcode ?? '');
  const pending = pendingAuth.get(stateToken);
  if (!pending || pending.expires_at < Date.now() / 1000) {
    res.status(400).send('Session expired. Please retry from the MCP client.');
    return;
  }
  const serverPass = passcode();
  if (!serverPass) {
    res.status(503).send('Server misconfigured: RMS_MCP_OAUTH_PASSCODE not set');
    return;
  }
  if (!constantTimeEq(submitted, serverPass)) {
    const client = store.clients.get(pending.client_id);
    res
      .status(401)
      .type('html')
      .send(
        authorizeForm({
          clientName: client?.client_name || 'MCP client',
          stateToken,
          redirectUri: pending.redirect_uri,
          errorHtml: '<p class="err">パスコードが違います</p>',
        }),
      );
    return;
  }

  const code = crypto.randomBytes(32).toString('base64url');
  store.authCodes.set(code, {
    code,
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    code_challenge_method: pending.code_challenge_method,
    scope: pending.scope,
    expires_at: Date.now() / 1000 + AUTH_CODE_TTL,
    used: false,
  });
  pendingAuth.delete(stateToken);

  const url = new URL(pending.redirect_uri);
  url.searchParams.set('code', code);
  if (pending.state) url.searchParams.set('state', pending.state);
  res.redirect(302, url.toString());
}

export function tokenEndpoint(req: Request, res: Response): void {
  const grantType = String(req.body?.grant_type ?? '');
  if (grantType !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  const code = String(req.body?.code ?? '');
  const redirectUri = String(req.body?.redirect_uri ?? '');
  const clientId = String(req.body?.client_id ?? '');
  const codeVerifier = String(req.body?.code_verifier ?? '');

  const ac = store.authCodes.get(code);
  if (!ac || ac.used || ac.expires_at < Date.now() / 1000) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  if (ac.client_id !== clientId || ac.redirect_uri !== redirectUri) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  if (!verifyPkce(codeVerifier, ac.code_challenge)) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE failed' });
    return;
  }

  ac.used = true;
  const accessToken = crypto.randomBytes(32).toString('base64url');
  store.accessTokens.set(accessToken, {
    token: accessToken,
    client_id: clientId,
    scope: ac.scope,
    expires_at: Date.now() / 1000 + ACCESS_TOKEN_TTL,
  });
  saveToDisk();

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    scope: ac.scope,
  });
}
