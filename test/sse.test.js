import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MAX_SSE_FRAME_LENGTH, SseParser, filterTranscriptEvent, subscribeEvents, waitForReconnect } from '../src/sse.js';

test('SSE parserはchunk境界、comment、multiple data、retryを扱う', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('retry: 25\n\n:pi'), []);
  assert.equal(parser.retry, 100);
  assert.deepEqual(parser.push('ng\n\ndata: {"a":\n'), []);
  assert.deepEqual(parser.push('data: 1}\n\ndata: {"b":2}\n\n'), ['{"a":\n1}', '{"b":2}']);
});

test('SSE parserはdelimiterなし巨大frameを細切れでも1 MiBで拒否する', () => {
  const parser = new SseParser();
  const chunk = 'x'.repeat(64 * 1024);
  for (let index = 0; index < 16; index += 1) assert.deepEqual(parser.push(chunk), []);
  assert.throws(
    () => parser.push('x'),
    (error) => error?.message === 'SSE frameが上限を超えました',
  );
});

test('SSE parserは上限ちょうどのLF/CR/CRLF delimiter分割を許可する', () => {
  const raw = `data: ${'x'.repeat(MAX_SSE_FRAME_LENGTH - 'data: '.length)}`;
  for (const delimiterChunks of [['\n', '\n'], ['\r', '\r'], ['\r', '\n', '\r', '\n']]) {
    const parser = new SseParser();
    assert.deepEqual(parser.push(raw), []);
    let output = [];
    for (const chunk of delimiterChunks) output = parser.push(chunk);
    assert.equal(output.length, 1);
    assert.equal(output[0].length, MAX_SSE_FRAME_LENGTH - 'data: '.length);
  }
});

test('SSE parserはdelimiter位置が上限超過なら固定errorで拒否する', () => {
  const parser = new SseParser();
  const raw = 'x'.repeat(MAX_SSE_FRAME_LENGTH + 1);
  assert.throws(
    () => parser.push(`${raw}\n\n`),
    (error) => error?.message === 'SSE frameが上限を超えました' && !error.message.includes(raw.slice(0, 32)),
  );
});

test('SSE parserは同じchunk内の多数の小frameを合計sizeで拒否しない', () => {
  const frame = `data: ${'x'.repeat(1010)}\n\n`;
  const parser = new SseParser();
  const output = parser.push(frame.repeat(1100));
  assert.equal(output.length, 1100);
  assert.ok(frame.length * 1100 > MAX_SSE_FRAME_LENGTH);
});

test('SSE retryはdigits-onlyのfinite integerだけを100〜30000msへclampする', () => {
  const parser = new SseParser();
  parser.push('retry: 0\n\n');
  assert.equal(parser.retry, 100);
  parser.push('retry: 30001\n\n');
  assert.equal(parser.retry, 30_000);
  parser.push('retry: 4321\n\n');
  assert.equal(parser.retry, 4321);
  for (const value of ['Infinity', '1.5', '1e3', '+200', '-200', '9'.repeat(400)]) {
    parser.push(`retry: ${value}\n\n`);
    assert.equal(parser.retry, 4321);
  }
});

test('SSE parserはCRLFとCRのframe境界を扱う', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: {"a":1}\r\n\r\ndata: {"b":2}\r\r'), ['{"a":1}', '{"b":2}']);
});

test('reconnect待機はtimer完了時にabort listenerを解除する', async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(_name, listener) { listeners.add(listener); },
    removeEventListener(_name, listener) { listeners.delete(listener); },
  };
  for (let index = 0; index < 20; index += 1) {
    await waitForReconnect(1, signal);
    assert.equal(listeners.size, 0);
  }
});

test('reconnect待機はabort時にもlistenerを解除する', async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(_name, listener) { listeners.add(listener); },
    removeEventListener(_name, listener) { listeners.delete(listener); },
  };
  const waiting = waitForReconnect(60_000, signal);
  assert.equal(listeners.size, 1);
  signal.aborted = true;
  for (const listener of listeners) listener();
  await waiting;
  assert.equal(listeners.size, 0);
});

test('transcript eventはagentIdでfilterしsnapshotを安全に絞る', () => {
  const snapshot = filterTranscriptEvent({ channel: 'transcript', payload: {
    type: 'snapshot', activeAgentId: 'a', entries: [{ agentId: 'a', value: 1 }, { agentId: 'b', value: 2 }, { value: 3 }],
  } }, 'a');
  assert.deepEqual(snapshot.payload.entries, [{ agentId: 'a', value: 1 }, { value: 3 }]);
  assert.equal(filterTranscriptEvent({ channel: 'transcript', payload: { type: 'snapshot', activeAgentId: null, entries: [{ value: 3 }] } }, 'a'), null);
  assert.equal(filterTranscriptEvent({ channel: 'transcript', payload: { type: 'append', agentId: 'b' } }, 'a'), null);
  assert.equal(filterTranscriptEvent({ channel: 'agents', payload: {} }, 'a'), null);
});

test('app sessionのBearerとrouting headerをSSEへ伝播し秘密値をsanitizeする', async () => {
  const token = randomBytes(16).toString('hex');
  const routing = randomBytes(16).toString('hex');
  const baseUrl = `https://${randomBytes(8).toString('hex')}.invalid`;
  let call;
  const controller = new AbortController();
  const stream = subscribeEvents({
    baseUrl,
    token,
    appSessionHeaders: { 'x-anyrun-network-token': routing },
    knownSecrets: [token, routing, baseUrl, new URL(baseUrl).hostname],
    signal: controller.signal,
    reconnect: false,
    fetchImpl: async (...args) => {
      call = args;
      return new Response(`data: ${JSON.stringify({ channel: 'transcript', payload: { note: `${token}:${routing}:${baseUrl}:${new URL(baseUrl).hostname}` } })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  assert.deepEqual(await stream.next(), { value: { kind: 'open' }, done: false });
  const event = await stream.next();
  assert.equal(event.value.value.payload.note, '<redacted>:<redacted>:<redacted>:<redacted>');
  assert.equal(call[1].headers.Authorization, `Bearer ${token}`);
  assert.equal(call[1].headers['x-anyrun-network-token'], routing);
  assert.equal(call[1].redirect, 'error');
  controller.abort();
  await stream.return();
});
