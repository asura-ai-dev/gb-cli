import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  appSessionError,
  decryptSafeStorageV10,
  loadDesktopAppVersion,
  loadAppSession,
  validateAppSessionConnection,
} from '../src/app-session.js';

function secret(label) {
  return `${label}-${randomBytes(12).toString('hex')}`;
}

function encrypt(plaintext, password) {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]).toString('base64');
}

function fixture(overrides = {}) {
  const password = secret('password');
  const token = secret('token');
  const routing = secret('routing');
  const host = `${randomBytes(8).toString('hex')}.invalid`;
  const baseUrl = `https://${host}`;
  const connection = {
    baseUrl,
    token,
    headers: { 'X-AnyRun-Network-Token': routing },
    vncProxy: null,
    ...overrides.connection,
  };
  const encrypted = overrides.plaintext === undefined
    ? encrypt(JSON.stringify(connection), password)
    : encrypt(overrides.plaintext, password);
  const wrapper = overrides.wrapper ?? {
    version: 2,
    entries: { [secret('account')]: { savedAtMs: Date.now(), encrypted } },
  };
  return { password, token, routing, baseUrl, encrypted, wrapper, connection };
}

function errorReason(reason) {
  return (error) => {
    assert.equal(error.code, `APP_SESSION_${reason.toUpperCase()}`);
    assert.equal(error.reason, reason);
    assert.equal(typeof error.hint, 'string');
    assert.ok(error.hint.length > 0);
    assert.equal(error.appSession, true);
    assert.equal(error.exitCode, 3);
    return true;
  };
}

async function loadWith(value, extra = {}) {
  return loadAppSession({
    platform: 'darwin',
    homedir: () => '/tmp/isolated-home',
    loadAppVersion: async () => ({ appVersion: '0.24.0', compatibilitySource: 'app-bundle' }),
    readFile: async () => JSON.stringify(value.wrapper),
    execFile: async () => ({ stdout: Buffer.from(`${value.password}\n`), stderr: Buffer.alloc(0) }),
    ...extra,
  });
}

function missingFile() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  return error;
}

function appBundleDependencies({
  home = `/tmp/home-${randomBytes(8).toString('hex')}`,
  locations = ['user'],
  identifier = 'com.anysphere.sand',
  version = '0.24.0',
  symlink,
  spawnError,
  snapshot = Buffer.from(`synthetic-plist-${randomBytes(12).toString('hex')}`),
  initialPlistStat,
  pathStats = [],
  fdStats = [],
  realpathOverride,
} = {}) {
  const systemBundle = '/Applications/Grok Bot.app';
  const userBundle = path.join(home, 'Applications', 'Grok Bot.app');
  const installed = new Set(locations.map((location) => (location === 'system' ? systemBundle : userBundle)));
  const calls = {
    lstat: [], realpath: [], open: [], plutilSpawn: [], buffers: [],
    inputBuffers: [], inputCopies: [], snapshotTargets: [], timeouts: [], closes: 0,
  };
  const plistLstatCalls = new Map();
  const makeBundleStat = (kind) => ({
    isSymbolicLink: () => symlink === kind,
    isDirectory: () => kind === 'bundle',
    isFile: () => kind === 'plist',
  });
  const makePlistStat = (bundle, overrides = {}) => ({
    dev: bundle === systemBundle ? 1 : 2,
    ino: bundle === systemBundle ? 11 : 21,
    size: snapshot.length,
    mtimeMs: 100,
    ctimeMs: 100,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true,
    ...overrides,
  });
  return {
    home,
    calls,
    dependencies: {
      platform: 'darwin',
      homedir: () => home,
      lstat: async (target) => {
        calls.lstat.push(target);
        const bundle = target.endsWith('Grok Bot.app') ? target : path.dirname(path.dirname(target));
        if (!installed.has(bundle)) throw missingFile();
        const kind = target.endsWith('Grok Bot.app') ? 'bundle' : 'plist';
        if (kind === 'bundle') return makeBundleStat(kind);
        if (symlink === kind) return { ...makePlistStat(bundle), isSymbolicLink: () => true };
        const count = plistLstatCalls.get(target) ?? 0;
        plistLstatCalls.set(target, count + 1);
        const fallback = makePlistStat(bundle);
        if (count === 0) return initialPlistStat ? { ...fallback, ...initialPlistStat } : fallback;
        return pathStats[count - 1] ? { ...fallback, ...pathStats[count - 1] } : fallback;
      },
      realpath: async (target) => {
        calls.realpath.push(target);
        return realpathOverride?.(target, calls.realpath.length) ?? target;
      },
      open: async (target, flags) => {
        calls.open.push([target, flags]);
        const bundle = path.dirname(path.dirname(target));
        const fallback = makePlistStat(bundle);
        let statIndex = 0;
        return {
          stat: async () => {
            const configured = fdStats[statIndex++];
            return configured ? { ...fallback, ...configured } : fallback;
          },
          read: async (targetBuffer) => {
            calls.snapshotTargets.push(targetBuffer);
            snapshot.copy(targetBuffer);
            return { bytesRead: snapshot.length, buffer: targetBuffer };
          },
          close: async () => { calls.closes += 1; },
        };
      },
      plutilSpawn: (...args) => {
        calls.plutilSpawn.push(args);
        if (spawnError) throw spawnError;
        const child = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin.destroy = () => {};
        child.stdout.destroy = () => {};
        child.stderr.destroy = () => {};
        child.kill = () => true;
        child.unref = () => {};
        child.stdin.end = (input, callback) => {
          calls.inputBuffers.push(input);
          calls.inputCopies.push(Buffer.from(input));
          callback?.();
          queueMicrotask(() => {
            const value = args[1][1] === 'CFBundleIdentifier' ? identifier : version;
            const stdout = Buffer.from(`${value}\n`);
            const stderr = Buffer.from(randomBytes(8));
            calls.buffers.push(stdout, stderr);
            child.stdout.emit('data', stdout);
            child.stderr.emit('data', stderr);
            child.emit('close', 0, null);
          });
        };
        return child;
      },
      setTimeout: (callback, delay) => { calls.timeouts.push(delay); return setTimeout(callback, delay); },
      clearTimeout,
    },
  };
}

