import type { NextFunction, Request as ExpressRequest, Response } from 'express';

const READ_TOOLS = new Set([
  'rms_health', 'rms_daily_sales', 'rms_product_ranking', 'rms_cancel_rate',
  'rms_search_products', 'rms_all_products', 'rms_get_product', 'rms_bulk_get_products',
  'rms_get_inventory', 'rms_get_inventory_related_settings', 'rms_get_variant_inventory',
  'rms_bulk_get_inventory', 'rms_bulk_get_inventory_range', 'rms_get_variant_lists',
  'rms_search_coupons', 'rms_get_coupon', 'rms_thanks_coupon_get', 'rms_thanks_coupon_search',
]);
const PROTOCOL = new Set(['initialize','notifications/initialized','notifications/cancelled','ping','tools/list']);
export function allowedCall(body: unknown, writeEnabled = false): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const msg = body as {method?: unknown; params?: {name?: unknown}};
  if (typeof msg.method !== 'string') return false;
  if (PROTOCOL.has(msg.method)) return true;
  if (msg.method !== 'tools/call' || typeof msg.params?.name !== 'string') return false;
  return writeEnabled || READ_TOOLS.has(msg.params.name);
}
export function guardMcp(req: ExpressRequest, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    if (req.method === 'GET' || req.method === 'DELETE') { next(); return; }
    res.sendStatus(405); return;
  }
  if (!allowedCall(req.body, process.env.RMS_MCP_ENABLE_WRITE === 'true')) {
    res.status(403).json({jsonrpc:'2.0', id: req.body?.id ?? null, error:{code:-32000,message:'Operation blocked by RMS security policy'}});
    return;
  }
  next();
}
let installed = false;
export function installOutboundGuard(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // All RMS ESA requests must go directly to the official HTTPS origin.
    if (/^ESA\s/i.test(headers.get('authorization') ?? '')) {
      if (url.origin !== 'https://api.rms.rakuten.co.jp' || url.username || url.password) {
        throw new Error('Blocked non-RMS destination');
      }
      return original(input, {...init, redirect:'error'});
    }
    return original(input, init);
  };
}
