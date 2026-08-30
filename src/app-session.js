import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { promisify } from 'node:util';
import { ConfigError } from './errors.js';

const execFile = promisify(execFileCallback);
const KEYCHAIN_SERVICE = 'Grok Bot Safe Storage';
const SECURITY_PATH = '/usr/bin/security';
const SECURITY_TIMEOUT_MS = 3_000;
const AUTHORIZE_TIMEOUT_MS = 60_000;
const AUTHORIZE_TERM_GRACE_MS = 250;
const AUTHORIZE_KILL_GRACE_MS = 250;
const SECURITY_MAX_BUFFER = 64 * 1024;
const PLUTIL_PATH = '/usr/bin/plutil';
const PLUTIL_TIMEOUT_MS = 1_500;
const PLUTIL_MAX_BUFFER = 4 * 1024;
const PLIST_MAX_BYTES = 256 * 1024;
const PLUTIL_KILL_GRACE_MS = 250;
const APP_BUNDLE_IDENTIFIER = 'com.anysphere.sand';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const WRAPPER_FIELDS = new Set(['version', 'entries']);
const ENTRY_FIELDS = new Set(['savedAtMs', 'encrypted']);
const CONNECTION_FIELDS = new Set(['baseUrl', 'token', 'headers', 'vncProxy']);
const ROUTING_HEADER = 'x-anyrun-network-token';

const APP_SESSION_ERRORS = {
  platform: ['app sessionはmacOSでのみ利用できます', 'macOSで実行してください'],
  missing: ['app session descriptorを読み込めませんでした', 'Grok Botを起動して再試行してください'],
  invalid: ['app session descriptorが不正です', 'Grok Botでsessionを再作成してください'],
  multiple: ['app session descriptorに複数entryがあります', 'Grok Botでaccount状態を整理してください'],
  stale: ['app session descriptorの有効期限が切れています', 'Grok Botでsessionを更新してください'],
  keychain: ['app sessionの認証情報を取得できませんでした', 'Keychainアクセスを確認してください'],
  'keychain-timeout': ['app sessionのKeychain確認がtimeoutしました', '対話Terminalで gb app-session authorize --yes を実行してください'],
  'authorize-timeout': ['app sessionのKeychain承認がtimeoutしました', '処理を停止し、必要ならKeychainとGrok Botの状態を確認してください'],
  'app-version-missing': ['Grok Bot appのversionを確認できませんでした', '通常版Grok Botのinstall状態を確認してください'],
  'app-version-invalid': ['Grok Bot appのversion情報が不正です', '通常版Grok Botを正規の場所へ再installしてください'],
  'app-version-ambiguous': ['Grok Bot appが複数見つかりました', 'systemまたはuser Applicationsの一方だけにしてください'],
  decrypt: ['app sessionの復号に失敗しました', 'Grok Botでsessionを再作成してください'],
  incomplete: ['app sessionの接続情報が不足しています', 'Grok Botでsessionを再作成してください'],
  unreachable: ['app session gatewayのhealth確認に失敗しました', 'Grok Botの接続状態を確認してください'],
};

export function appSessionError(reason) {
  const normalizedReason = Object.hasOwn(APP_SESSION_ERRORS, reason) ? reason : 'invalid';
  const [message, hint] = APP_SESSION_ERRORS[normalizedReason];
  const error = new ConfigError(message);
  error.code = `APP_SESSION_${normalizedReason.toUpperCase()}`;
  error.reason = normalizedReason;
  error.hint = hint;
  error.appSession = true;
  return error;
}

export function isStrictAppVersion(value) {
  return typeof value === 'string'
    && value.length <= 64
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
}

function decodePlutilValue(stdout) {
  if (!Buffer.isBuffer(stdout) || stdout.length === 0) throw appSessionError('app-version-invalid');
  let end = stdout.length;
  if (stdout[end - 1] === 0x0a) end -= 1;
  if (end > 0 && stdout[end - 1] === 0x0d) end -= 1;
  if (end === 0) throw appSessionError('app-version-invalid');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(stdout.subarray(0, end));
  } catch {
    throw appSessionError('app-version-invalid');
  }
}