test('app sessionを固定pathとKeychain serviceから復号する', async () => {
  const value = fixture();
  let readCall;
  let securityCall;
  const securityStdout = Buffer.from(`${value.password}\n`);
  const securityStderr = Buffer.from(secret('stderr'));
  const result = await loadWith(value, {
    readFile: async (...args) => {
      readCall = args;
      return JSON.stringify(value.wrapper);
    },
    execFile: async (...args) => {
      securityCall = args;
      return { stdout: securityStdout, stderr: securityStderr };
    },
  });
  assert.deepEqual(readCall, [path.join('/tmp/isolated-home', 'Library', 'Application Support', 'Grok Bot', 'gateway-descriptor.json'), 'utf8']);
  assert.equal(securityCall[0], '/usr/bin/security');
  assert.deepEqual(securityCall[1], ['find-generic-password', '-w', '-s', 'Grok Bot Safe Storage']);
  const { signal, ...securityOptions } = securityCall[2];
  assert.deepEqual(securityOptions, { encoding: 'buffer', timeout: 3000, maxBuffer: 65536, shell: false });
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(result.baseUrl, value.baseUrl);
  assert.equal(result.token, value.token);
  assert.deepEqual(result.headers, { 'x-anyrun-network-token': value.routing });
  assert.equal(result.appVersion, '0.24.0');
  assert.equal(result.compatibilitySource, 'app-bundle');
  assert.deepEqual(result.secrets, [value.token, value.routing, value.baseUrl, new URL(value.baseUrl).hostname]);
  assert.ok(securityStdout.every((byte) => byte === 0));
  assert.ok(securityStderr.every((byte) => byte === 0));
});

test('非macOSはdescriptorとKeychainを読まず拒否する', async () => {
  let reads = 0;
  let keychain = 0;
  await assert.rejects(() => loadAppSession({
    platform: 'linux',
    readFile: async () => { reads += 1; },
    execFile: async () => { keychain += 1; },
  }), errorReason('platform'));
  assert.equal(reads, 0);
  assert.equal(keychain, 0);
});

