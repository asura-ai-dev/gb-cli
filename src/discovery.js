import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigError, redactText } from './errors.js';
import { appSessionError, isStrictAppVersion, loadAppSession } from './app-session.js';

const execFile = promisify(execFileCallback);
const DESCRIPTOR_FIELDS = new Set(['port', 'pid', 'startedAt', 'scheme', 'host', 'token']);

export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function validateGatewayUrl(raw, allowRemote) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('gateway URL が不正です');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigError('gateway URL は認証情報・query・fragmentを含まない http(s) URL にしてください');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new ConfigError('gateway URL にpathは指定できません');
  }
  if (!isLoopbackHost(url.hostname)) {
    if (!allowRemote) throw new ConfigError('remote gateway には --allow-remote が必要です');
    if (url.protocol !== 'https:') throw new ConfigError('remote gateway にはHTTPSが必要です');
  }
  url.pathname = '';
  return url.origin;
}

export function validateDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('objectではありません');
  for (const key of Object.keys(value)) {
    if (!DESCRIPTOR_FIELDS.has(key)) throw new Error('未知のfieldがあります');
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('portが不正です');
  if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error('pidが不正です');
  if (typeof value.startedAt !== 'string' || value.startedAt.length === 0 || Number.isNaN(Date.parse(value.startedAt))) {
    throw new Error('startedAtが不正です');
  }
  if (value.scheme !== undefined && !['http', 'https'].includes(value.scheme)) throw new Error('schemeが不正です');
  if (value.host !== undefined && (typeof value.host !== 'string' || value.host.length === 0)) throw new Error('hostが不正です');
  if (value.token !== undefined && (typeof value.token !== 'string' || value.token.length === 0)) throw new Error('tokenが不正です');
  return { ...value };
}

export function candidateRoots({ dataRoot, env = process.env, homedir = os.homedir() }) {
  if (dataRoot) return [{ root: path.resolve(dataRoot), source: 'option' }];
  const roots = [];
  if (env.SAND_DATA_ROOT && path.isAbsolute(env.SAND_DATA_ROOT)) roots.push({ root: env.SAND_DATA_ROOT, source: 'SAND_DATA_ROOT' });
  if (env.SAND_USER_DATA_DIR) roots.push({ root: path.join(env.SAND_USER_DATA_DIR, 'sand-data'), source: 'SAND_USER_DATA_DIR' });
  roots.push(
    { root: path.join(homedir, '.grokbot'), source: 'stable' },
    { root: path.join(homedir, '.cursor', 'sand-lab'), source: 'lab' },
    { root: path.join(homedir, '.cursor', 'sand-dev'), source: 'dev' },
  );
  return roots;
}

async function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function isHostMainCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  const tokenize = (value) => (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((argument) => (
    argument.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted)
  ));
  const isScriptAt = (argv, index) => {
    const first = argv[index];
    if (!first) return false;
    if (path.posix.basename(first) === 'host-main.cjs') return true;
    if (!first.startsWith('/')) return false;
    for (let end = index + 1; end < argv.length; end += 1) {
      if (argv[end].startsWith('-') || argv[end].startsWith('/')) return false;
      if (path.posix.basename(argv.slice(index, end + 1).join(' ')) === 'host-main.cjs') return true;
    }
    return false;
  };

  const argv = tokenize(command);
  if (isScriptAt(argv, 0)) return true;
  const launcher = path.posix.basename(argv[0] ?? '');
  if (/^(?:node|nodejs|electron|Grok Bot Helper(?: \([^)]+\))?)$/.test(launcher)) return isScriptAt(argv, 1);

  const unquotedHelper = command.match(/^\/Applications\/Grok Bot\.app\/.+?\/Grok Bot Helper(?: \([^)]+\))?\s+(.+)$/);
  return unquotedHelper ? isScriptAt(tokenize(unquotedHelper[1]), 0) : false;
}

async function defaultIsHostMain(pid) {
  if (process.platform !== 'darwin') return true;
  try {
    const { stdout } = await execFile('/bin/ps', ['-p', String(pid), '-o', 'command=']);
    return isHostMainCommand(stdout.trim());
  } catch {
    return false;
  }
}

async function healthCheck(baseUrl, { fetchImpl, timeoutMs, token, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/health`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const value = await response.json();
    return value && typeof value === 'object' && value.ok === true ? value : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverGateway(options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  const secrets = [];
  if (options.appSession) {
    const connection = await (dependencies.loadAppSession ?? loadAppSession)({
      platform: dependencies.platform,
      homedir: dependencies.homedir,
      readFile: dependencies.readFile,
      lstat: dependencies.lstat,
      realpath: dependencies.realpath,
      open: dependencies.open,
      plutilSpawn: dependencies.plutilSpawn,
      execFile: dependencies.execFile,
      loadAppVersion: dependencies.loadAppVersion,
      now: dependencies.now,
      setTimeout: dependencies.setTimeout,
      clearTimeout: dependencies.clearTimeout,
    });
    if (connection.compatibilitySource !== 'app-bundle' || !isStrictAppVersion(connection.appVersion)) {
      throw appSessionError('app-version-invalid');
    }
    const health = await healthCheck(connection.baseUrl, {
      fetchImpl,
      timeoutMs,
      token: connection.token,
      headers: connection.headers,
    });
    if (!health) throw appSessionError('unreachable');
    return {
      ...connection,
      health,
      source: 'app-session',
      descriptor: false,
      remote: true,
    };
  }
  if (options.gatewayUrl || env.GB_GATEWAY_URL) {
    const baseUrl = validateGatewayUrl(options.gatewayUrl || env.GB_GATEWAY_URL, options.allowRemote);
    const token = env.GB_GATEWAY_TOKEN || undefined;
    if (token) secrets.push(token);
    const health = await healthCheck(baseUrl, { fetchImpl, timeoutMs });
    if (!health) throw new ConfigError('明示された gateway の health 確認に失敗しました');
    return { baseUrl, token, health, source: 'explicit', descriptor: false, secrets };
  }

  const roots = candidateRoots({ dataRoot: options.dataRoot, env, homedir: dependencies.homedir?.() ?? os.homedir() });
  const readFile = dependencies.readFile ?? fs.readFile;
  const pidAlive = dependencies.pidAlive ?? defaultPidAlive;
  const isHostMain = dependencies.isHostMain ?? defaultIsHostMain;
  for (const candidate of roots) {
    let parsed;
    try {
      parsed = validateDescriptor(JSON.parse(await readFile(path.join(candidate.root, 'gateway.json'), 'utf8')));
    } catch {
      continue;
    }
    if (parsed.token) secrets.push(parsed.token);
    if (!(await pidAlive(parsed.pid)) || !(await isHostMain(parsed.pid))) continue;
    let baseUrl;
    try {
      const scheme = parsed.scheme ?? 'http';
      const host = parsed.host ?? '127.0.0.1';
      baseUrl = validateGatewayUrl(`${scheme}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${parsed.port}`, options.allowRemote);
    } catch {
      continue;
    }
    const health = await healthCheck(baseUrl, { fetchImpl, timeoutMs });
    if (!health) continue;
    if (!Number.isInteger(health.pid) || health.pid < 1 || health.pid !== parsed.pid) continue;
    if (typeof health.startedAt !== 'string' || health.startedAt.length === 0 || health.startedAt !== parsed.startedAt) continue;
    return { baseUrl, token: parsed.token, health, source: candidate.source, descriptor: true, secrets: parsed.token ? [parsed.token] : [] };
  }
  throw new ConfigError(redactText('利用可能な Grok Bot gateway が見つかりません', secrets));
}
