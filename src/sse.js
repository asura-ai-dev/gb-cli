import { TransportError, redactText } from './errors.js';
import { sanitize } from './sanitize.js';

export const MAX_SSE_FRAME_LENGTH = 1024 * 1024;

const FRAME_DELIMITER = /\r\n\r\n|\n\n|\r\r/;
const DELIMITER_PREFIXES = ['\r\n\r', '\r\n', '\r', '\n'];

function incompleteDelimiterLength(value) {
  for (const prefix of DELIMITER_PREFIXES) {
    if (value.endsWith(prefix)) return prefix.length;
  }
  return 0;
}

export class SseParser {
  constructor() {
    this.buffer = '';
    this.retry = 1000;
  }

  push(chunk, { final = false } = {}) {
    this.buffer += chunk;
    const output = [];
    while (true) {
      const match = this.buffer.match(FRAME_DELIMITER);
      if (!match || match.index === undefined) break;
      if (match.index > MAX_SSE_FRAME_LENGTH) {
        throw new TransportError('SSE frameが上限を超えました');
      }
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = [];
      for (const line of raw.split(/\r\n|\r|\n/)) {
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        let value = separator < 0 ? '' : line.slice(separator + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data.push(value);
        if (field === 'retry' && /^\d+$/.test(value)) {
          const retry = Number(value);
          if (Number.isFinite(retry) && Number.isInteger(retry)) {
            this.retry = Math.min(30_000, Math.max(100, retry));
          }
        }
      }
      if (data.length > 0) output.push(data.join('\n'));
    }
    const possibleDelimiter = final ? 0 : incompleteDelimiterLength(this.buffer);
    if (this.buffer.length - possibleDelimiter > MAX_SSE_FRAME_LENGTH) {
      throw new TransportError('SSE frameが上限を超えました');
    }
    return output;
  }
}

export function waitForReconnect(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function* subscribeEvents({ baseUrl, token, appSessionHeaders = {}, knownSecrets = [], fetchImpl = globalThis.fetch, signal, reconnect = true }) {
  const secrets = [...new Set([token, ...Object.values(appSessionHeaders), ...knownSecrets])]
    .filter((value) => typeof value === 'string' && value.length > 0);
  let retryMs = 1000;
  while (!signal.aborted) {
    let response;
    try {
      const headers = { Accept: 'text/event-stream', 'x-sand-slim-avatars': '1', ...appSessionHeaders };
      if (token) headers.Authorization = `Bearer ${token}`;
      response = await fetchImpl(`${baseUrl}/events?channels=transcript`, {
        method: 'GET', headers, redirect: 'error', signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      if (!reconnect) throw new TransportError(redactText('SSE接続に失敗しました', secrets));
      await waitForReconnect(retryMs, signal);
      continue;
    }
    if (!response.ok || !response.body) {
      if ([401, 403, 404].includes(response.status)) throw new TransportError(`SSEが拒否されました (HTTP ${response.status})`);
      if (!reconnect) throw new TransportError(`SSE接続に失敗しました (HTTP ${response.status})`);
      await waitForReconnect(retryMs, signal);
      continue;
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'text/event-stream') {
      throw new TransportError('SSE responseのContent-Typeが不正です');
    }
    yield { kind: 'open' };
    const parser = new SseParser();
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) {
        for (const data of parser.push(decoder.decode(chunk, { stream: true }))) {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new TransportError('SSE dataのJSONが不正です');
          }
          yield { kind: 'event', value: sanitize(parsed, new WeakSet(), secrets) };
        }
      }
      for (const data of parser.push(decoder.decode(), { final: true })) {
        let parsed;
        try { parsed = JSON.parse(data); } catch { throw new TransportError('SSE dataのJSONが不正です'); }
        yield { kind: 'event', value: sanitize(parsed, new WeakSet(), secrets) };
      }
      retryMs = parser.retry;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof TransportError) throw error;
    }
    if (!reconnect || signal.aborted) return;
    await waitForReconnect(retryMs, signal);
  }
}

export function filterTranscriptEvent(envelope, agentId) {
  if (!envelope || envelope.channel !== 'transcript' || !envelope.payload || typeof envelope.payload !== 'object') return null;
  const payload = envelope.payload;
  if (payload.type === 'snapshot') {
    if (payload.activeAgentId !== agentId) return null;
    const result = { ...payload };
    if (Array.isArray(payload.entries)) {
      result.entries = payload.entries.filter((entry) => !entry || typeof entry !== 'object' || entry.agentId === undefined || entry.agentId === agentId);
    }
    return { ...envelope, payload: result };
  }
  return payload.agentId === agentId ? envelope : null;
}