function runPlutilField(snapshot, field, dependencies) {
  const spawnImpl = dependencies.plutilSpawn ?? spawnChild;
  const setTimeoutImpl = dependencies.setTimeout ?? setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeout ?? clearTimeout;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(
        PLUTIL_PATH,
        ['-extract', field, 'raw', '-o', '-', '-'],
        { stdio: ['pipe', 'pipe', 'pipe'], shell: false },
      );
    } catch (error) {
      zeroChildBuffers(error);
      reject(appSessionError('app-version-invalid'));
      return;
    }

    const input = Buffer.from(snapshot);
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let outcome = null;
    let timeoutTimer;
    let killTimer;
    const stop = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 終了済みchildへのbest-effort停止。
      }
    };
    const cleanup = (forced) => {
      clearTimeoutImpl(timeoutTimer);
      clearTimeoutImpl(killTimer);
      input.fill(0);
      for (const chunk of stdoutChunks) chunk.fill(0);
      child.stdout?.removeListener?.('data', onStdout);
      child.stderr?.removeListener?.('data', onStderr);
      if (forced) {
        child.stdin?.destroy?.();
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        child.unref?.();
      }
    };
    const settle = (error, value, forced = false) => {
      if (settled) return;
      settled = true;
      cleanup(forced);
      if (error) reject(appSessionError('app-version-invalid'));
      else resolve(value);
    };
    const terminate = () => {
      if (outcome || settled) return;
      outcome = appSessionError('app-version-invalid');
      clearTimeoutImpl(timeoutTimer);
      stop();
      if (!settled) killTimer = setTimeoutImpl(() => settle(outcome, undefined, true), PLUTIL_KILL_GRACE_MS);
    };
    const onStdout = (chunk) => {
      const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const copy = Buffer.from(source);
      source.fill(0);
      stdoutBytes += copy.length;
      if (stdoutBytes > PLUTIL_MAX_BUFFER) {
        copy.fill(0);
        terminate();
      } else {
        stdoutChunks.push(copy);
      }
    };
    const onStderr = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      buffer.fill(0);
      if (stderrBytes > PLUTIL_MAX_BUFFER) terminate();
    };

    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      stop();
      settle(appSessionError('app-version-invalid'), undefined, true);
      return;
    }
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', (error) => {
      zeroChildBuffers(error);
      settle(outcome ?? appSessionError('app-version-invalid'), undefined, true);
    });
    child.stdin.once?.('error', terminate);
    child.once('close', (code) => {
      if (outcome || code !== 0) {
        settle(outcome ?? appSessionError('app-version-invalid'));
        return;
      }
      let output;
      try {
        output = Buffer.concat(stdoutChunks, stdoutBytes);
        settle(null, decodePlutilValue(output));
      } catch {
        settle(appSessionError('app-version-invalid'));
      } finally {
        output?.fill(0);
      }
    });
    timeoutTimer = setTimeoutImpl(terminate, PLUTIL_TIMEOUT_MS);
    try {
      child.stdin.end(input, () => input.fill(0));
    } catch {
      terminate();
    }
  });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function stableSnapshotStats(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStablePlistSnapshot(plistPath, initialPathStat, dependencies) {
  const open = dependencies.open ?? fs.open;
  const lstat = dependencies.lstat ?? fs.lstat;
  const realpath = dependencies.realpath ?? fs.realpath;
  let handle;
  let snapshot;
  try {
    handle = await open(plistPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const beforeFdStat = await handle.stat();
    const beforePathStat = await lstat(plistPath);
    const beforeRealpath = await realpath(plistPath);
    if (!beforeFdStat.isFile() || !beforePathStat.isFile()
      || beforeRealpath !== plistPath
      || !stableSnapshotStats(initialPathStat, beforeFdStat)
      || !sameIdentity(beforePathStat, beforeFdStat)
      || !Number.isSafeInteger(beforeFdStat.size) || beforeFdStat.size < 1 || beforeFdStat.size > PLIST_MAX_BYTES) {
      throw appSessionError('app-version-invalid');
    }

    snapshot = Buffer.alloc(beforeFdStat.size);
    const { bytesRead } = await handle.read(snapshot, 0, snapshot.length, 0);
    const afterFdStat = await handle.stat();
    const afterPathStat = await lstat(plistPath);
    const afterRealpath = await realpath(plistPath);
    if (bytesRead !== snapshot.length
      || afterRealpath !== plistPath
      || !afterPathStat.isFile()
      || !sameIdentity(afterPathStat, afterFdStat)
      || !stableSnapshotStats(beforeFdStat, afterFdStat)) {
      throw appSessionError('app-version-invalid');
    }
    return snapshot;
  } catch {
    snapshot?.fill(0);
    throw appSessionError('app-version-invalid');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function inspectAppBundle({ bundlePath, plistPath }, dependencies) {
  const lstat = dependencies.lstat ?? fs.lstat;
  const realpath = dependencies.realpath ?? fs.realpath;
  let bundleStat;
  try {
    bundleStat = await lstat(bundlePath);
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) return { state: 'invalid' };

  let plistStat;
  try {
    plistStat = await lstat(plistPath);
  } catch {
    return { state: 'invalid' };
  }
  if (plistStat.isSymbolicLink() || !plistStat.isFile()) return { state: 'invalid' };

  try {
    const [resolvedBundle, resolvedPlist] = await Promise.all([realpath(bundlePath), realpath(plistPath)]);
    if (resolvedBundle !== bundlePath || resolvedPlist !== plistPath || !resolvedPlist.startsWith(`${resolvedBundle}${path.sep}`)) {
      return { state: 'invalid' };
    }
  } catch {
    return { state: 'invalid' };
  }

  try {
    const snapshot = await readStablePlistSnapshot(plistPath, plistStat, dependencies);
    try {
      const identifier = await runPlutilField(snapshot, 'CFBundleIdentifier', dependencies);
      const appVersion = await runPlutilField(snapshot, 'CFBundleShortVersionString', dependencies);
      if (identifier !== APP_BUNDLE_IDENTIFIER || !isStrictAppVersion(appVersion)) return { state: 'invalid' };
      return { state: 'valid', appVersion };
    } finally {
      snapshot.fill(0);
    }
  } catch {
    return { state: 'invalid' };
  }
}

export async function loadDesktopAppVersion(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin') throw appSessionError('platform');
  const home = dependencies.homedir?.() ?? os.homedir();
  const bundlePaths = [
    '/Applications/Grok Bot.app',
    path.join(home, 'Applications', 'Grok Bot.app'),
  ];
  const candidates = [...new Set(bundlePaths)].map((bundlePath) => ({
    bundlePath,
    plistPath: path.join(bundlePath, 'Contents', 'Info.plist'),
  }));
  const inspected = [];
  for (const candidate of candidates) inspected.push(await inspectAppBundle(candidate, dependencies));
  const valid = inspected.filter((item) => item.state === 'valid');
  if (valid.length > 1) throw appSessionError('app-version-ambiguous');
  if (valid.length === 1) return { appVersion: valid[0].appVersion, compatibilitySource: 'app-bundle' };
  if (inspected.some((item) => item.state === 'invalid')) throw appSessionError('app-version-invalid');
  throw appSessionError('app-version-missing');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyFields(value, fields) {
  return Object.keys(value).every((key) => fields.has(key));
}

function decodeEncrypted(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw appSessionError('invalid');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw appSessionError('invalid');
  }
  const encrypted = Buffer.from(value, 'base64');
  if (encrypted.toString('base64') !== value) {
    throw appSessionError('invalid');
  }
  return encrypted;
}

export function decryptSafeStorageV10(encryptedValue, password) {
  const encrypted = decodeEncrypted(encryptedValue);
  if (encrypted.length <= 3 || encrypted.subarray(0, 3).toString('ascii') !== 'v10') {
    throw appSessionError('decrypt');
  }
  if ((!Buffer.isBuffer(password) && typeof password !== 'string') || password.length === 0) {
    throw appSessionError('keychain');
  }

  let key;
  let plaintext;
  try {
    key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    throw appSessionError('decrypt');
  } finally {
    key?.fill(0);
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    return JSON.parse(text);
  } catch {
    throw appSessionError('decrypt');
  } finally {
    plaintext?.fill(0);
    encrypted.fill(0);
  }
}

export function validateAppSessionConnection(value) {
  if (!isPlainObject(value) || !hasOnlyFields(value, CONNECTION_FIELDS)) {
    throw appSessionError('invalid');
  }
  if (typeof value.baseUrl !== 'string' || value.baseUrl.length === 0 || typeof value.token !== 'string' || value.token.length === 0) {
    throw appSessionError('incomplete');
  }
  if (value.vncProxy !== undefined && value.vncProxy !== null && !isPlainObject(value.vncProxy)) {
    throw appSessionError('invalid');
  }

  let url;
  try {
    url = new URL(value.baseUrl);
  } catch {
    throw appSessionError('invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    throw appSessionError('invalid');
  }

  const headers = {};
  if (value.headers !== undefined) {
    if (!isPlainObject(value.headers)) {
      throw appSessionError('invalid');
    }
    const seen = new Set();
    for (const [name, headerValue] of Object.entries(value.headers)) {
      const normalized = name.toLowerCase();
      if (seen.has(normalized) || normalized !== ROUTING_HEADER || typeof headerValue !== 'string' || headerValue.length === 0) {
        throw appSessionError('invalid');
      }
      seen.add(normalized);
      headers[ROUTING_HEADER] = headerValue;
    }
  }

  return {
    baseUrl: url.origin,
    token: value.token,
    headers: Object.freeze(headers),
    secrets: [value.token, ...Object.values(headers), url.origin, url.hostname],
  };
}

function validateWrapper(value, nowMs) {
  if (!isPlainObject(value) || !hasOnlyFields(value, WRAPPER_FIELDS) || value.version !== 2 || !isPlainObject(value.entries)) {
    throw appSessionError('invalid');
  }
  const entries = Object.values(value.entries);
  if (entries.length > 1) throw appSessionError('multiple');
  if (entries.length !== 1) throw appSessionError('invalid');
  const entry = entries[0];
  if (!isPlainObject(entry) || !hasOnlyFields(entry, ENTRY_FIELDS)) {
    throw appSessionError('invalid');
  }
  if (!Number.isFinite(entry.savedAtMs)) {
    throw appSessionError('invalid');
  }
  const encrypted = decodeEncrypted(entry.encrypted);
  encrypted.fill(0);
  if (!Number.isFinite(nowMs)) throw appSessionError('invalid');
  if (entry.savedAtMs < nowMs - SESSION_TTL_MS || entry.savedAtMs > nowMs + CLOCK_SKEW_MS) {
    throw appSessionError('stale');
  }
  return entry;
}

function zeroChildBuffers(value) {
  if (Buffer.isBuffer(value?.stdout)) value.stdout.fill(0);
  if (Buffer.isBuffer(value?.stderr)) value.stderr.fill(0);
}

async function runSecurityCommand({
  execFileImpl,
  timeoutMs,
  signal,
  timeoutReason = 'keychain-timeout',
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });

  let timedOut = false;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeoutImpl(() => {
      timedOut = true;
      controller.abort();
      reject(appSessionError(timeoutReason));
    }, timeoutMs);
  });
  const operation = Promise.resolve().then(() => execFileImpl(
    SECURITY_PATH,
    ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE],
    {
      encoding: 'buffer',
      timeout: timeoutMs,
      maxBuffer: SECURITY_MAX_BUFFER,
      shell: false,
      signal: controller.signal,
    },
  ));

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    zeroChildBuffers(error);
    if (timedOut) throw appSessionError(timeoutReason);
    throw error?.appSession === true ? error : appSessionError('keychain');
  } finally {
    clearTimeoutImpl(timer);
    signal?.removeEventListener('abort', abortFromCaller);
    if (timedOut) operation.then(zeroChildBuffers, zeroChildBuffers);
  }
}

