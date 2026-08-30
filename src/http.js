import { ApiError, TransportError, redactText } from './errors.js';
import { sanitize } from './sanitize.js';

export class GatewayClient {
  constructor({ baseUrl, token, appSessionHeaders = {}, knownSecrets = [], timeoutMs = 10_000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.appSessionHeaders = appSessionHeaders;
    this.secrets = [...new Set([token, ...Object.values(appSessionHeaders), ...knownSecrets])]
      .filter((value) => typeof value === 'string' && value.length > 0);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  headers(extra = {}) {
    const headers = { Accept: 'application/json', ...this.appSessionHeaders, ...extra };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  async api(method, body, { signal } = {}) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const init = {
      method: 'POST',
      headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      redirect: 'error',
      signal: controller.signal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/${encodeURIComponent(method)}`, init);
      if (!response.ok) {
        throw new ApiError(`API ${method} が拒否されました (HTTP ${response.status})`, response.status);
      }
      let value;
      try {
        value = await response.json();
      } catch {
        throw new TransportError(`API ${method} のJSON responseが不正です`);
      }
      return sanitize(value, new WeakSet(), this.secrets);
    } catch (error) {
      if (error instanceof ApiError || error instanceof TransportError) throw error;
      const detail = error?.name === 'AbortError' ? 'timeout' : '接続エラー';
      throw new TransportError(redactText(`API ${method}: ${detail}`, this.secrets));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}
