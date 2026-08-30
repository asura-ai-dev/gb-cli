import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, getEventListeners } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { runCli, writeStreamingJsonLine } from '../src/cli.js';
import { appSessionError } from '../src/app-session.js';

const TEST_TOKEN = `token-${randomBytes(16).toString('hex')}`;

class Capture extends Writable {
  constructor() {
    super();
    this.value = '';
  }
  _write(chunk, _encoding, callback) {
    this.value += chunk.toString();
    callback();
  }
}

class FakeProcess extends EventEmitter {}

class ControlledOutput extends EventEmitter {
  constructor({ blocked = true } = {}) {
    super();
    this.blocked = blocked;
    this.writes = [];
  }

  write(chunk) {
    this.writes.push(chunk.toString());
    return !this.blocked;
  }

  drain() {
    this.blocked = false;
    this.emit('drain');
  }
}

async function waitUntil(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('条件を待機できませんでした');
}

function streamingFetch(events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return async (url) => {
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith('/api/getHostStatus')) {
      return new Response(JSON.stringify({ hostVersion: '0.24.0' }), { status: 200 });
    }
    if (url.includes('/events?channels=transcript')) {
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 404 });
  };
}

function terminalStreams() {
  const stdin = Readable.from([]);
  const stdout = new Capture();
  const stderr = new Capture();
  for (const stream of [stdin, stdout, stderr]) Object.defineProperty(stream, 'isTTY', { value: true });
  return { stdin, stdout, stderr };
}

function immediateTimers(durations) {
  return {
    setTimeout(callback, ms) {
      durations.push(ms);
      const handle = { active: true };
      setImmediate(() => {
        if (handle.active) callback();
      });
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.active = false;
    },
  };
}