async function readKeychainPassword(execFileImpl, dependencies = {}) {
  const result = await runSecurityCommand({
    execFileImpl,
    timeoutMs: SECURITY_TIMEOUT_MS,
    setTimeoutImpl: dependencies.setTimeout,
    clearTimeoutImpl: dependencies.clearTimeout,
  });
  const stdout = Buffer.isBuffer(result?.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result?.stderr) ? result.stderr : null;
  try {
    let end = stdout.length;
    if (end > 0 && stdout[end - 1] === 0x0a) end -= 1;
    if (end > 0 && stdout[end - 1] === 0x0d) end -= 1;
    if (end === 0) throw appSessionError('keychain');
    return Buffer.from(stdout.subarray(0, end));
  } finally {
    stdout.fill(0);
    stderr?.fill(0);
  }
}

function runAuthorizeSecurity({
  spawnImpl,
  stdin,
  stderr,
  signal,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  if (signal?.aborted) return Promise.reject(appSessionError('keychain'));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(
        SECURITY_PATH,
        ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE],
        { stdio: [stdin, 'pipe', stderr], shell: false },
      );
    } catch {
      reject(appSessionError('keychain'));
      return;
    }

    let settled = false;
    let outcome = null;
    let stdoutBytes = 0;
    let timeoutTimer;
    let termTimer;
    let killTimer;
    const stop = (killSignal) => {
      try {
        child.kill(killSignal);
      } catch {
        // 終了済みchildへのbest-effort停止。
      }
    };
    const settle = (error, forced = false) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timeoutTimer);
      clearTimeoutImpl(termTimer);
      clearTimeoutImpl(killTimer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener?.('data', onStdout);
      if (forced) {
        child.stdout?.destroy?.();
        child.unref?.();
      }
      if (error) reject(error);
      else resolve();
    };
    const waitAfterKill = () => {
      if (settled) return;
      stop('SIGKILL');
      if (settled) return;
      killTimer = setTimeoutImpl(() => settle(outcome ?? appSessionError('keychain'), true), AUTHORIZE_KILL_GRACE_MS);
    };
    const terminate = (error, firstSignal) => {
      if (outcome || settled) return;
      outcome = error;
      clearTimeoutImpl(timeoutTimer);
      stop(firstSignal);
      if (settled) return;
      if (firstSignal === 'SIGTERM') {
        termTimer = setTimeoutImpl(waitAfterKill, AUTHORIZE_TERM_GRACE_MS);
      } else {
        killTimer = setTimeoutImpl(() => settle(outcome, true), AUTHORIZE_KILL_GRACE_MS);
      }
    };
    const onAbort = () => {
      terminate(appSessionError('keychain'), 'SIGTERM');
    };
    const onStdout = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      buffer.fill(0);
      if (stdoutBytes > SECURITY_MAX_BUFFER) {
        terminate(appSessionError('keychain'), 'SIGKILL');
      }
    };

    if (!child?.stdout || typeof child.stdout.on !== 'function') {
      stop('SIGKILL');
      settle(appSessionError('keychain'), true);
      return;
    }
    child.stdout.on('data', onStdout);
    child.once('error', (error) => {
      zeroChildBuffers(error);
      settle(outcome ?? appSessionError('keychain'), true);
    });
    child.once('close', (code) => {
      settle(outcome ?? (code === 0 ? null : appSessionError('keychain')));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    timeoutTimer = setTimeoutImpl(() => {
      terminate(appSessionError('authorize-timeout'), 'SIGKILL');
    }, AUTHORIZE_TIMEOUT_MS);
  });
}