test('desktop app versionは固定2候補だけを検証しplutilの固定fieldだけを読む', async () => {
  const plistSnapshot = Buffer.from(`plist-snapshot-${randomBytes(12).toString('hex')}`);
  const value = appBundleDependencies({ snapshot: plistSnapshot });
  const result = await loadDesktopAppVersion(value.dependencies);
  const systemBundle = '/Applications/Grok Bot.app';
  const userBundle = path.join(value.home, 'Applications', 'Grok Bot.app');
  const userPlist = path.join(userBundle, 'Contents', 'Info.plist');
  assert.deepEqual(result, { appVersion: '0.24.0', compatibilitySource: 'app-bundle' });
  assert.deepEqual(value.calls.lstat, [systemBundle, userBundle, userPlist, userPlist, userPlist]);
  assert.deepEqual(value.calls.realpath, [userBundle, userPlist, userPlist, userPlist]);
  assert.deepEqual(value.calls.open, [[userPlist, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW]]);
  assert.equal(value.calls.closes, 1);
  assert.equal(value.calls.plutilSpawn.length, 2);
  assert.deepEqual(value.calls.plutilSpawn.map((call) => call[0]), ['/usr/bin/plutil', '/usr/bin/plutil']);
  assert.deepEqual(value.calls.plutilSpawn.map((call) => call[1]), [
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '-'],
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', '-'],
  ]);
  for (const call of value.calls.plutilSpawn) {
    assert.deepEqual(call[2], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  }
  assert.deepEqual(value.calls.timeouts, [1500, 1500]);
  assert.equal(value.calls.inputCopies.length, 2);
  assert.deepEqual(value.calls.inputCopies[0], plistSnapshot);
  assert.deepEqual(value.calls.inputCopies[1], plistSnapshot);
  assert.deepEqual(value.calls.inputCopies[0], value.calls.inputCopies[1]);
  for (const buffer of value.calls.inputBuffers) assert.ok(buffer.every((byte) => byte === 0));
  for (const buffer of value.calls.snapshotTargets) assert.ok(buffer.every((byte) => byte === 0));
  for (const buffer of value.calls.buffers) assert.ok(buffer.every((byte) => byte === 0));
  for (const buffer of value.calls.inputCopies) buffer.fill(0);
  plistSnapshot.fill(0);
});

test('desktop app versionのmissingはdescriptorとKeychainより前に拒否する', async () => {
  const value = appBundleDependencies({ locations: [] });
  let descriptorReads = 0;
  let childCalls = 0;
  await assert.rejects(() => loadAppSession({
    ...value.dependencies,
    readFile: async () => { descriptorReads += 1; },
    execFile: async () => { childCalls += 1; },
  }), errorReason('app-version-missing'));
  assert.equal(descriptorReads, 0);
  assert.equal(childCalls, 0);
  assert.equal(value.calls.lstat.length, 2);
});

test('desktop app version reasonはすべてdescriptorとKeychainより前に伝播する', async () => {
  for (const reason of ['app-version-missing', 'app-version-invalid', 'app-version-ambiguous']) {
    let descriptorReads = 0;
    let childCalls = 0;
    await assert.rejects(() => loadAppSession({
      platform: 'darwin',
      loadAppVersion: async () => { throw appSessionError(reason); },
      readFile: async () => { descriptorReads += 1; },
      execFile: async () => { childCalls += 1; },
    }), errorReason(reason));
    assert.equal(descriptorReads, 0);
    assert.equal(childCalls, 0);
  }
});

test('desktop app versionはidentifier・semver・symlink・realpath逸脱をfail closedする', async () => {
  const escapedRealpath = appBundleDependencies();
  escapedRealpath.dependencies.realpath = async (target) => (target.endsWith('Grok Bot.app') ? '/tmp/escaped-app' : target);
  const cases = [
    [appBundleDependencies({ identifier: 'invalid.bundle' }), 'identifier'],
    ...['0.24', '01.2.3', 'https://invalid.example', '/tmp/0.24.0', `0.24.0${String.fromCharCode(0)}`]
      .map((version) => [appBundleDependencies({ version }), 'version']),
    [appBundleDependencies({ symlink: 'bundle' }), 'bundle-symlink'],
    [appBundleDependencies({ symlink: 'plist' }), 'plist-symlink'],
    [escapedRealpath, 'escaped-realpath'],
  ];
  for (const [value] of cases) {
    await assert.rejects(() => loadDesktopAppVersion(value.dependencies), errorReason('app-version-invalid'));
  }
});

test('desktop app versionは複数valid bundleをambiguousとして拒否する', async () => {
  const value = appBundleDependencies({ locations: ['system', 'user'] });
  await assert.rejects(() => loadDesktopAppVersion(value.dependencies), errorReason('app-version-ambiguous'));
  assert.equal(value.calls.plutilSpawn.length, 4);
});

