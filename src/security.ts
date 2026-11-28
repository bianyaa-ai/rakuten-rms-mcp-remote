/**
 * Outbound network guard.
 *
 * This module intentionally contains NO request allowlist and NO global
 * read/write gate. Authentication is enforced by the /mcp Bearer middleware in
 * app.ts (OAuth 2.1 access token or static Bearer API key), and write safety
 * is enforced per operation inside each tool (explicit confirmations, strict
 * schemas, duplicate prevention, revision checks, ...). Any RMS tool,
 * read or write, must stay callable by an authenticated client.
 */
let installed = false;

/**
 * Ensures requests that carry RMS ESA credentials only go to the official
 * RMS HTTPS origin and never follow redirects. Not installed by default.
 */
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