export async function authorizeAppSession(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin') throw appSessionError('platform');
  await runAuthorizeSecurity({
    spawnImpl: dependencies.spawn ?? spawnChild,
    stdin: dependencies.stdin ?? process.stdin,
    stderr: dependencies.stderr ?? process.stderr,
    signal: dependencies.signal,
    setTimeoutImpl: dependencies.setTimeout,
    clearTimeoutImpl: dependencies.clearTimeout,
  });
}

export async function loadAppSession(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw appSessionError('platform');
  }
  const home = dependencies.homedir?.() ?? os.homedir();
  const appMetadata = await (dependencies.loadAppVersion ?? loadDesktopAppVersion)({
    platform,
    homedir: () => home,
    lstat: dependencies.lstat,
    realpath: dependencies.realpath,
    open: dependencies.open,
    plutilSpawn: dependencies.plutilSpawn,
    setTimeout: dependencies.setTimeout,
    clearTimeout: dependencies.clearTimeout,
  });
  const descriptorPath = path.join(home, 'Library', 'Application Support', 'Grok Bot', 'gateway-descriptor.json');
  const readFile = dependencies.readFile ?? fs.readFile;
  let rawDescriptor;
  try {
    rawDescriptor = await readFile(descriptorPath, 'utf8');
  } catch {
    throw appSessionError('missing');
  }
  let wrapper;
  try {
    wrapper = JSON.parse(rawDescriptor);
  } catch {
    throw appSessionError('invalid');
  }
  const now = typeof dependencies.now === 'function' ? dependencies.now() : (dependencies.now ?? Date.now());
  const entry = validateWrapper(wrapper, now);
  const password = await readKeychainPassword(dependencies.execFile ?? execFile, {
    setTimeout: dependencies.setTimeout,
    clearTimeout: dependencies.clearTimeout,
  });
  try {
    const decrypted = decryptSafeStorageV10(entry.encrypted, password);
    return { ...validateAppSessionConnection(decrypted), ...appMetadata };
  } finally {
    password.fill(0);
  }
}