async function startGateway(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function invoke(url, argv, extra = {}) {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(argv, {
    env: { GB_GATEWAY_URL: url, GB_GATEWAY_TOKEN: TEST_TOKEN },
    stdin: Readable.from(extra.stdin ?? []),
    stdout,
    stderr,
    processObj: extra.processObj ?? new FakeProcess(),
  });
  return { code, stdout: stdout.value, stderr: stderr.value };
}

async function invokeAppSession(url, appVersion, argv, extra = {}) {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(['--app-session', '--allow-remote', ...argv], {
    env: {},
    stdin: Readable.from(extra.stdin ?? []),
    stdout,
    stderr,
    processObj: extra.processObj ?? new FakeProcess(),
    randomUUID: extra.randomUUID,
    loadAppSession: async () => ({
      baseUrl: url,
      token: TEST_TOKEN,
      headers: {},
      secrets: [url, TEST_TOKEN],
      appVersion,
      compatibilitySource: 'app-bundle',
    }),
  });
  return { code, stdout: stdout.value, stderr: stderr.value };
}

test('helpはgatewayに接続せずcommandと安全上の注意を表示する', async () => {
  const stdout = new Capture();
  const result = await runCli(['--help'], { stdout, stderr: new Capture() });
  assert.equal(result, 0);
  assert.match(stdout.value, /Usage:/);
  assert.match(stdout.value, /chat --agent ID/);
  assert.match(stdout.value, /--stdin/);
  assert.match(stdout.value, /remote runの停止・完了を意味しません/);
  assert.match(stdout.value, /--app-session.*macOS.*--allow-remote/);
  assert.match(stdout.value, /app-session authorize --yes/);
  assert.match(stdout.value, /対話Terminal/);
  assert.match(stdout.value, /stdinをchildへ継承/);
  assert.match(stdout.value, /secret stdoutは表示しません/);
  assert.match(stdout.value, /固定app bundle.*remote hostVersion/);
});

test('streaming writerはwrite前にlistenerを登録しdrain後に全て解除する', async () => {
  const stdout = new ControlledOutput();
  const controller = new AbortController();
  const pending = writeStreamingJsonLine(stdout, { value: 1 }, controller.signal);
  assert.equal(stdout.listenerCount('drain'), 1);
  assert.equal(stdout.listenerCount('error'), 1);
  assert.equal(stdout.listenerCount('close'), 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  stdout.drain();
  assert.equal(await pending, true);
  assert.equal(stdout.listenerCount('drain'), 0);
  assert.equal(stdout.listenerCount('error'), 0);
  assert.equal(stdout.listenerCount('close'), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('streaming writerはwrite(true)なら即時cleanupする', async () => {
  const stdout = new ControlledOutput({ blocked: false });
  const controller = new AbortController();
  assert.equal(await writeStreamingJsonLine(stdout, { value: 1 }, controller.signal), true);
  assert.equal(stdout.listenerCount('drain'), 0);
  assert.equal(stdout.listenerCount('error'), 0);
  assert.equal(stdout.listenerCount('close'), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('streaming writerはerror/closeを固定TransportErrorにしlistenerを解除する', async () => {
  for (const event of ['error', 'close']) {
    const stdout = new ControlledOutput();
    const controller = new AbortController();
    const pending = writeStreamingJsonLine(stdout, { value: 1 }, controller.signal);
    stdout.emit(event, new Error('表示してはいけない値'));
    await assert.rejects(pending, (error) => (
      error?.exitCode === 4
      && error?.message === 'stdoutへの書き込みに失敗しました'
      && !error.message.includes('表示してはいけない値')
    ));
    assert.equal(stdout.listenerCount('drain'), 0);
    assert.equal(stdout.listenerCount('error'), 0);
    assert.equal(stdout.listenerCount('close'), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('streaming writerはabortでbackpressure待機を解除しlistenerを除去する', async () => {
  const stdout = new ControlledOutput();
  const controller = new AbortController();
  const pending = writeStreamingJsonLine(stdout, { value: 1 }, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(stdout.listenerCount('drain'), 0);
  assert.equal(stdout.listenerCount('error'), 0);
  assert.equal(stdout.listenerCount('close'), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('--app-sessionの承認不足と接続先競合はread・Keychain・fetch前にexit 2', async () => {
  const conflictingUrl = `https://${randomBytes(8).toString('hex')}.invalid`;
  let reads = 0;
  let keychain = 0;
  let fetches = 0;
  const common = {
    stdout: new Capture(),
    stderr: new Capture(),
    readFile: async () => { reads += 1; },
    loadAppSession: async () => { keychain += 1; },
    fetchImpl: async () => { fetches += 1; },
  };
  const cases = [
    { argv: ['--app-session', 'doctor'], env: {} },
    { argv: ['--app-session', '--allow-remote', '--data-root', '/tmp/unused', 'doctor'], env: {} },
    { argv: ['--app-session', '--allow-remote', '--gateway-url', conflictingUrl, 'doctor'], env: {} },
    { argv: ['--app-session', '--allow-remote', 'doctor'], env: { GB_GATEWAY_URL: conflictingUrl } },
  ];
  for (const item of cases) {
    common.stdout = new Capture();
    common.stderr = new Capture();
    const code = await runCli(item.argv, { ...common, env: item.env });
    assert.equal(code, 2);
  }
  assert.equal(reads, 0);
  assert.equal(keychain, 0);
  assert.equal(fetches, 0);
});

test('app-session authorizeは--yes欠落と非TTYをsecurity実行前にexit 2で拒否する', async () => {
  let securityCalls = 0;
  const spawn = () => { securityCalls += 1; throw new Error('unexpected'); };
  const tty = terminalStreams();
  const missingYes = await runCli(['app-session', 'authorize'], {
    ...tty, env: {}, processObj: new FakeProcess(), spawn,
  });
  assert.equal(missingYes, 2);
  const nonTty = await runCli(['app-session', 'authorize', '--yes'], {
    stdin: Readable.from([]), stdout: new Capture(), stderr: new Capture(),
    env: {}, processObj: new FakeProcess(), spawn,
  });
  assert.equal(nonTty, 2);
  const unsupported = terminalStreams();
  const unsupportedCode = await runCli(['app-session', 'authorize', '--yes'], {
    ...unsupported, env: {}, processObj: new FakeProcess(), platform: 'linux', spawn,
  });
  assert.equal(unsupportedCode, 3);
  assert.equal(securityCalls, 0);
});

test('app-session authorizeはstdinとstderrだけをTTYへ接続しstdoutをzeroizeする', async () => {
  const streams = terminalStreams();
  const processObj = new FakeProcess();
  const securityStdout = Buffer.from(`synthetic-${randomBytes(16).toString('hex')}\n`);
  const prompt = 'security: Grok Bot Safe Storageへのアクセスを確認してください\n';
  let securityCall;
  let descriptorReads = 0;
  let fetches = 0;
  const code = await runCli(['app-session', 'authorize', '--yes'], {
    ...streams, env: {}, processObj, platform: 'darwin',
    readFile: async () => { descriptorReads += 1; throw new Error('unexpected'); },
    fetchImpl: async () => { fetches += 1; throw new Error('unexpected'); },
    spawn: (...args) => {
      securityCall = args;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => {
        args[2].stdio[2].write(prompt);
        child.stdout.emit('data', securityStdout);
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.equal(code, 0);
  assert.equal(securityCall[0], '/usr/bin/security');
  assert.deepEqual(securityCall[1], ['find-generic-password', '-w', '-s', 'Grok Bot Safe Storage']);
  assert.equal(securityCall[2].shell, false);
  assert.equal(securityCall[2].stdio[0], streams.stdin);
  assert.equal(securityCall[2].stdio[1], 'pipe');
  assert.equal(securityCall[2].stdio[2], streams.stderr);
  assert.ok(securityStdout.every((byte) => byte === 0));
  assert.equal(descriptorReads, 0);
  assert.equal(fetches, 0);
  assert.match(streams.stderr.value, /Grok Bot Safe Storage/);
  assert.doesNotMatch(streams.stdout.value + streams.stderr.value, /synthetic-/);
});

test('app-session authorize timeoutはexit 3でbufferをzeroizeする', async () => {
  const streams = terminalStreams();
  const childStdout = Buffer.from(randomBytes(16));
  const durations = [];
  let killedWith;
  let destroyed = false;
  let unrefed = false;
  const timers = immediateTimers(durations);
  const code = await runCli(['app-session', 'authorize', '--yes'], {
    ...streams, env: {}, processObj: new FakeProcess(), platform: 'darwin',
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.destroy = () => { destroyed = true; };
      child.unref = () => { unrefed = true; };
      child.kill = (signal) => {
        killedWith = signal;
        return true;
      };
      queueMicrotask(() => child.stdout.emit('data', childStdout));
      return child;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  assert.equal(code, 3);
  assert.deepEqual(durations, [60000, 250]);
  assert.equal(killedWith, 'SIGKILL');
  assert.equal(destroyed, true);
  assert.equal(unrefed, true);
  assert.ok(childStdout.every((byte) => byte === 0));
  assert.match(streams.stderr.value, /timeout/);
  assert.match(streams.stderr.value, /KeychainとGrok Botの状態/);
  assert.doesNotMatch(streams.stderr.value, /gb app-session authorize|--yes|再試行/);
});

test('app-session authorizeのSIGINTはchildをabortして130を返す', async () => {
  const streams = terminalStreams();
  const processObj = new FakeProcess();
  const childStdout = Buffer.from(randomBytes(16));
  let killedWith;
  const promise = runCli(['app-session', 'authorize', '--yes'], {
    ...streams, env: {}, processObj, platform: 'darwin',
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = (signal) => {
        killedWith = signal;
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      queueMicrotask(() => child.stdout.emit('data', childStdout));
      return child;
    },
  });
  queueMicrotask(() => processObj.emit('SIGINT'));
  const code = await promise;
  assert.equal(code, 130);
  assert.equal(killedWith, 'SIGTERM');
  assert.ok(childStdout.every((byte) => byte === 0));
  assert.match(streams.stderr.value, /中断/);
});

test('app-session authorizeのSIGINTはTERM grace後KILLしcloseを待って130を返す', async () => {
  const streams = terminalStreams();
  const processObj = new FakeProcess();
  const durations = [];
  const signals = [];
  const timers = immediateTimers(durations);
  const promise = runCli(['app-session', 'authorize', '--yes'], {
    ...streams, env: {}, processObj, platform: 'darwin',
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      return child;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  queueMicrotask(() => processObj.emit('SIGINT'));
  const code = await promise;
  assert.equal(code, 130);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(durations, [60000, 250, 250]);
  assert.match(streams.stderr.value, /中断/);
});

test('app-session authorizeのSIGINTはchildがcloseしなくても500ms grace後cleanupする', async () => {
  const streams = terminalStreams();
  const processObj = new FakeProcess();
  const durations = [];
  const signals = [];
  const timers = immediateTimers(durations);
  let child;
  let destroyed = false;
  let unrefed = false;
  const promise = runCli(['app-session', 'authorize', '--yes'], {
    ...streams, env: {}, processObj, platform: 'darwin',
    spawn: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.destroy = () => { destroyed = true; };
      child.unref = () => { unrefed = true; };
      child.kill = (signal) => { signals.push(signal); return true; };
      return child;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  queueMicrotask(() => processObj.emit('SIGINT'));
  const code = await promise;
  assert.equal(code, 130);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(durations, [60000, 250, 250]);
  assert.equal(destroyed, true);
  assert.equal(unrefed, true);
  assert.equal(child.stdout.listenerCount('data'), 0);
});

test('app-session authorizeのtimeoutとSIGINT競合は一度だけsettleする', async () => {
  const streams = terminalStreams();
  const processObj = new FakeProcess();
  const durations = [];
  const signals = [];
  const timers = immediateTimers(durations);
  let child;
  const promise = runCli(['app-session', 'authorize', '--yes'], {
    ...streams, env: {}, processObj, platform: 'darwin',
    spawn: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.destroy = () => {};
      child.unref = () => {};
      child.kill = (signal) => { signals.push(signal); return true; };
      return child;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  setImmediate(() => processObj.emit('SIGINT'));
  const code = await promise;
  const stderrBeforeLateClose = streams.stderr.value;
  child.emit('close', 0, null);
  assert.equal(code, 130);
  assert.deepEqual(signals, ['SIGKILL']);
  assert.deepEqual(durations, [60000, 250]);
  assert.equal((streams.stderr.value.match(/中断/g) ?? []).length, 1);
  assert.equal(streams.stderr.value, stderrBeforeLateClose);
});

test('app-session authorizeはstdoutを64KiBに制限し秘密らしい値を出力しない', async () => {
  const streams = terminalStreams();
  const marker = `hidden-${randomBytes(16).toString('hex')}`;
  const oversized = Buffer.alloc(65537, 0x61);
  Buffer.from(marker).copy(oversized);
  let killedWith;
  const code = await runCli(['app-session', 'authorize', '--yes'], {
    ...streams, env: {}, processObj: new FakeProcess(), platform: 'darwin',
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = (signal) => {
        killedWith = signal;
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      queueMicrotask(() => child.stdout.emit('data', oversized));
      return child;
    },
  });
  assert.equal(code, 3);
  assert.equal(killedWith, 'SIGKILL');
  assert.ok(oversized.every((byte) => byte === 0));
  assert.doesNotMatch(streams.stdout.value + streams.stderr.value, new RegExp(marker));
});

test('app-session authorizeのnonzero failureはstdoutを隠して安全な固定messageを返す', async () => {
  const streams = terminalStreams();
  const marker = `hidden-${randomBytes(16).toString('hex')}`;
  const rawStdout = Buffer.from(marker);
  const code = await runCli(['app-session', 'authorize', '--yes'], {
    ...streams, env: {}, processObj: new FakeProcess(), platform: 'darwin',
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit('data', rawStdout);
        child.emit('close', 1, null);
      });
      return child;
    },
  });
  assert.equal(code, 3);
  assert.ok(rawStdout.every((byte) => byte === 0));
  assert.match(streams.stderr.value, /認証情報を取得できませんでした/);
  assert.doesNotMatch(streams.stdout.value + streams.stderr.value, new RegExp(marker));
});

test('app 0.24.0は任意hostVersionでもsupportedとなりdoctorは非秘密metadataだけ出す', async () => {
  const random = (label) => `${label}-${randomBytes(12).toString('hex')}`;
  const token = random('token');
  const routing = random('routing');
  const password = random('password');
  const rawEncrypted = random('encrypted');
  const hostWireVersion = random('host-wire-version');
  const privateUrl = `https://${randomBytes(8).toString('hex')}.invalid`;
  const descriptorPath = `/tmp/${random('descriptor')}`;
  const calls = [];
  const dependencies = {
    env: {},
    processObj: new FakeProcess(),
    stdin: Readable.from([]),
    loadAppSession: async () => ({
      baseUrl: privateUrl,
      token,
      headers: { 'x-anyrun-network-token': routing },
      secrets: [password, token, routing, privateUrl, descriptorPath, rawEncrypted],
      appVersion: '0.24.0', compatibilitySource: 'app-bundle',
    }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, note: `${token}${routing}` }), { status: 200 });
      return new Response(JSON.stringify({ hostVersion: hostWireVersion, note: `${password}${token}${routing}${privateUrl}${descriptorPath}${rawEncrypted}` }), { status: 200 });
    },
  };

  for (const jsonMode of [true, false]) {
    const stdout = new Capture();
    const stderr = new Capture();
    const argv = ['--app-session', '--allow-remote', 'doctor', ...(jsonMode ? ['--json'] : [])];
    const code = await runCli(argv, { ...dependencies, stdout, stderr });
    assert.equal(code, 0);
    assert.equal(stderr.value, '');
    if (jsonMode) {
      const output = JSON.parse(stdout.value);
      assert.deepEqual(output.gateway, {
        source: 'app-session', descriptor: false, remote: true, authenticated: true, routingHeader: true,
      });
      assert.deepEqual(output.health, { ok: true });
      assert.deepEqual(output.compatibility, {
        source: 'app-bundle',
        observedAppVersion: '0.24.0',
        expectedAppVersion: '0.24.0',
        supportedAppVersions: ['0.24.0', '0.30.0'],
        profile: 'app-session-v0.24',
        capabilities: {
          gatewayRead: true,
          agentDiscovery: true,
          agentCreate: true,
          agentOperations: 'gateway-direct',
          dedicatedTemporalBackend: false,
          exactAgentResolutionRequired: false,
        },
        supported: true,
        warning: null,
      });
      assert.equal('hostVersion' in output, false);
    } else {
      assert.match(stdout.value, /app-session/);
    }
    for (const hidden of [password, token, routing, privateUrl, descriptorPath, rawEncrypted, hostWireVersion]) {
      assert.doesNotMatch(stdout.value + stderr.value, new RegExp(hidden));
    }
  }
  assert.equal(calls.length, 4);
  for (const { init } of calls) {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers['x-anyrun-network-token'], routing);
  }
});

test('app session失敗は--jsonで安全なreasonとhintをstderrへ出す', async () => {
  const runtimeSecret = `runtime-${randomBytes(16).toString('hex')}`;
  const cases = [
    { reason: 'platform', dependencies: { platform: 'linux', readFile: async () => assert.fail() } },
    { reason: 'missing', dependencies: { platform: 'darwin', loadAppVersion: async () => ({ appVersion: '0.24.0', compatibilitySource: 'app-bundle' }), readFile: async () => { throw new Error(runtimeSecret); } } },
    ...['invalid', 'multiple', 'stale', 'keychain', 'keychain-timeout', 'decrypt', 'incomplete', 'app-version-missing', 'app-version-invalid', 'app-version-ambiguous'].map((reason) => ({
      reason,
      dependencies: { loadAppSession: async () => { throw appSessionError(reason); } },
    })),
  ];
  for (const item of cases) {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await runCli(['--app-session', '--allow-remote', 'doctor', '--json'], {
      env: {}, stdout, stderr, ...item.dependencies,
      fetchImpl: async () => assert.fail(), execFile: async () => assert.fail(),
    });
    assert.equal(code, 3);
    assert.equal(stdout.value, '');
    const output = JSON.parse(stderr.value);
    assert.equal(output.error.reason, item.reason);
    assert.equal(typeof output.error.message, 'string');
    assert.equal(typeof output.error.hint, 'string');
    assert.doesNotMatch(stderr.value, new RegExp(runtimeSecret));
  }
});

test('stale app sessionはKeychainとfetchより前に拒否する', async () => {
  const now = 2_000_000_000_000;
  const encrypted = Buffer.concat([Buffer.from('v10'), Buffer.alloc(16)]).toString('base64');
  let keychainCalls = 0;
  let fetchCalls = 0;
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(['--app-session', '--allow-remote', 'doctor', '--json'], {
    env: {}, stdout, stderr, platform: 'darwin', now: () => now,
    homedir: () => '/tmp/isolated-home',
    loadAppVersion: async () => ({ appVersion: '0.24.0', compatibilitySource: 'app-bundle' }),
    readFile: async () => JSON.stringify({
      version: 2,
      entries: { account: { savedAtMs: now - 8 * 24 * 60 * 60 * 1000, encrypted } },
    }),
    execFile: async () => { keychainCalls += 1; throw new Error('unexpected'); },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('unexpected'); },
  });
  assert.equal(code, 3);
  assert.equal(JSON.parse(stderr.value).error.reason, 'stale');
  assert.equal(keychainCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('doctorの3秒sentinel timeoutは安全なkeychain-timeout JSONを返し再試行しない', async () => {
  const now = 2_000_000_000_000;
  const hidden = randomBytes(16).toString('hex');
  const encrypted = Buffer.concat([Buffer.from('v10'), randomBytes(16)]).toString('base64');
  const childStdout = Buffer.from(hidden);
  const childStderr = Buffer.from(hidden);
  let securityCalls = 0;
  let timeoutMs;
  let fetches = 0;
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(['--app-session', '--allow-remote', 'doctor', '--json'], {
    env: {}, stdout, stderr, platform: 'darwin', now: () => now,
    homedir: () => '/tmp/isolated-home',
    loadAppVersion: async () => ({ appVersion: '0.24.0', compatibilitySource: 'app-bundle' }),
    readFile: async () => JSON.stringify({
      version: 2,
      entries: { account: { savedAtMs: now, encrypted } },
    }),
    execFile: async (_path, _argv, options) => {
      securityCalls += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error(hidden);
          error.stdout = childStdout;
          error.stderr = childStderr;
          reject(error);
        }, { once: true });
      });
    },
    setTimeout: (callback, ms) => {
      timeoutMs = ms;
      setImmediate(callback);
      return 1;
    },
    clearTimeout: () => {},
    fetchImpl: async () => { fetches += 1; throw new Error('unexpected'); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(code, 3);
  assert.equal(stdout.value, '');
  const output = JSON.parse(stderr.value);
  assert.deepEqual(Object.keys(output.error).sort(), ['hint', 'message', 'reason']);
  assert.equal(output.error.reason, 'keychain-timeout');
  assert.equal(securityCalls, 1);
  assert.equal(timeoutMs, 3000);
  assert.equal(fetches, 0);
  assert.doesNotMatch(stderr.value, new RegExp(hidden));
  assert.ok(childStdout.every((byte) => byte === 0));
  assert.ok(childStderr.every((byte) => byte === 0));
});

test('app sessionはapp 0.25.0ならhost 0.24.0でも4変更経路をAPI・SSE前に拒否する', async () => {
  const token = randomBytes(16).toString('hex');
  const routing = randomBytes(16).toString('hex');
  const baseUrl = `https://${randomBytes(8).toString('hex')}.invalid`;
  const runtimePrompt = `prompt-${randomBytes(12).toString('hex')}`;
  const cases = [
    ['agents', 'create', '--name', 'N', '--description', 'D'],
    ['send', '--agent', 'a', '--prompt', runtimePrompt],
    ['chat', '--agent', 'a', '--prompt', runtimePrompt],
    ['interrupt', '--agent', 'a', '--yes'],
  ];
  for (const command of cases) {
    let apiCalls = 0;
    let sseCalls = 0;
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await runCli(['--app-session', '--allow-remote', ...command], {
      env: {}, stdout, stderr, processObj: new FakeProcess(),
      loadAppSession: async () => ({
        baseUrl, token, headers: { 'x-anyrun-network-token': routing }, secrets: [baseUrl, token, routing],
        appVersion: '0.25.0', compatibilitySource: 'app-bundle',
      }),
      fetchImpl: async (url) => {
        if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (url.includes('/events')) sseCalls += 1;
        else apiCalls += 1;
        return new Response(JSON.stringify({ hostVersion: '0.24.0' }), { status: 200 });
      },
    });
    assert.equal(code, 3);
    assert.equal(apiCalls, 0);
    assert.equal(sseCalls, 0);
  }
});

test('app sessionのknown mismatchは明示allow-unsupported時だけ変更を許可する', async () => {
  const token = randomBytes(16).toString('hex');
  const baseUrl = `https://${randomBytes(8).toString('hex')}.invalid`;
  let hostCalls = 0;
  let createCalls = 0;
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(['--app-session', '--allow-remote', '--allow-unsupported', 'agents', 'create', '--name', 'N', '--description', 'D'], {
    env: {}, stdout, stderr,
    loadAppSession: async () => ({
      baseUrl, token, headers: {}, secrets: [baseUrl, token], appVersion: '0.25.0', compatibilitySource: 'app-bundle',
    }),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith('/api/getHostStatus')) {
        hostCalls += 1;
        return new Response(JSON.stringify({ hostVersion: 'arbitrary-wire-value' }), { status: 200 });
      }
      createCalls += 1;
      return new Response(JSON.stringify({ agent: { id: 'created' } }), { status: 200 });
    },
  });
  assert.equal(code, 0);
  assert.equal(hostCalls, 1);
  assert.equal(createCalls, 1);
  assert.match(stderr.value, /warning/);
});

test('app session mismatchのdoctor/statusは安全なapp compatibilityだけを公開する', async () => {
  const hiddenHostVersion = `wire-${randomBytes(16).toString('hex')}`;
  const baseUrl = `https://${randomBytes(8).toString('hex')}.invalid`;
  const dependencies = {
    env: {},
    loadAppSession: async () => ({
      baseUrl, token: randomBytes(16).toString('hex'), headers: {}, secrets: [baseUrl],
      appVersion: '0.25.0', compatibilitySource: 'app-bundle',
    }),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith('/api/getHostStatus')) return new Response(JSON.stringify({ hostVersion: hiddenHostVersion, isBusy: false }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    },
  };
  for (const command of ['doctor', 'status']) {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await runCli(['--app-session', '--allow-remote', command, '--json'], { ...dependencies, stdout, stderr });
    assert.equal(code, 0);
    const output = JSON.parse(stdout.value);
    assert.deepEqual(output.compatibility, {
      source: 'app-bundle',
      observedAppVersion: '0.25.0',
      expectedAppVersion: '0.24.0',
      supportedAppVersions: ['0.24.0', '0.30.0'],
      profile: null,
      capabilities: null,
      supported: false,
      warning: '観測対象外のGrok Bot desktop app versionです',
    });
    assert.match(stderr.value, /warning/);
    assert.doesNotMatch(stdout.value + stderr.value, new RegExp(hiddenHostVersion));
  }
});

test('app sessionのunknown version reasonはallow-unsupportedでもhealth前に拒否する', async () => {
  for (const reason of ['app-version-missing', 'app-version-invalid', 'app-version-ambiguous']) {
    let fetches = 0;
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await runCli(['--app-session', '--allow-remote', '--allow-unsupported', 'doctor', '--json'], {
      env: {}, stdout, stderr,
      loadAppSession: async () => { throw appSessionError(reason); },
      fetchImpl: async () => { fetches += 1; throw new Error('unexpected'); },
    });
    assert.equal(code, 3);
    assert.equal(fetches, 0);
    assert.equal(JSON.parse(stderr.value).error.reason, reason);
  }
});

test('差替え検出後のversionはallow-unsupportedでもmutation送信へ進まない', async () => {
  let fetches = 0;
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli([
    '--app-session', '--allow-remote', '--allow-unsupported',
    'agents', 'create', '--name', 'N', '--description', 'D', '--json',
  ], {
    env: {}, stdout, stderr,
    loadAppSession: async () => { throw appSessionError('app-version-invalid'); },
    fetchImpl: async () => { fetches += 1; throw new Error('unexpected'); },
  });
  assert.equal(code, 3);
  assert.equal(fetches, 0);
  assert.equal(stdout.value, '');
  assert.equal(JSON.parse(stderr.value).error.reason, 'app-version-invalid');
});

test('doctor/status healthは型付きallowlist以外を一切出力しない', async (t) => {
  const hidden = `hidden-${randomBytes(16).toString('hex')}`;
  const startedAt = '2026-08-29T00:00:00.000Z';
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, {
      ok: true,
      pid: 123,
      isBusy: false,
      busyOnlyAwaitingApproval: true,
      activeAgentId: hidden,
      startedAt,
      lastBusyAtMs: 1234,
      endpoint: hidden,
      path: hidden,
      socketPath: hidden,
      remoteUrl: hidden,
      userId: hidden,
      routingHeader: hidden,
      nested: { value: hidden },
    });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/listAgents') return json(response, 200, []);
    return json(response, 404, {});
  });
  t.after(gateway.close);
  const expected = { ok: true, isBusy: false, busyOnlyAwaitingApproval: true, startedAt, lastBusyAtMs: 1234 };
  for (const argv of [['doctor', '--json'], ['status', '--json']]) {
    const result = await invoke(gateway.url, argv);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).health, expected);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(hidden));
  }
});

test('app session health failureはruntime秘密値をstderrへ漏らさない', async () => {
  const token = randomBytes(16).toString('hex');
  const routing = randomBytes(16).toString('hex');
  const privateUrl = `https://${randomBytes(8).toString('hex')}.invalid`;
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(['--app-session', '--allow-remote', 'doctor'], {
    env: {}, stdout, stderr,
    loadAppSession: async () => ({
      baseUrl: privateUrl,
      token,
      headers: { 'x-anyrun-network-token': routing },
      secrets: [token, routing, privateUrl],
      appVersion: '0.24.0', compatibilitySource: 'app-bundle',
    }),
    fetchImpl: async () => { throw new Error(`${token}${routing}${privateUrl}`); },
  });
  assert.equal(code, 3);
  assert.equal(stdout.value, '');
  for (const hidden of [token, routing, privateUrl]) assert.doesNotMatch(stderr.value, new RegExp(hidden));
});

test('status JSONはraw dataを保持しつつPIDとsecret fieldを除去する', async (t) => {
  const responseSecret = `response-${randomBytes(12).toString('hex')}`;
  const requests = [];
  const gateway = await startGateway(async (request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.url === '/health') return json(response, 200, { ok: true, pid: 123, token: responseSecret });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0', capabilities: { x: true }, secret: 'bad' });
    if (request.url === '/api/listAgents') return json(response, 200, [{
      id: 'a', name: 'A', token: responseSecret, note: TEST_TOKEN, [`prefix-${TEST_TOKEN}-suffix`]: responseSecret,
    }]);
    return json(response, 404, { error: 'missing' });
  });
  t.after(gateway.close);
  const result = await invoke(gateway.url, ['status', '--json']);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.health.pid, undefined);
  assert.equal(output.health.token, undefined);
  assert.equal(output.hostStatus.capabilities.x, true);
  assert.equal(output.hostStatus.secret, undefined);
  assert.equal(output.agents[0].token, undefined);
  assert.equal(output.agents[0].note, '<redacted>');
  assert.doesNotMatch(result.stdout, new RegExp(TEST_TOKEN));
  assert.ok(requests.every((item) => item.headers.origin === undefined));
  assert.equal(requests.find((item) => item.url === '/health').headers.authorization, undefined);
  assert.equal(requests.find((item) => item.url.startsWith('/api/')).headers.authorization, `Bearer ${TEST_TOKEN}`);
});

test('doctorとagents listはbodyなしAPIを呼び、JSON結果を出力する', async (t) => {
  const calls = [];
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    const method = request.url.slice('/api/'.length);
    calls.push({ method, body: await readJson(request) });
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: '0.24.0', isBusy: false });
    if (method === 'listAgents') return json(response, 200, [{ id: 'agent-1', name: 'One' }]);
    return json(response, 404, {});
  });
  t.after(gateway.close);

  const doctor = await invoke(gateway.url, ['doctor', '--json']);
  assert.equal(doctor.code, 0);
  assert.equal(JSON.parse(doctor.stdout).hostVersion, '0.24.0');
  const list = await invoke(gateway.url, ['agents', 'list', '--json']);
  assert.equal(list.code, 0);
  assert.deepEqual(JSON.parse(list.stdout), [{ id: 'agent-1', name: 'One' }]);
  assert.ok(calls.filter((call) => call.method === 'getHostStatus').every((call) => call.body === undefined));
  assert.equal(calls.find((call) => call.method === 'listAgents').body, undefined);
});

test('human出力はgateway由来のterminal controlを全到達経路で可視化しJSONはraw値を保つ', async (t) => {
  const hostile = 'value\u0000\t\r\n\u001b]0;osc\u0007\u001b[31mcsi\u007f\u0085\u009b31m';
  const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
  const agents = [{ id: hostile, name: hostile }];
  const transcript = { entries: [{ agentId: 'agent-1', text: hostile }] };
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    const method = request.url.slice('/api/'.length);
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: hostile });
    if (method === 'listAgents' || method === 'searchAgents') return json(response, 200, agents);
    if (method === 'createAgent') return json(response, 200, { agent: { id: hostile, name: hostile } });
    if (method === 'getAgentTranscriptTail') return json(response, 200, transcript);
    return json(response, 404, {});
  });
  t.after(gateway.close);

  const doctor = await invoke(gateway.url, ['doctor']);
  const status = await invoke(gateway.url, ['status']);
  const list = await invoke(gateway.url, ['agents', 'list']);
  const search = await invoke(gateway.url, ['agents', 'search', '--query', 'q']);
  const create = await invoke(gateway.url, ['--allow-unsupported', 'agents', 'create', '--name', 'N', '--description', 'D']);
  const tail = await invoke(gateway.url, ['transcript', 'tail', '--agent', 'agent-1']);
  const rejected = await invoke(gateway.url, ['agents', 'create', '--name', 'N', '--description', 'D']);

  for (const result of [doctor, status, list, search, create, tail]) assert.equal(result.code, 0);
  assert.equal(rejected.code, 3);
  for (const result of [doctor, status, list, search, create, tail, rejected]) {
    assert.doesNotMatch(result.stdout + result.stderr, unsafeControl);
  }
  for (const result of [doctor, status, list, search, create, rejected]) {
    assert.match(result.stdout + result.stderr, /\\x1b/);
    assert.match(result.stdout + result.stderr, /\\r\\n/);
    assert.match(result.stdout + result.stderr, /\\u009b/);
  }
  assert.match(list.stdout, /\\t/);
  assert.equal(list.stdout.split('\n').length, 2);
  assert.equal(list.stdout.split('\t').length, 2);
  assert.deepEqual(JSON.parse(tail.stdout), transcript);
  assert.match(tail.stdout, /\\u001b/);
  assert.match(tail.stdout, /\\u009b/);

  const jsonList = await invoke(gateway.url, ['agents', 'list', '--json']);
  const jsonDoctor = await invoke(gateway.url, ['doctor', '--json']);
  assert.equal(jsonList.code, 0);
  assert.equal(jsonDoctor.code, 0);
  assert.deepEqual(JSON.parse(jsonList.stdout), agents);
  assert.equal(JSON.parse(jsonDoctor.stdout).hostVersion, hostile);
});

test('usage errorはgatewayより先に判定しraw引数をechoしない', async () => {
  const marker = 'credential-marker-should-not-appear';
  let reads = 0;
  let fetches = 0;
  const cases = [
    [marker],
    ['doctor', `--${marker}`],
    ['doctor', marker],
    ['interrupt', '--agent', 'a'],
    ['send', '--agent', 'a'],
  ];
  for (const argv of cases) {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await runCli(argv, {
      env: {}, stdout, stderr, stdin: Readable.from([]), processObj: new FakeProcess(),
      readFile: async () => { reads += 1; throw new Error('unexpected'); },
      fetchImpl: async () => { fetches += 1; throw new Error('unexpected'); },
    });
    assert.equal(code, 2);
    assert.doesNotMatch(stdout.value + stderr.value, new RegExp(marker));
  }
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
});

test('値option直後の既知optionはusage errorになり接続・POSTしない', async () => {
  const marker = 'credential-marker-should-not-appear';
  let reads = 0;
  let fetches = 0;
  const cases = [
    ['send', '--agent', marker, '--prompt', '--stdin'],
    ['send', '--agent', marker, '--prompt', '--literal-prompt'],
    ['chat', '--agent', marker, '--prompt', '--stdin'],
    ['chat', '--agent', marker, '--prompt', '--literal-prompt'],
    ['agents', 'search', '--query', '--limit', '2'],
    ['agents', 'search', '--query', '--literal-query'],
    ['agents', 'search', '--query', 'q', '--limit', '--json'],
    ['agents', 'create', '--name', '--description', marker],
    ['transcript', 'tail', '--agent', '--limit', '2'],
    ['--data-root', '--allow-remote', 'doctor'],
    ['--data-root', '--json', 'doctor'],
    ['--gateway-url', '--json', 'doctor'],
    ['--request-timeout', '--json', 'doctor'],
  ];
  for (const argv of cases) {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await runCli(argv, {
      env: {}, stdout, stderr, stdin: Readable.from([]), processObj: new FakeProcess(),
      readFile: async () => { reads += 1; throw new Error('unexpected'); },
      fetchImpl: async () => { fetches += 1; throw new Error('unexpected'); },
    });
    assert.equal(code, 2);
    assert.doesNotMatch(stdout.value + stderr.value, new RegExp(marker));
  }
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
});

test('doctorはgetHostStatusのAPI rejectionとtransport分類を保持する', async (t) => {
  let mode = 401;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') {
      if (mode === 'transport') return request.socket.destroy();
      return json(response, mode, { error: 'unavailable' });
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);
  for (const [value, expected] of [[401, 5], [500, 5], ['transport', 4]]) {
    mode = value;
    const result = await invoke(gateway.url, ['doctor', '--json']);
    assert.equal(result.code, expected);
    assert.equal(result.stdout, '');
  }
});

test('各commandは観測契約どおりのpayloadを送る', async (t) => {
  const calls = [];
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    const method = request.url.slice('/api/'.length);
    const body = await readJson(request);
    calls.push({ method, body });
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (method === 'searchAgents') return json(response, 200, []);
    if (method === 'createAgent') return json(response, 200, { agent: { id: 'new' } });
    if (method === 'getAgentTranscriptTail') return json(response, 200, { entries: [], nextBeforeSeq: 6 });
    if (method === 'sendPrompt') return json(response, 200, { accepted: true });
    if (method === 'interruptAgentRun') return json(response, 200, { hadActiveRun: true });
    return json(response, 200, []);
  });
  t.after(gateway.close);

  assert.equal((await invoke(gateway.url, ['agents', 'search', '--query', 'abc', '--limit', '3', '--json'])).code, 0);
  assert.equal((await invoke(gateway.url, ['agents', 'create', '--name', 'N', '--description', 'D', '--json'])).code, 0);
  assert.equal((await invoke(gateway.url, ['transcript', 'tail', '--agent', 'agent-1', '--limit', '7', '--before-seq', '9', '--json'])).code, 0);
  assert.equal((await invoke(gateway.url, ['send', '--agent', 'agent-1', '--stdin', '--json'], { stdin: ['hello'] })).code, 0);
  assert.equal((await invoke(gateway.url, ['interrupt', '--agent', 'agent-1', '--yes', '--json'])).code, 0);

  assert.deepEqual(calls.find((call) => call.method === 'searchAgents').body, { query: 'abc', limit: 3 });
  const create = calls.find((call) => call.method === 'createAgent').body;
  assert.equal(create.name, 'N');
  assert.equal(create.description, 'D');
  assert.match(create.clientNonce, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.find((call) => call.method === 'getAgentTranscriptTail').body, { id: 'agent-1', limit: 7, beforeSeq: 9 });
  const send = calls.find((call) => call.method === 'sendPrompt').body;
  assert.equal(send.agentId, 'agent-1');
  assert.equal(send.prompt, 'hello');
  assert.match(send.clientNonce, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.find((call) => call.method === 'interruptAgentRun').body, { id: 'agent-1' });
});

test('app 0.30.0のdoctor/status/list/searchはgateway-direct profileで動作する', async (t) => {
  const agentId = `agent-${randomBytes(12).toString('hex')}`;
  const hiddenHostVersion = `host-${randomBytes(12).toString('hex')}`;
  const calls = [];
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true, isBusy: false });
    const method = request.url.slice('/api/'.length);
    const body = await readJson(request);
    calls.push({ method, body });
    if (method === 'getHostStatus') {
      return json(response, 200, { hostVersion: hiddenHostVersion, isBusy: false });
    }
    if (method === 'listAgents') {
      return json(response, 200, [{ id: agentId, name: 'Box agent', harness: 'box' }]);
    }
    if (method === 'searchAgents') {
      return json(response, 200, [{ id: agentId, name: 'Box agent', harness: 'box' }]);
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);

  const doctor = await invokeAppSession(gateway.url, '0.30.0', ['doctor', '--json']);
  const status = await invokeAppSession(gateway.url, '0.30.0', ['status', '--json']);
  const list = await invokeAppSession(gateway.url, '0.30.0', ['agents', 'list', '--json']);
  const search = await invokeAppSession(gateway.url, '0.30.0', [
    'agents', 'search', '--query', 'box', '--limit', '4', '--json',
  ]);

  for (const result of [doctor, status, list, search]) {
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, new RegExp(hiddenHostVersion));
  }
  const compatibility = JSON.parse(doctor.stdout).compatibility;
  assert.equal(compatibility.supported, true);
  assert.equal(compatibility.expectedAppVersion, '0.30.0');
  assert.deepEqual(compatibility.supportedAppVersions, ['0.24.0', '0.30.0']);
  assert.equal(compatibility.profile, 'app-session-v0.30-gateway-direct');
  assert.deepEqual(compatibility.capabilities, {
    gatewayRead: true,
    agentDiscovery: true,
    agentCreate: false,
    agentOperations: 'gateway-direct',
    dedicatedTemporalBackend: false,
    exactAgentResolutionRequired: true,
  });
  assert.equal(JSON.parse(status.stdout).compatibility.profile, 'app-session-v0.30-gateway-direct');
  assert.equal(JSON.parse(list.stdout)[0].harness, 'box');
  assert.equal(JSON.parse(search.stdout)[0].harness, 'box');
  assert.ok(calls.filter((call) => call.method === 'getHostStatus').every((call) => call.body === undefined));
  assert.deepEqual(calls.find((call) => call.method === 'searchAgents').body, { query: 'box', limit: 4 });
});

