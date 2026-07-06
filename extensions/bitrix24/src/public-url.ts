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
  const url =
    config?.channels?.bitrix24?.publicUrl ??
    env.BITRIX24_PUBLIC_URL ??
    config?.gateway?.externalUrl ??
    'http://localhost:18789';
  return String(url).replace(/\/$/, '');
}
