import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { resetOAuthStoreForTests } from '../src/oauth.js';
import {
  CONTENTS_WRITE_DISABLED_MESSAGE,
  CONTENTS_WRITE_TOOLS,
  contentsWriteBlockedResult,
  isContentsWriteEnabled,
} from '../src/contents/gate.js';
import { CONTENTS_TOOL_NAMES, contentsHealthPayload } from '../src/contents/index.js';

const KEY = 'static-key-xyz';
const READ_ONLY_CONTENTS = CONTENTS_TOOL_NAMES.filter(
  (n) => !(CONTENTS_WRITE_TOOLS as readonly string[]).includes(n),
);

type RpcResult = {
  tools?: { name: string }[];
  isError?: boolean;
  content?: { type: string; text: string }[];
};

async function withServer<T>(fn: (rpc: (method: string, params?: unknown) => Promise<RpcResult>) => Promise<T>) {
  const server = buildApp().listen(0);
  const { port } = server.address() as { port: number };
  let id = 0;
  const rpc = async (method: string, params?: unknown): Promise<RpcResult> => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    const json = text.trimStart().startsWith('{')
      ? text
      : (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
    const msg = JSON.parse(json) as { result?: RpcResult; error?: unknown };
    expect(msg.error).toBeUndefined();
    return msg.result as RpcResult;
  };
  try {
    return await fn(rpc);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const WRITE_CALLS: Record<string, unknown> = {
  cabinet_upload_image: { imageUrl: 'https://example.com/a.jpg', confirmUpload: true },
  contents_create: {
    title: 't',
    location: 'loc',
    thumbnailPath: '/ai-contents/a.jpg',
    description: 'd',
    widgetIds: ['11111111-1111-4111-8111-111111111111'],
    confirmCreate: true,
  },
  contents_update: {
    layoutId: '11111111-1111-4111-8111-111111111111',
    location: 'loc',
    widgetIds: ['22222222-2222-4222-8222-222222222222'],
    expectedRevisionId: '33333333-3333-4333-8333-333333333333',
    confirmUpdate: true,
  },
  contents_widget_create: {
    widget: { type: 'TITLE', body: [{ displayType: 'TEXT', title: 'x' }] },
    confirmCreate: true,
  },
};

describe('unified /mcp tool registration', () => {
  beforeEach(() => {
    resetOAuthStoreForTests();
    process.env.RMS_MCP_OAUTH_PASSCODE = 'test-pass-123';
    process.env.RMS_MCP_API_KEY = KEY;
    process.env.ALLOWED_HOSTS = 'localhost,127.0.0.1';
    delete process.env.RMS_CONTENTS_ENABLE_WRITE;
    delete process.env.RMS_SERVICE_SECRET;
    delete process.env.RMS_LICENSE_KEY;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.RMS_CONTENTS_ENABLE_WRITE;
  });

  it('lists RMS and Contents tools on one endpoint with unique names', async () => {
    await withServer(async (rpc) => {
      const names = ((await rpc('tools/list')).tools ?? []).map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain('rms_health');
      expect(names).toContain('rms_daily_sales');
      for (const n of CONTENTS_TOOL_NAMES) expect(names).toContain(n);
      expect(CONTENTS_TOOL_NAMES).toHaveLength(10);
    });
  });

  it('contents_health reports unified auth, no Auth0, write gate off', async () => {
    await withServer(async (rpc) => {
      const res = await rpc('tools/call', { name: 'contents_health', arguments: {} });
      const text = res.content?.[0]?.text ?? '';
      const j = JSON.parse(text) as Record<string, unknown>;
      expect(j.authentication).toBe('unified-mcp-oauth');
      expect(j.writeEnabled).toBe(false);
      expect(text.toLowerCase()).not.toContain('auth0');
    });
  });

  it('blocks every Contents write tool by default without any network call', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network must not be used');
    });
    await withServer(async (rpc) => {
      vi.stubGlobal('fetch', ((...a: Parameters<typeof fetch>) =>
        String(a[0]).includes('127.0.0.1') ? realFetch(...a) : fetchSpy()) as typeof fetch);
      for (const name of CONTENTS_WRITE_TOOLS) {
        const res = await rpc('tools/call', { name, arguments: WRITE_CALLS[name] });
        expect(res.isError, name).toBe(true);
        expect(res.content?.[0]?.text, name).toBe(CONTENTS_WRITE_DISABLED_MESSAGE);
      }
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('read-only Contents tools are not gated', async () => {
    await withServer(async (rpc) => {
      // No Rakuten credentials: reaches the tool body, fails there, not at the gate.
      const res = await rpc('tools/call', { name: 'cabinet_list_folders', arguments: {} });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).not.toBe(CONTENTS_WRITE_DISABLED_MESSAGE);
    });
  });

  it('with the gate open, write tools run their own approval checks', async () => {
    process.env.RMS_CONTENTS_ENABLE_WRITE = 'true';
    await withServer(async (rpc) => {
      const res = await rpc('tools/call', {
        name: 'contents_widget_create',
        arguments: { ...(WRITE_CALLS.contents_widget_create as object), confirmCreate: false },
      });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe('新規登録の承認が必要です');
    });
  });
});

const realFetch = globalThis.fetch;

describe('contents write gate', () => {
  it('is off unless explicitly "true"', () => {
    expect(isContentsWriteEnabled({})).toBe(false);
    for (const v of ['', 'false', '1', 'yes', 'on', 'truee'])
      expect(isContentsWriteEnabled({ RMS_CONTENTS_ENABLE_WRITE: v })).toBe(false);
    expect(isContentsWriteEnabled({ RMS_CONTENTS_ENABLE_WRITE: 'true' })).toBe(true);
    expect(isContentsWriteEnabled({ RMS_CONTENTS_ENABLE_WRITE: ' TRUE ' })).toBe(true);
  });

  it('is independent of RMS_MCP_ENABLE_WRITE', () => {
    expect(isContentsWriteEnabled({ RMS_MCP_ENABLE_WRITE: 'true' })).toBe(false);
    expect(contentsWriteBlockedResult({ RMS_MCP_ENABLE_WRITE: 'true' })?.isError).toBe(true);
    expect(contentsWriteBlockedResult({ RMS_CONTENTS_ENABLE_WRITE: 'true' })).toBeNull();
  });

  it('gates exactly the four write tools', () => {
    expect([...CONTENTS_WRITE_TOOLS].sort()).toEqual([
      'cabinet_upload_image',
      'contents_create',
      'contents_update',
      'contents_widget_create',
    ]);
    expect(READ_ONLY_CONTENTS).toHaveLength(6);
  });

  it('health payload never contains secret values', () => {
    const p = JSON.stringify(
      contentsHealthPayload({ RMS_SERVICE_SECRET: 'sekret-1', RMS_LICENSE_KEY: 'lic-2' }),
    );
    expect(p).not.toContain('sekret-1');
    expect(p).not.toContain('lic-2');
    expect(p).toContain('"rmsCredentialsConfigured":true');
  });
});