test('desktop app version errorはpath・plutil出力を漏らさずbufferをzeroizeする', async () => {
  const hidden = secret('plutil-hidden');
  const privatePath = `/tmp/${secret('private-path')}`;
  const childStdout = Buffer.from(hidden);
  const childStderr = Buffer.from(hidden);
  const childError = new Error(hidden);
  childError.stdout = childStdout;
  childError.stderr = childStderr;
  const value = appBundleDependencies({ spawnError: childError });
  await assert.rejects(() => loadDesktopAppVersion(value.dependencies), (error) => {
    assert.equal(error.reason, 'app-version-invalid');
    assert.doesNotMatch(`${error.message} ${error.hint} ${error.stack}`, new RegExp(hidden));
    assert.doesNotMatch(`${error.message} ${error.hint}`, /Applications|Info\.plist/);
    return true;
  });
  assert.ok(childStdout.every((byte) => byte === 0));
  assert.ok(childStderr.every((byte) => byte === 0));
  await assert.rejects(() => loadDesktopAppVersion({
    platform: 'darwin', homedir: () => privatePath,
    lstat: async () => { const error = new Error(privatePath); error.code = 'EACCES'; throw error; },
  }), (error) => {
    assert.equal(error.reason, 'app-version-invalid');
    assert.doesNotMatch(`${error.message} ${error.hint} ${error.stack}`, new RegExp(privatePath));
    return true;
  });
});

test('desktop app versionは初回検証後の書換え・inode差替え・read中mutationをfail closedする', async () => {
  const snapshot = Buffer.from(`race-plist-${randomBytes(12).toString('hex')}`);
  const cases = [
    appBundleDependencies({ snapshot, initialPlistStat: { size: snapshot.length + 1 }, version: '0.24.0' }),
    appBundleDependencies({ snapshot, initialPlistStat: { mtimeMs: 99 }, version: '0.24.0' }),
    appBundleDependencies({ snapshot, initialPlistStat: { ctimeMs: 99 }, version: '0.24.0' }),
    appBundleDependencies({ fdStats: [{ ino: 22 }], version: '0.24.0' }),
    appBundleDependencies({ pathStats: [{ ino: 22 }], version: '0.24.0' }),
    appBundleDependencies({ fdStats: [{}, { mtimeMs: 101 }], version: '0.24.0' }),
  ];
  for (const value of cases) {
    await assert.rejects(() => loadDesktopAppVersion(value.dependencies), errorReason('app-version-invalid'));
    assert.equal(value.calls.plutilSpawn.length, 0);
    assert.equal(value.calls.closes, 1);
    for (const buffer of value.calls.snapshotTargets) assert.ok(buffer.every((byte) => byte === 0));
  }
  snapshot.fill(0);
});

test('plutil snapshot処理はtimeoutとoutput上限でchildをbounded cleanupする', async () => {
  for (const overflow of [false, true]) {
    const value = appBundleDependencies();
    const timers = [];
    const kills = [];
    const output = overflow ? Buffer.alloc(4097, 0x61) : null;
    let destroyed = 0;
    let unrefed = 0;
    value.dependencies.setTimeout = (callback, delay) => {
      const handle = { active: true };
      timers.push(delay);
      setImmediate(() => { if (handle.active) callback(); });
      return handle;
    };
    value.dependencies.clearTimeout = (handle) => { if (handle) handle.active = false; };
    value.dependencies.plutilSpawn = (...args) => {
      value.calls.plutilSpawn.push(args);
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream.destroy = () => { destroyed += 1; };
      }
      child.kill = (signal) => { kills.push(signal); return true; };
      child.unref = () => { unrefed += 1; };
      child.stdin.end = (input, callback) => {
        value.calls.inputBuffers.push(input);
        callback?.();
        if (output) queueMicrotask(() => child.stdout.emit('data', output));
      };
      return child;
    };
    await assert.rejects(() => loadDesktopAppVersion(value.dependencies), errorReason('app-version-invalid'));
    assert.deepEqual(timers, [1500, 250]);
    assert.deepEqual(kills, ['SIGKILL']);
    assert.equal(destroyed, 3);
    assert.equal(unrefed, 1);
    for (const buffer of value.calls.inputBuffers) assert.ok(buffer.every((byte) => byte === 0));
    if (output) assert.ok(output.every((byte) => byte === 0));
    for (const buffer of value.calls.snapshotTargets) assert.ok(buffer.every((byte) => byte === 0));
  }
});

