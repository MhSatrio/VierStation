// Thin fetch wrapper. Every mutating call carries X-VS (CSRF guard); JSON in/out; errors become ApiError with the server's message.
export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, message: string, code = 'error') { super(message); this.status = status; this.code = code; }
}

export async function api<T = any>(method: string, path: string, body?: unknown, init: { raw?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  const mutating = method !== 'GET';
  let res: Response;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin', signal: init.signal,
      headers: { ...(mutating ? { 'x-vs': '1' } : {}), ...(body !== undefined || init.raw ? { 'content-type': init.raw ? 'application/octet-stream' : 'application/json' } : {}), ...init.headers },
      body: init.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'Cannot reach the local VierStation server. Is it still running?', 'network');
  }
  const text = await res.text();
  let data: any = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code);
  }
  return data as T;
}
export const get = <T = any>(p: string, signal?: AbortSignal) => api<T>('GET', p, undefined, { signal });
export const post = <T = any>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const patch = <T = any>(p: string, b: unknown = {}) => api<T>('PATCH', p, b);
export const put = <T = any>(p: string, b: unknown = {}) => api<T>('PUT', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);
