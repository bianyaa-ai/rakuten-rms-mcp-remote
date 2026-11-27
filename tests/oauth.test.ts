import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from '../src/app.js';
import { resetOAuthStoreForTests } from '../src/oauth.js';
describe('oauth + bearer', () => {
  beforeEach(() => {
    resetOAuthStoreForTests();
    process.env.RMS_MCP_OAUTH_PASSCODE = 'test-pass-123';
    process.env.RMS_MCP_API_KEY = 'static-key-xyz';
    process.env.ALLOWED_HOSTS = 'localhost,127.0.0.1';
  });

  it('serves oauth metadata', async () => {
    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const r = await fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`,
      );
      expect(r.status).toBe(200);
      const j = (await r.json()) as { authorization_endpoint: string };
      expect(j.authorization_endpoint).toContain('/oauth/authorize');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects /mcp without bearer and advertises path-aware metadata', async () => {
    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          host: '127.0.0.1',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }),
      });
      expect(r.status).toBe(401);
      const www = r.headers.get('www-authenticate') ?? '';
      expect(www).toContain('/.well-known/oauth-protected-resource/mcp');
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe('invalid_token');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serves path-aware protected resource metadata', async () => {
    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const r = await fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`,
      );
      expect(r.status).toBe(200);
      const j = (await r.json()) as { resource: string };
      expect(j.resource).toContain('/mcp');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('accepts static API key bearer', async () => {
    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer static-key-xyz',
          host: '127.0.0.1',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.1' },
          },
        }),
      });
      // 200 or 406 depending on Accept negotiation; must not be 401
      expect(r.status).not.toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('registers client and completes oauth with passcode', async () => {
    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const base = `http://127.0.0.1:${port}`;

      const reg = await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Test',
          redirect_uris: ['https://example.com/cb'],
        }),
      });
      expect(reg.status).toBe(201);
      const { client_id } = (await reg.json()) as { client_id: string };

      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

      const authUrl = new URL(`${base}/oauth/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', client_id);
      authUrl.searchParams.set('redirect_uri', 'https://example.com/cb');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', 'xyz');

      const formPage = await fetch(authUrl);
      expect(formPage.status).toBe(200);
      const html = await formPage.text();
      const stateToken = html.match(/name="state_token" value="([^"]+)"/)?.[1];
      expect(stateToken).toBeTruthy();

      const allow = await fetch(`${base}/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          state_token: stateToken!,
          passcode: 'test-pass-123',
        }),
        redirect: 'manual',
      });
      expect(allow.status).toBe(302);
      const loc = allow.headers.get('location')!;
      const code = new URL(loc).searchParams.get('code');
      expect(code).toBeTruthy();

      const tokenRes = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          redirect_uri: 'https://example.com/cb',
          client_id,
          code_verifier: verifier,
        }),
      });
      expect(tokenRes.status).toBe(200);
      const tok = (await tokenRes.json()) as { access_token: string };
      expect(tok.access_token).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
