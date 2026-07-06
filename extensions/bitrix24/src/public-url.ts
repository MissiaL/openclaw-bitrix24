/**
 * Resolve the externally reachable base URL for Bitrix24 event handlers.
 *
 * Priority: explicit channel config > env var > legacy gateway.externalUrl
 * (removed from the config schema in openclaw 2026.6, kept for older hosts)
 * > local gateway default.
 */
export function resolvePublicUrl(
  config: Record<string, any> | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  // Use `||` (not `??`) so an empty/whitespace-only string at any tier falls
  // through to the next one instead of winning and producing relative URLs.
  const url =
    normalize(config?.channels?.bitrix24?.publicUrl) ||
    normalize(env.BITRIX24_PUBLIC_URL) ||
    normalize(config?.gateway?.externalUrl) ||
    'http://localhost:18789';
  return url.replace(/\/$/, '');
}

function normalize(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}
