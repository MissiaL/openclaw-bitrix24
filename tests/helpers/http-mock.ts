import { vi } from 'vitest';

/**
 * Stub global `fetch` and route it to two mocks that resolve with
 * `{ data, headers?, status? }`:
 *   mockPost('/<method>', body) — Bitrix24 REST calls (method = last URL segment)
 *   mockGet(url)               — OAuth refresh and file downloads
 * A Buffer `data` becomes the raw body; anything else is sent as JSON.
 */
export function mockHttp() {
  const mockPost = vi.fn();
  const mockGet = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const res =
        init?.method === 'POST'
          ? await mockPost(`/${new URL(url).pathname.split('/').pop()}`, JSON.parse(String(init.body)))
          : await mockGet(url);
      const { data, headers, status = 200 } = res ?? {};
      const body = Buffer.isBuffer(data) ? data : data === undefined ? null : JSON.stringify(data);
      return new Response(body, { status, headers });
    }),
  );
  return { mockPost, mockGet };
}