test('app 0.30.0はmissing/box/temporal/unknown harnessのagent操作をgatewayへ直接routeする', async (t) => {
  const agentId = `agent-${randomBytes(12).toString('hex')}`;
  const prompt = `prompt-${randomBytes(12).toString('hex')}`;
  const unknownHarness = `unknown-${randomBytes(12).toString('hex')}`;
  const nonce = '00000000-0000-4000-8000-000000000030';
  const calls = [];
  let currentAgent;
  let sseCalls = 0;
  let nonceCalls = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/events?channels=transcript') {
      sseCalls += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ channel: 'transcript', payload: { type: 'append', agentId, entry: { text: 'ok' } } })}\n\n`);
      return response.end();
    }
    const method = request.url.slice('/api/'.length);
    const body = await readJson(request);
    calls.push({ method, body });
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: 'private-wire-value', isBusy: false });
    if (method === 'listAgents') return json(response, 200, [currentAgent]);
    if (method === 'getAgentTranscriptTail') return json(response, 200, { entries: [], nextBeforeSeq: null });
    if (method === 'sendPrompt') return json(response, 200, { accepted: true });
    if (method === 'interruptAgentRun') return json(response, 200, { hadActiveRun: true });
    return json(response, 404, {});
  });
  t.after(gateway.close);
  const extra = {
    randomUUID: () => {
      nonceCalls += 1;
      return nonce;
    },
  };
  const variants = [
    { label: 'missing', agent: { id: agentId } },
    { label: 'box', agent: { id: agentId, harness: 'box' } },
    { label: 'temporal', agent: { id: agentId, harness: 'temporal' } },
    { label: 'unknown', agent: { id: agentId, harness: unknownHarness } },
  ];

  for (const variant of variants) {
    currentAgent = variant.agent;
    const results = [
      await invokeAppSession(gateway.url, '0.30.0', [
        'transcript', 'tail', '--agent', agentId, '--json',
      ], extra),
      await invokeAppSession(gateway.url, '0.30.0', [
        'watch', '--agent', agentId, '--timeout', '0.02',
      ], extra),
      await invokeAppSession(gateway.url, '0.30.0', [
        'send', '--agent', agentId, '--prompt', prompt, '--json',
      ], extra),
      await invokeAppSession(gateway.url, '0.30.0', [
        'chat', '--agent', agentId, '--prompt', prompt, '--timeout', '0.02',
      ], extra),
      await invokeAppSession(gateway.url, '0.30.0', [
        'interrupt', '--agent', agentId, '--yes', '--json',
      ], extra),
    ];
    for (const result of results) {
      assert.equal(result.code, 0, variant.label);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${prompt}|${TEST_TOKEN}`));
    }
  }

  assert.equal(calls.filter((call) => call.method === 'listAgents').length, variants.length * 6);
  assert.equal(calls.filter((call) => call.method === 'getAgentTranscriptTail').length, variants.length);
  assert.equal(calls.filter((call) => call.method === 'interruptAgentRun').length, variants.length);
  assert.ok(sseCalls >= variants.length * 2);
  const sends = calls.filter((call) => call.method === 'sendPrompt');
  assert.equal(sends.length, variants.length * 2);
  assert.equal(nonceCalls, sends.length);
  for (const call of sends) {
    assert.equal(call.body.agentId, agentId);
    assert.equal(call.body.prompt, prompt);
    assert.equal(call.body.clientNonce, nonce);
    assert.ok(call.body.clientNonce.length > 0);
  }
});