test('descriptor missingとinvalid JSONをgeneric errorへ正規化する', async () => {
  await assert.rejects(() => loadAppSession({
    platform: 'darwin', loadAppVersion: async () => ({ appVersion: '0.24.0', compatibilitySource: 'app-bundle' }), readFile: async () => { throw new Error(secret('path')); }, execFile: async () => assert.fail(),
  }), errorReason('missing'));
  await assert.rejects(() => loadAppSession({
    platform: 'darwin', loadAppVersion: async () => ({ appVersion: '0.24.0', compatibilitySource: 'app-bundle' }), readFile: async () => '{', execFile: async () => assert.fail(),
  }), errorReason('invalid'));
});

test('wrapper version、entry数、encrypted、savedAtMsを厳格に検証する', async () => {
  const value = fixture();
  const entry = Object.values(value.wrapper.entries)[0];
  const cases = [
    [{ version: 1, entries: value.wrapper.entries }, 'invalid'],
    [{ version: 99, entries: value.wrapper.entries }, 'invalid'],
    [{ version: 2, entries: {} }, 'invalid'],
    [{ version: 2, entries: { a: entry, b: entry } }, 'multiple'],
    [{ version: 2, entries: { a: { savedAtMs: Date.now() } } }, 'invalid'],
    [{ version: 2, entries: { a: { savedAtMs: Date.now(), encrypted: '' } } }, 'invalid'],
    [{ version: 2, entries: { a: { savedAtMs: Date.now(), encrypted: 1 } } }, 'invalid'],
    [{ version: 2, entries: { a: { savedAtMs: Number.NaN, encrypted: value.encrypted } } }, 'invalid'],
    [{ version: 2, entries: { a: { savedAtMs: '1', encrypted: value.encrypted } } }, 'invalid'],
  ];
  for (const [wrapper, code] of cases) {
    await assert.rejects(() => loadWith({ ...value, wrapper }), errorReason(code));
  }
});

test('savedAtMsは7日TTLと5分clock skewの境界を厳格に検証する', async () => {
  const now = 2_000_000_000_000;
  const value = fixture();
  const encrypted = value.encrypted;
  for (const savedAtMs of [now - 7 * 24 * 60 * 60 * 1000, now + 5 * 60 * 1000]) {
    const wrapper = { version: 2, entries: { account: { savedAtMs, encrypted } } };
    const result = await loadWith({ ...value, wrapper }, { now: () => now });
    assert.equal(result.token, value.token);
  }
  for (const savedAtMs of [now - 8 * 24 * 60 * 60 * 1000, now + 5 * 60 * 1000 + 1]) {
    let keychainCalls = 0;
    const wrapper = { version: 2, entries: { account: { savedAtMs, encrypted } } };
    await assert.rejects(() => loadWith({ ...value, wrapper }, {
      now: () => now,
      execFile: async () => { keychainCalls += 1; throw new Error('unexpected'); },
    }), errorReason('stale'));
    assert.equal(keychainCalls, 0);
  }
});

test('Keychain timeout、failure、emptyをgeneric errorへ正規化する', async () => {
  const value = fixture();
  const runtimeSecret = secret('keychain-error');
  const cases = [
    [async () => { const error = new Error(runtimeSecret); error.killed = true; throw error; }, 'keychain'],
    [async () => { throw new Error(runtimeSecret); }, 'keychain'],
    [async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from(runtimeSecret) }), 'keychain'],
  ];
  for (const [execFile, code] of cases) {
    await assert.rejects(() => loadWith(value, { execFile }), (error) => {
      assert.equal(error.reason, code);
      assert.doesNotMatch(error.message, new RegExp(runtimeSecret));
      assert.ok(error.message.length < 100);
      return true;
    });
  }
});

test('明示timer発火だけをkeychain-timeoutに分類しchild bufferをzeroizeする', async () => {
  const value = fixture();
  const childStdout = Buffer.from(secret('child-stdout'));
  const childStderr = Buffer.from(secret('child-stderr'));
  let timeoutMs;
  const execFile = async (_path, _argv, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.stdout = childStdout;
      error.stderr = childStderr;
      reject(error);
    }, { once: true });
  });
  await assert.rejects(() => loadWith(value, {
    execFile,
    setTimeout: (callback, ms) => {
      timeoutMs = ms;
      setImmediate(callback);
      return 1;
    },
    clearTimeout: () => {},
  }), errorReason('keychain-timeout'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeoutMs, 3000);
  assert.ok(childStdout.every((byte) => byte === 0));
  assert.ok(childStderr.every((byte) => byte === 0));
});

