import { ApiError } from './api';

/**
 * POST a multipart form that may hold a file picked from the phone (`{ uri, name, type }`).
 *
 * Expo replaces the global `fetch` with its own, which cannot read those `uri` file parts and
 * throws before anything is sent. XMLHttpRequest is React Native's own path for them (the chat
 * attachment upload and hold-to-talk use it), so this uses that.
 */
export function postForm<T>(url: string, token: string, form: FormData,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; opts.signal?.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => { xhr.abort(); finish(() => reject(new ApiError('Cancelled', -1))); };
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.timeout = opts.timeoutMs ?? 10000;
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) finish(() => resolve(data as T));
      else finish(() => reject(new ApiError(data?.error || `Server returned ${xhr.status}`, xhr.status, data)));
    };
    xhr.onerror = () => finish(() => reject(new ApiError("Can't reach your Hermes server. Check that the gateway is running and the address is accessible from your phone. If you use Tailscale, connect it on this phone.", 0)));
    xhr.ontimeout = () => finish(() => reject(new ApiError("Can't reach your Hermes server. Check that the gateway is running and the address is accessible from your phone. If you use Tailscale, connect it on this phone.", 0)));
    xhr.onabort = () => finish(() => reject(new ApiError('Cancelled', -1)));
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(form);
  });
}