test('app 0.30.0のTemporal agentでgatewayが拒否したらAPI rejectionとして一度だけ扱う', async (t) => {
  const agentId = `agent-${randomBytes(12).toString('hex')}`;
  const prompt = `prompt-${randomBytes(12).toString('hex')}`;
  const rejectionDetail = `detail-${randomBytes(12).toString('hex')}`;
  let listCalls = 0;
  let sendCalls = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    const method = request.url.slice('/api/'.length);
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: 'private-wire-value' });
    if (method === 'listAgents') {
      listCalls += 1;
      return json(response, 200, [{ id: agentId, harness: 'temporal' }]);
    }
    if (method === 'sendPrompt') {
      sendCalls += 1;
      return json(response, 409, { error: rejectionDetail });
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);

  const result = await invokeAppSession(gateway.url, '0.30.0', [
    'send', '--agent', agentId, '--prompt', prompt, '--json',
  ]);
  assert.equal(result.code, 5);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /409/);
  assert.equal(listCalls, 1);
  assert.equal(sendCalls, 1);
  for (const hidden of [agentId, prompt, rejectionDetail, TEST_TOKEN]) {
    assert.doesNotMatch(result.stderr, new RegExp(hidden));
  }
});

test('app 0.30.0のsend/chatはstdin読了後のharness変化に依存せず送信する', async (t) => {
  const agentId = `agent-${randomBytes(12).toString('hex')}`;
  const prompt = `prompt-${randomBytes(12).toString('hex')}`;
  const nonce = '00000000-0000-4000-8000-000000000031';
  let currentHarness = 'box';
  let listCalls = 0;
  const sends = [];
  let sseCalls = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/events?channels=transcript') {
      sseCalls += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ channel: 'transcript', payload: { type: 'append', agentId, entry: { text: 'ok' } } })}\n\n`);
      return response.end();
    }
    const method = request.url.slice('/api/'.length);
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: 'private-wire-value', isBusy: false });
    if (method === 'listAgents') {
      listCalls += 1;
      assert.equal(currentHarness, 'temporal');
      return json(response, 200, [{ id: agentId, harness: currentHarness }]);
    }
    if (method === 'sendPrompt') {
      sends.push(await readJson(request));
      return json(response, 200, { accepted: true });
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);

  async function* transitioningInput() {
    await new Promise((resolve) => setImmediate(resolve));
    currentHarness = 'temporal';
    yield prompt;
  }

  const cases = [
    ['send', '--agent', agentId, '--stdin', '--json'],
    ['chat', '--agent', agentId, '--stdin', '--timeout', '0.03'],
  ];
  for (const argv of cases) {
    currentHarness = 'box';
    const result = await invokeAppSession(gateway.url, '0.30.0', argv, {
      stdin: transitioningInput(),
      randomUUID: () => nonce,
    });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${prompt}|${TEST_TOKEN}`));
  }
  assert.equal(listCalls, 3);
  assert.equal(sends.length, 2);
  assert.ok(sseCalls >= 1);
  for (const body of sends) {
    assert.equal(body.agentId, agentId);
    assert.equal(body.prompt, prompt);
    assert.equal(body.clientNonce, nonce);
  }
});