test('timer未発火の通常nonzeroはkeychainとして扱う', async () => {
  const value = fixture();
  await assert.rejects(() => loadWith(value, {
    execFile: async () => { throw new Error('nonzero'); },
    setTimeout: () => 1,
    clearTimeout: () => {},
  }), errorReason('keychain'));
});

test('v10 prefix、crypto/padding、UTF-8、JSON失敗を分類する', () => {
  const value = fixture();
  const wrongPrefix = Buffer.concat([Buffer.from('v11'), Buffer.alloc(16)]).toString('base64');
  assert.throws(() => decryptSafeStorageV10(wrongPrefix, value.password), errorReason('decrypt'));
  assert.throws(() => decryptSafeStorageV10(value.encrypted, secret('wrong-password')), errorReason('decrypt'));
  const invalidJson = encrypt(secret('not-json'), value.password);
  assert.throws(() => decryptSafeStorageV10(invalidJson, value.password), errorReason('decrypt'));
});

test('独立したsynthetic V10 golden vectorを復号する', () => {
  const keyMaterial = 'public-v10-test-material';
  const encrypted = 'djEwgdKx4uh28kbFCyH/nPFvQ2ahCJLUHtjcjOH2qRMxzKCOOLDWO5VuJlZHQsbGXbK+';
  assert.deepEqual(decryptSafeStorageV10(encrypted, keyMaterial), { kind: 'synthetic-v10', value: 42 });
});

test('decrypted connectionは必須field・未知field・vncProxyを厳格に扱う', () => {
  const value = fixture();
  for (const connection of [
    {},
    { baseUrl: value.baseUrl },
    { baseUrl: value.baseUrl, token: '' },
    { baseUrl: value.baseUrl, token: value.token, extra: true },
    { baseUrl: value.baseUrl, token: value.token, vncProxy: 'invalid' },
  ]) {
    const reason = Object.keys(connection).length === 0 || connection.token === '' || !('token' in connection) ? 'incomplete' : 'invalid';
    assert.throws(() => validateAppSessionConnection(connection), errorReason(reason));
  }
  assert.equal(validateAppSessionConnection({ baseUrl: value.baseUrl, token: value.token, vncProxy: null }).baseUrl, value.baseUrl);
  assert.equal(validateAppSessionConnection({ baseUrl: `${value.baseUrl}/`, token: value.token, vncProxy: {} }).baseUrl, value.baseUrl);
});

test('app session URLはHTTPS rootのみを受理する', () => {
  const value = fixture();
  const host = new URL(value.baseUrl).hostname;
  const username = secret('user');
  const password = secret('url-password');
  for (const baseUrl of [
    `http://${host}`,
    `https://${username}:${password}@${host}`,
    `https://${host}/path`,
    `https://${host}?query=1`,
    `https://${host}#fragment`,
    'not-a-url',
  ]) {
    assert.throws(() => validateAppSessionConnection({ baseUrl, token: value.token }), errorReason('invalid'));
  }
});

test('routing headersはcase-insensitiveで1種類のみ受理しduplicateを拒否する', () => {
  const value = fixture();
  for (const headers of [
    [],
    { Authorization: value.routing },
    { Cookie: value.routing },
    { 'x-other': value.routing },
    { 'x-anyrun-network-token': '' },
    { 'x-anyrun-network-token': 1 },
    { 'x-anyrun-network-token': value.routing, 'X-AnyRun-Network-Token': value.routing },
  ]) {
    assert.throws(() => validateAppSessionConnection({ baseUrl: value.baseUrl, token: value.token, headers }), errorReason('invalid'));
  }
  assert.deepEqual(
    validateAppSessionConnection({ baseUrl: value.baseUrl, token: value.token, headers: { 'X-ANYRUN-NETWORK-TOKEN': value.routing } }).headers,
    { 'x-anyrun-network-token': value.routing },
  );
});

test('runtime秘密値はloader内部errorへ漏れない', async () => {
  const value = fixture();
  const rawEncrypted = value.encrypted;
  await assert.rejects(() => loadWith(value, { execFile: async () => ({ stdout: Buffer.from(`${secret('wrong')}\n`), stderr: Buffer.from(value.token) }) }), (error) => {
    const text = `${error.message} ${error.stack}`;
    for (const hidden of [value.password, value.token, value.routing, value.baseUrl, rawEncrypted]) {
      assert.doesNotMatch(text, new RegExp(hidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    return true;
  });
});
