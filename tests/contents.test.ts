import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { resetOAuthStoreForTests } from '../src/oauth.js';
import {
  CONTENTS_TOOL_NAMES,
  CONTENTS_WRITE_TOOLS,
  contentsHealthPayload,
} from '../src/contents/index.js';

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
    delete process.env.RMS_MCP_ENABLE_WRITE;
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

  it('contents_health describes shared Bearer auth and no global write gate', async () => {
    process.env.RMS_SERVICE_SECRET = 'sekret-health';
    process.env.RMS_LICENSE_KEY = 'license-health';
    await withServer(async (rpc) => {
      const res = await rpc('tools/call', { name: 'contents_health', arguments: {} });
      const text = res.content?.[0]?.text ?? '';
      const j = JSON.parse(text) as Record<string, unknown>;
      expect(j.authentication).toBe('shared-bearer');
      expect(j.authenticationMethods).toEqual(['oauth2.1-access-token', 'static-bearer-api-key']);
      expect(j.globalWriteGate).toBe(false);
      expect(j).not.toHaveProperty('writeEnabled');
      expect(j).not.toHaveProperty('writeEnvVar');
      expect(j.writeTools).toEqual([...CONTENTS_WRITE_TOOLS]);
      expect(text.toLowerCase()).not.toContain('auth0');
      for (const secret of ['sekret-health', 'license-health', KEY, 'test-pass-123'])
        expect(text).not.toContain(secret);
    });
  });

  it('operation-level confirmations block unapproved writes before any network call', async () => {
    // Credentials present so a missing confirmation is the only thing that can stop the call.
    process.env.RMS_SERVICE_SECRET = 'sekret-x';
    process.env.RMS_LICENSE_KEY = 'license-x';
    const fetchSpy = vi.fn(async () => {
      throw new Error('network must not be used');
    });
    await withServer(async (rpc) => {
      vi.stubGlobal('fetch', ((...a: Parameters<typeof fetch>) =>
        String(a[0]).includes('127.0.0.1') ? realFetch(...a) : fetchSpy()) as typeof fetch);
      const unapproved: Record<string, Record<string, unknown>> = {
        cabinet_upload_image: { confirmUpload: false },
        contents_create: { confirmCreate: false },
        contents_update: { confirmUpdate: false },
        contents_widget_create: { confirmCreate: false },
      };
      for (const name of CONTENTS_WRITE_TOOLS) {
        const res = await rpc('tools/call', {
          name,
          arguments: { ...(WRITE_CALLS[name] as object), ...unapproved[name] },
        });
        expect(res.isError, name).toBe(true);
      }
      // Missing confirmation entirely is also rejected.
      const res = await rpc('tools/call', {
        name: 'contents_widget_create',
        arguments: { widget: (WRITE_CALLS.contents_widget_create as { widget: unknown }).widget },
      });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe('新規登録の承認が必要です');
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no global env flag blocks confirmed Contents writes (stubbed fetch only)', async () => {
    process.env.RMS_SERVICE_SECRET = 'sekret-x';
    process.env.RMS_LICENSE_KEY = 'license-x';
    const widgetId = '44444444-4444-4444-8444-444444444444';
    const calls: { url: string; dry: string | null }[] = [];
    await withServer(async (rpc) => {
      vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('127.0.0.1')) return realFetch(input, init);
        const dry = new Headers(init?.headers).get('x-dry-run');
        calls.push({ url, dry });
        const body = JSON.parse(String(init?.body)) as { type: string; body: unknown[] };
        const payload = dry === 'true' ? { type: body.type, body: body.body } : { widgetId };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch);
      const res = await rpc('tools/call', {
        name: 'contents_widget_create',
        arguments: WRITE_CALLS.contents_widget_create,
      });
      expect(res.isError).toBeUndefined();
      expect(JSON.parse(res.content?.[0]?.text ?? '{}')).toMatchObject({ registered: true, widgetId });
    });
    // Mandatory validation request first, then exactly one creation request.
    expect(calls.map((c) => c.dry)).toEqual(['true', 'false']);
    // Every Rakuten-bound request was intercepted by the stub (no real network).
    expect(calls.every((c) => c.url === 'https://api.rms.rakuten.co.jp/es/1.0/shop-page/widgets')).toBe(true);
  });

  it('widget create sends no second request if the validation response already registered it', async () => {
    process.env.RMS_SERVICE_SECRET = 'sekret-x';
    process.env.RMS_LICENSE_KEY = 'license-x';
    const widgetId = '55555555-5555-4555-8555-555555555555';
    let count = 0;
    await withServer(async (rpc) => {
      vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('127.0.0.1')) return realFetch(input, init);
        count++;
        const body = JSON.parse(String(init?.body)) as { type: string; body: unknown[] };
        // Simulates Rakuten ignoring X-Dry-Run.
        return new Response(JSON.stringify({ type: body.type, body: body.body, widgetId }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch);
      const res = await rpc('tools/call', {
        name: 'contents_widget_create',
        arguments: WRITE_CALLS.contents_widget_create,
      });
      const j = JSON.parse(res.content?.[0]?.text ?? '{}') as Record<string, unknown>;
      expect(j.registered).toBe(true);
      expect(j.widgetId).toBe(widgetId);
      expect(String(j.warning)).toContain('widgetId');
    });
    expect(count).toBe(1);
  });

  it('contents_widget_validate is documented as unverified and not read-only', async () => {
    await withServer(async (rpc) => {
      const tool = ((await rpc('tools/list')) as unknown as {
        tools: { name: string; description?: string; annotations?: Record<string, unknown> }[];
      }).tools.find((t) => t.name === 'contents_widget_validate');
      expect(tool?.annotations?.readOnlyHint).toBe(false);
      expect(tool?.description).toContain('未確認');
      expect(tool?.description).not.toContain('一切行わない');
    });
  });

  it('read-only Contents tools reach their own body without any write env var', async () => {
    await withServer(async (rpc) => {
      // No Rakuten credentials: fails inside the tool, not in a gate.
      const res = await rpc('tools/call', { name: 'cabinet_list_folders', arguments: {} });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).not.toMatch(/disabled|RMS_CONTENTS_ENABLE_WRITE/);
    });
  });

  it('write tools are not gated when RMS_*_ENABLE_WRITE variables are absent or false', async () => {
    process.env.RMS_CONTENTS_ENABLE_WRITE = 'false';
    process.env.RMS_MCP_ENABLE_WRITE = 'false';
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

describe('contents write tool list', () => {
  it('lists exactly the four write tools', () => {
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