test('app 0.30.0のchatはSSE open後のharness変化を無視し再解決後に一度だけ送信する', async (t) => {
  const agentId = `agent-${randomBytes(12).toString('hex')}`;
  const prompt = `prompt-${randomBytes(12).toString('hex')}`;
  const nonce = '00000000-0000-4000-8000-000000000032';
  let currentAgent = { id: agentId };
  let listCalls = 0;
  const sends = [];
  let sseCalls = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const openResponses = new Set();
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/events?channels=transcript') {
      sseCalls += 1;
      currentAgent = { id: agentId, harness: 'temporal' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(':open\n\n');
      openResponses.add(response);
      response.on('close', () => {
        openResponses.delete(response);
        resolveClosed();
      });
      return;
    }
    const method = request.url.slice('/api/'.length);
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: 'private-wire-value', isBusy: false });
    if (method === 'listAgents') {
      listCalls += 1;
      return json(response, 200, [currentAgent]);
    }
    if (method === 'sendPrompt') {
      sends.push(await readJson(request));
      return json(response, 200, { accepted: true });
    }
    return json(response, 200, {});
  });
  t.after(() => {
    for (const response of openResponses) response.end();
    return gateway.close();
  });

  const result = await invokeAppSession(gateway.url, '0.30.0', [
    'chat', '--agent', agentId, '--prompt', prompt, '--timeout', '0.05',
  ], { randomUUID: () => nonce });
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE socketが閉じられませんでした')), 500)),
  ]);
  assert.equal(result.code, 0);
  const lines = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'accepted');
  assert.deepEqual(lines.at(-1), { type: 'end', reason: 'timeout' });
  assert.equal(result.stderr, '');
  assert.equal(listCalls, 2);
  assert.equal(sseCalls, 1);
  assert.deepEqual(sends, [{ agentId, prompt, clientNonce: nonce }]);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${prompt}|${TEST_TOKEN}`));
});

test('app 0.30.0はexact IDが0件または重複なら対象APIとSSEより前に拒否する', async (t) => {
  const agentId = `agent-${randomBytes(12).toString('hex')}`;
  const prompt = `prompt-${randomBytes(12).toString('hex')}`;
  let currentAgents = [];
  let listCalls = 0;
  let targetCalls = 0;
  let sseCalls = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/events?channels=transcript') {
      sseCalls += 1;
      return response.end();
    }
    const method = request.url.slice('/api/'.length);
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: 'private-wire-value', isBusy: false });
    if (method === 'listAgents') {
      listCalls += 1;
      return json(response, 200, currentAgents);
    }
    targetCalls += 1;
    return json(response, 200, {});
  });
  t.after(gateway.close);
  const commands = [
    { argv: ['transcript', 'tail', '--agent', agentId, '--json'], structured: true },
    { argv: ['watch', '--agent', agentId, '--timeout', '0.01'], structured: false },
    { argv: ['send', '--agent', agentId, '--prompt', prompt, '--json'], structured: true },
    { argv: ['chat', '--agent', agentId, '--prompt', prompt, '--timeout', '0.01'], structured: false },
    { argv: ['interrupt', '--agent', agentId, '--yes', '--json'], structured: true },
  ];
  const variants = [
    { agents: [], reason: 'agent-not-found' },
    {
      agents: [{ id: agentId, harness: 'box' }, { id: agentId, harness: 'box' }],
      reason: 'agent-selection-ambiguous',
    },
  ];

  for (const variant of variants) {
    currentAgents = variant.agents;
    for (const command of commands) {
      const result = await invokeAppSession(gateway.url, '0.30.0', command.argv);
      assert.equal(result.code, 3);
      assert.equal(result.stdout, '');
      if (command.structured) assert.equal(JSON.parse(result.stderr).error.reason, variant.reason);
      else assert.match(result.stderr, new RegExp(`reason: ${variant.reason}`));
      for (const hidden of [agentId, prompt, TEST_TOKEN]) {
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(hidden));
      }
    }
  }
  assert.equal(listCalls, variants.length * commands.length);
  assert.equal(targetCalls, 0);
  assert.equal(sseCalls, 0);
});

test('app 0.30.0のchatはSSE open後のID消失・重複を再解決で拒否しstreamを閉じる', async (t) => {
  const agentId = `agent-${randomBytes(12).toString('hex')}`;
  const prompt = `prompt-${randomBytes(12).toString('hex')}`;
  let secondAgents = [];
  let runListCalls = 0;
  let listCalls = 0;
  let sendCalls = 0;
  let sseCalls = 0;
  let resolveClosed;
  let closed;
  const openResponses = new Set();
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/events?channels=transcript') {
      sseCalls += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(':open\n\n');
      openResponses.add(response);
      response.on('close', () => {
        openResponses.delete(response);
        resolveClosed?.();
      });
      return;
    }
    const method = request.url.slice('/api/'.length);
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: 'private-wire-value' });
    if (method === 'listAgents') {
      listCalls += 1;
      runListCalls += 1;
      return json(response, 200, runListCalls === 1 ? [{ id: agentId }] : secondAgents);
    }
    if (method === 'sendPrompt') sendCalls += 1;
    return json(response, 200, {});
  });
  t.after(() => {
    for (const response of openResponses) response.end();
    return gateway.close();
  });

  const variants = [
    { agents: [], reason: 'agent-not-found' },
    {
      agents: [{ id: agentId, harness: 'box' }, { id: agentId, harness: 'temporal' }],
      reason: 'agent-selection-ambiguous',
    },
  ];
  for (const variant of variants) {
    runListCalls = 0;
    secondAgents = variant.agents;
    closed = new Promise((resolve) => { resolveClosed = resolve; });
    const result = await invokeAppSession(gateway.url, '0.30.0', [
      'chat', '--agent', agentId, '--prompt', prompt, '--timeout', '0.2',
    ]);
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE socketが閉じられませんでした')), 500)),
    ]);
    assert.equal(result.code, 3);
    assert.deepEqual(JSON.parse(result.stdout), { type: 'end', reason: 'error' });
    assert.match(result.stderr, new RegExp(`reason: ${variant.reason}`));
    assert.equal(runListCalls, 2);
    for (const hidden of [agentId, prompt, TEST_TOKEN]) {
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(hidden));
    }
  }
  assert.equal(listCalls, variants.length * 2);
  assert.equal(sseCalls, variants.length);
  assert.equal(sendCalls, 0);
});

test('app 0.30.0のagents createはallow-unsupportedでもAPI前に拒否する', async (t) => {
  const name = `name-${randomBytes(12).toString('hex')}`;
  const description = `description-${randomBytes(12).toString('hex')}`;
  let apiCalls = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    apiCalls += 1;
    return json(response, 200, {});
  });
  t.after(gateway.close);

  for (const prefix of [[], ['--allow-unsupported']]) {
    const result = await invokeAppSession(gateway.url, '0.30.0', [
      ...prefix, 'agents', 'create', '--name', name, '--description', description, '--json',
    ]);
    assert.equal(result.code, 3);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.reason, 'temporal-create-unsupported');
    assert.doesNotMatch(result.stderr, new RegExp(`${name}|${description}|${TEST_TOKEN}`));
  }
  assert.equal(apiCalls, 0);
});

test('app 0.24.0のagent操作はharness用listAgentsを追加せず従来APIへ進む', async (t) => {
  const agentId = `agent-${randomBytes(12).toString('hex')}`;
  const prompt = `prompt-${randomBytes(12).toString('hex')}`;
  let listCalls = 0;
  const targetCalls = {
    createAgent: 0,
    getAgentTranscriptTail: 0,
    sendPrompt: 0,
    interruptAgentRun: 0,
  };
  let sseCalls = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/events?channels=transcript') {
      sseCalls += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ channel: 'transcript', payload: { type: 'append', agentId, entry: { text: 'ok' } } })}\n\n`);
      return response.end();
    }
    const method = request.url.slice('/api/'.length);
    if (method === 'getHostStatus') return json(response, 200, { hostVersion: 'private-wire-value' });
    if (method === 'listAgents') listCalls += 1;
    if (method in targetCalls) targetCalls[method] += 1;
    if (method === 'createAgent') return json(response, 200, { agent: { id: 'created' } });
    if (method === 'getAgentTranscriptTail') return json(response, 200, { entries: [] });
    if (method === 'sendPrompt') return json(response, 200, { accepted: true });
    if (method === 'interruptAgentRun') return json(response, 200, { hadActiveRun: true });
    return json(response, 200, []);
  });
  t.after(gateway.close);

  const tail = await invokeAppSession(gateway.url, '0.24.0', [
    'transcript', 'tail', '--agent', agentId, '--json',
  ]);
  const watch = await invokeAppSession(gateway.url, '0.24.0', [
    'watch', '--agent', agentId, '--timeout', '0.03',
  ]);
  const send = await invokeAppSession(gateway.url, '0.24.0', [
    'send', '--agent', agentId, '--prompt', prompt, '--json',
  ]);
  const chat = await invokeAppSession(gateway.url, '0.24.0', [
    'chat', '--agent', agentId, '--prompt', prompt, '--timeout', '0.03',
  ]);
  const interrupt = await invokeAppSession(gateway.url, '0.24.0', [
    'interrupt', '--agent', agentId, '--yes', '--json',
  ]);
  const create = await invokeAppSession(gateway.url, '0.24.0', [
    'agents', 'create', '--name', 'Legacy', '--description', 'Legacy agent', '--json',
  ]);

  for (const result of [tail, watch, send, chat, interrupt, create]) assert.equal(result.code, 0);
  assert.equal(listCalls, 0);
  assert.equal(targetCalls.createAgent, 1);
  assert.equal(targetCalls.getAgentTranscriptTail, 1);
  assert.equal(targetCalls.sendPrompt, 2);
  assert.equal(targetCalls.interruptAgentRun, 1);
  assert.ok(sseCalls >= 2);
});

test('unsupported hostへの書込みはfail closedし明示override時だけ送る', async (t) => {
  let createCount = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.25.0' });
    if (request.url === '/api/createAgent') {
      createCount += 1;
      return json(response, 200, { agent: { id: 'new' } });
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);
  const denied = await invoke(gateway.url, ['agents', 'create', '--name', 'N', '--description', 'D']);
  assert.equal(denied.code, 3);
  assert.equal(createCount, 0);
  const allowed = await invoke(gateway.url, ['--allow-unsupported', 'agents', 'create', '--name', 'N', '--description', 'D']);
  assert.equal(allowed.code, 0);
  assert.equal(createCount, 1);
  assert.match(allowed.stderr, /warning/);
});

test('hostVersion欠落時はallow-unsupportedでも書込みを拒否する', async (t) => {
  let sends = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { isBusy: false });
    if (request.url === '/api/sendPrompt') sends += 1;
    return json(response, 200, { accepted: true });
  });
  t.after(gateway.close);
  const result = await invoke(gateway.url, ['--allow-unsupported', 'send', '--agent', 'a', '--prompt', 'private']);
  assert.equal(result.code, 3);
  assert.equal(sends, 0);
});

test('version確認APIのrejection/transport分類を保持しつつ書込みを拒否する', async (t) => {
  let mode = 401;
  let sends = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') {
      if (mode === 'transport') return request.socket.destroy();
      return json(response, mode, { error: 'not available' });
    }
    if (request.url === '/api/sendPrompt') sends += 1;
    return json(response, 200, { accepted: true });
  });
  t.after(gateway.close);
  for (const [value, expected] of [[401, 5], [500, 5], ['transport', 4]]) {
    mode = value;
    const result = await invoke(gateway.url, ['send', '--agent', 'a', '--prompt', 'private']);
    assert.equal(result.code, expected);
  }
  assert.equal(sends, 0);
});

test('401/403/404/409/500はAPI rejectionでbodyやtokenを表示しない', async (t) => {
  let status = 401;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    return json(response, status, { error: `${TEST_TOKEN} prompt-body ${status}` });
  });
  t.after(gateway.close);
  for (const value of [401, 403, 404, 409, 500]) {
    status = value;
    const result = await invoke(gateway.url, ['send', '--agent', 'a', '--prompt', 'prompt-body']);
    assert.equal(result.code, 5);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${TEST_TOKEN}|prompt-body|Authorization`, 'i'));
    assert.match(result.stderr, new RegExp(String(value)));
  }
});

test('transport失敗時にPOSTを自動再送しない', async (t) => {
  let sends = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/sendPrompt') {
      sends += 1;
      request.socket.destroy();
      return;
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);
  const result = await invoke(gateway.url, ['send', '--agent', 'a', '--prompt', 'private']);
  assert.equal(result.code, 4);
  assert.equal(sends, 1);
  assert.doesNotMatch(result.stderr, new RegExp(`private|${TEST_TOKEN}`));
});

test('watchはstdout drainまで次eventを書かずdrain後に継続する', async () => {
  const stdout = new ControlledOutput();
  const stderr = new Capture();
  const events = [1, 2].map((sequence) => ({
    channel: 'transcript', payload: { type: 'append', agentId: 'a', sequence },
  }));
  const running = runCli(['watch', '--agent', 'a', '--timeout', '0.3'], {
    env: { GB_GATEWAY_URL: 'http://localhost:3210' },
    fetchImpl: streamingFetch(events),
    stdout,
    stderr,
    processObj: new FakeProcess(),
  });
  await waitUntil(() => stdout.writes.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stdout.writes.length, 1);
  assert.equal(JSON.parse(stdout.writes[0]).payload.sequence, 1);
  stdout.drain();
  assert.equal(await running, 0);
  assert.equal(JSON.parse(stdout.writes[1]).payload.sequence, 2);
  assert.deepEqual(JSON.parse(stdout.writes.at(-1)), { type: 'end', reason: 'timeout' });
  assert.equal(stdout.listenerCount('drain'), 0);
  assert.equal(stdout.listenerCount('error'), 0);
  assert.equal(stdout.listenerCount('close'), 0);
});

test('watchのstdout backpressure待機はtimeoutとSIGINTで解除してcleanupする', async () => {
  const event = { channel: 'transcript', payload: { type: 'append', agentId: 'a', sequence: 1 } };
  for (const mode of ['timeout', 'sigint']) {
    const stdout = new ControlledOutput();
    const stderr = new Capture();
    const processObj = new FakeProcess();
    const argv = ['watch', '--agent', 'a', ...(mode === 'timeout' ? ['--timeout', '0.05'] : [])];
    const running = runCli(argv, {
      env: { GB_GATEWAY_URL: 'http://localhost:3210' },
      fetchImpl: streamingFetch([event]),
      stdout,
      stderr,
      processObj,
    });
    await waitUntil(() => stdout.writes.length === 1);
    if (mode === 'sigint') processObj.emit('SIGINT');
    assert.equal(await running, mode === 'sigint' ? 130 : 0);
    assert.deepEqual(JSON.parse(stdout.writes.at(-1)), { type: 'end', reason: mode });
    assert.equal(stdout.listenerCount('drain'), 0);
    assert.equal(stdout.listenerCount('error'), 0);
    assert.equal(stdout.listenerCount('close'), 0);
    assert.equal(processObj.listenerCount('SIGINT'), 0);
  }
});

test('watchのstdout errorは固定transport errorで追加endを書かずcleanupする', async () => {
  const stdout = new ControlledOutput();
  const stderr = new Capture();
  const processObj = new FakeProcess();
  const event = { channel: 'transcript', payload: { type: 'append', agentId: 'a', sequence: 1 } };
  const running = runCli(['watch', '--agent', 'a'], {
    env: { GB_GATEWAY_URL: 'http://localhost:3210' },
    fetchImpl: streamingFetch([event]),
    stdout,
    stderr,
    processObj,
  });
  await waitUntil(() => stdout.writes.length === 1);
  stdout.emit('error', new Error('表示してはいけないstdout詳細'));
  assert.equal(await running, 4);
  assert.equal(stdout.writes.length, 1);
  assert.doesNotMatch(stdout.writes.join(''), /"type":"end"/);
  assert.equal(stderr.value, 'gb: stdoutへの書き込みに失敗しました\n');
  assert.equal(stdout.listenerCount('drain'), 0);
  assert.equal(stdout.listenerCount('error'), 0);
  assert.equal(stdout.listenerCount('close'), 0);
  assert.equal(processObj.listenerCount('SIGINT'), 0);
});

test('chatはSSE open後にsendを一度だけ行い、SSEのみ再接続してtimeout終了する', async (t) => {
  const order = [];
  let sends = 0;
  let streams = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/sendPrompt') {
      order.push('send');
      sends += 1;
      return json(response, 200, { accepted: true });
    }
    if (request.url === '/events?channels=transcript') {
      assert.equal(request.headers.authorization, `Bearer ${TEST_TOKEN}`);
      assert.equal(request.headers.origin, undefined);
      streams += 1;
      order.push(`sse-${streams}`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 5\n\n');
      response.write('data: {"channel":"transcript","payload":{"type":"append","agentId":"a","entry":{"text":"ok"}}}\n\n');
      return response.end();
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);
  const result = await invoke(gateway.url, ['chat', '--agent', 'a', '--prompt', 'hi', '--timeout', '0.35']);
  assert.equal(result.code, 0);
  assert.equal(order[0], 'sse-1');
  assert.equal(order[1], 'send');
  assert.equal(sends, 1);
  assert.ok(streams > 1);
  const lines = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'accepted');
  assert.equal(lines.at(-1).reason, 'timeout');
});

test('chatのSSE接続前timeoutはpromptを送らずJSONL endと0を返す', async (t) => {
  let sends = 0;
  const pending = new Set();
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/sendPrompt') {
      sends += 1;
      return json(response, 200, { accepted: true });
    }
    if (request.url === '/events?channels=transcript') {
      pending.add(response);
      response.on('close', () => pending.delete(response));
      return;
    }
    return json(response, 404, {});
  });
  t.after(() => {
    for (const response of pending) response.end();
    return gateway.close();
  });
  const result = await invoke(gateway.url, ['chat', '--agent', 'a', '--prompt', 'private', '--timeout', '0.02']);
  assert.equal(result.code, 0);
  assert.equal(sends, 0);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'end', reason: 'timeout' });
});

test('chatのSSE接続前SIGINTはpromptを送らずJSONL endと130を返す', async (t) => {
  let sends = 0;
  const pending = new Set();
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/sendPrompt') sends += 1;
    if (request.url === '/events?channels=transcript') {
      pending.add(response);
      response.on('close', () => pending.delete(response));
      return;
    }
    return json(response, 404, {});
  });
  t.after(() => {
    for (const response of pending) response.end();
    return gateway.close();
  });
  const processObj = new FakeProcess();
  setTimeout(() => processObj.emit('SIGINT'), 20);
  const result = await invoke(gateway.url, ['chat', '--agent', 'a', '--prompt', 'private'], { processObj });
  assert.equal(result.code, 130);
  assert.equal(sends, 0);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'end', reason: 'sigint' });
});

test('chatはtext/event-stream以外をSSE openとみなさずpromptを送らない', async (t) => {
  let sends = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/sendPrompt') {
      sends += 1;
      return json(response, 200, { accepted: true });
    }
    if (request.url === '/events?channels=transcript') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end('<p>not SSE</p>');
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);
  const result = await invoke(gateway.url, ['chat', '--agent', 'a', '--prompt', 'private']);
  assert.equal(result.code, 4);
  assert.equal(sends, 0);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'end', reason: 'error' });
});

test('chatはsendPrompt失敗時にSSEを閉じ、end:error後に元のexit codeで終了する', async (t) => {
  let mode = 500;
  let sends = 0;
  let resolveClosed;
  let closed = new Promise((resolve) => { resolveClosed = resolve; });
  const openResponses = new Set();
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/sendPrompt') {
      sends += 1;
      if (mode === 'transport') return request.socket.destroy();
      return json(response, mode, { error: 'private prompt must not echo' });
    }
    if (request.url === '/events?channels=transcript') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(':open\n\n');
      openResponses.add(response);
      response.on('close', () => {
        openResponses.delete(response);
        resolveClosed();
      });
      return;
    }
    return json(response, 404, {});
  });
  t.after(() => {
    for (const response of openResponses) response.end();
    return gateway.close();
  });

  for (const [value, expected] of [[500, 5], ['transport', 4]]) {
    mode = value;
    closed = new Promise((resolve) => { resolveClosed = resolve; });
    const result = await invoke(gateway.url, ['chat', '--agent', 'a', '--prompt', 'private-marker']);
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE socketが閉じられませんでした')), 500)),
    ]);
    assert.equal(result.code, expected);
    assert.deepEqual(JSON.parse(result.stdout), { type: 'end', reason: 'error' });
    assert.doesNotMatch(result.stdout + result.stderr, /private-marker/);
  }
  assert.equal(sends, 2);
});

test('watchはfetchがdecodeしたgzip SSEをJSONL出力する', async (t) => {
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/events?channels=transcript') {
      const event = { channel: 'transcript', payload: { type: 'append', agentId: 'a', entry: { text: 'gzip', [TEST_TOKEN]: 'bad' } } };
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
      return response.end(gzipSync(frame));
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);
  const result = await invoke(gateway.url, ['watch', '--agent', 'a', '--timeout', '0.05']);
  assert.equal(result.code, 0);
  const lines = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].payload.entry.text, 'gzip');
  assert.equal(lines.at(-1).reason, 'timeout');
  assert.doesNotMatch(result.stdout, new RegExp(TEST_TOKEN));
});

test('request timeoutはtransport errorになりPOSTを再送しない', async (t) => {
  let sends = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/sendPrompt') {
      sends += 1;
      return;
    }
    return json(response, 404, {});
  });
  t.after(gateway.close);
  const result = await invoke(gateway.url, ['--request-timeout', '0.02', 'send', '--agent', 'a', '--prompt', 'private']);
  assert.equal(result.code, 4);
  assert.equal(sends, 1);
  assert.doesNotMatch(result.stderr, new RegExp(`private|${TEST_TOKEN}`));
});

test('watchのCtrl-Cはinterrupt APIを呼ばず130で終了する', async (t) => {
  let interruptCalls = 0;
  const sockets = new Set();
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/interruptAgentRun') {
      interruptCalls += 1;
      return json(response, 200, {});
    }
    if (request.url === '/events?channels=transcript') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(':ping\n\n');
      sockets.add(response);
      response.on('close', () => sockets.delete(response));
      return;
    }
    return json(response, 404, {});
  });
  t.after(() => {
    for (const response of sockets) response.end();
    return gateway.close();
  });
  const processObj = new FakeProcess();
  setTimeout(() => processObj.emit('SIGINT'), 30);
  const result = await invoke(gateway.url, ['watch', '--agent', 'a'], { processObj });
  assert.equal(result.code, 130);
  assert.equal(interruptCalls, 0);
  assert.match(result.stdout, /"reason":"sigint"/);
});

test('interruptは--yesなしならusage errorでAPIを呼ばない', async (t) => {
  let interruptCalls = 0;
  const gateway = await startGateway(async (request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true });
    if (request.url === '/api/getHostStatus') return json(response, 200, { hostVersion: '0.24.0' });
    if (request.url === '/api/interruptAgentRun') interruptCalls += 1;
    return json(response, 200, {});
  });
  t.after(gateway.close);
  const result = await invoke(gateway.url, ['interrupt', '--agent', 'a']);
  assert.equal(result.code, 2);
  assert.equal(interruptCalls, 0);
});
