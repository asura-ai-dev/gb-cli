import { randomUUID } from 'node:crypto';
import { discoverGateway, isLoopbackHost } from './discovery.js';
import { GatewayClient } from './http.js';
import { CapabilityError, ConfigError, GbError, TransportError, UsageError, redactText } from './errors.js';
import { escapeJsonTerminalControls, escapeTerminalControls, sanitizeHealth } from './sanitize.js';
import { filterTranscriptEvent, subscribeEvents } from './sse.js';
import { appSessionError, authorizeAppSession, isStrictAppVersion } from './app-session.js';

const SUPPORTED_HOST_VERSION = '0.24.0';
const LEGACY_APP_VERSION = '0.24.0';
const APP_PROFILES = Object.freeze({
  '0.24.0': Object.freeze({
    id: 'app-session-v0.24',
    appVersion: '0.24.0',
    capabilities: Object.freeze({
      gatewayRead: true,
      agentDiscovery: true,
      agentCreate: true,
      agentOperations: 'gateway-direct',
      dedicatedTemporalBackend: false,
      exactAgentResolutionRequired: false,
    }),
  }),
  '0.30.0': Object.freeze({
    id: 'app-session-v0.30-gateway-direct',
    appVersion: '0.30.0',
    capabilities: Object.freeze({
      gatewayRead: true,
      agentDiscovery: true,
      agentCreate: false,
      agentOperations: 'gateway-direct',
      dedicatedTemporalBackend: false,
      exactAgentResolutionRequired: true,
    }),
  }),
});
const SUPPORTED_APP_VERSIONS = Object.freeze(Object.keys(APP_PROFILES));

const CAPABILITY_ERRORS = Object.freeze({
  'agent-not-found': Object.freeze({
    message: '対象agentを一覧で完全一致確認できませんでした',
    hint: '同じ接続方式でagents listまたはagents searchを実行して対象を確認してください',
  }),
  'agent-selection-ambiguous': Object.freeze({
    message: '対象agentを一意に確認できないため操作を拒否しました',
    hint: '同じ接続方式でagents listを実行して対象を確認してください',
  }),
  'temporal-create-unsupported': Object.freeze({
    message: 'Grok Bot v0.30.0ではgb-cliからagentを作成できません',
    hint: '作成時にTemporal harnessが選ばれ得るためgateway APIを呼び出しません',
  }),
});

const HELP = `gb - Grok Bot gateway CLI (desktop v0.24.0 / v0.30.0 gateway-direct profile)

Usage:
  gb app-session authorize --yes
  gb [global options] doctor [--json]
  gb [global options] status [--json]
  gb [global options] agents list [--json]
  gb [global options] agents search --query Q [--limit N] [--json]
  gb [global options] agents create --name N --description D [--json]
  gb [global options] transcript tail --agent ID [--limit N] [--before-seq N] [--json]
  gb [global options] send --agent ID (--prompt TEXT | --stdin) [--json]
  gb [global options] watch --agent ID [--timeout SEC]
  gb [global options] chat --agent ID (--prompt TEXT | --stdin) [--timeout SEC]
  gb [global options] interrupt --agent ID --yes [--json]

Global options:
  --app-session           macOSのapp sessionで接続 (--allow-remote必須)
  --data-root PATH         gateway.json を探すdata rootを固定
  --gateway-url URL        descriptorを使わずgatewayを指定
  --allow-remote           loopback以外への接続を許可
  --allow-unsupported      非対応desktop app/hostへの書き込みを明示許可
  --request-timeout SEC    HTTP request timeout (default: 10)
  --help                   helpを表示
  --version                gbのversionを表示

app-session authorizeはmacOSの対話Terminalでユーザー本人が実行します。stdinをchildへ継承し、OS GUIまたはstderrの確認promptを表示しますが、secret stdoutは表示しません。shell redirectionでは実行しないでください。
app-sessionの互換性は固定app bundleのdesktop versionで判定し、remote hostVersionは判定・出力に使いません。
desktop v0.30.0ではagent IDを完全一致・一意確認し、harnessに依存せずgatewayへ直接routeします。専用Temporal backendとagent作成は対象外です。
TokenのCLI引数はありません。promptはshell履歴を避けるため --stdin を推奨します。
chatは状態変更操作です。watch/chatの終了はremote runの停止・完了を意味しません。`;

function takeGlobal(argv) {
  const rest = [];
  const options = { requestTimeoutMs: 10_000, allowRemote: false, allowUnsupported: false, appSession: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--allow-remote') options.allowRemote = true;
    else if (value === '--app-session') options.appSession = true;
    else if (value === '--allow-unsupported') options.allowUnsupported = true;
    else if (['--data-root', '--gateway-url', '--request-timeout'].includes(value)) {
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new UsageError(`${value} には値が必要です`);
      if (value === '--data-root') options.dataRoot = next;
      if (value === '--gateway-url') options.gatewayUrl = next;
      if (value === '--request-timeout') options.requestTimeoutMs = seconds(next, value) * 1000;
    } else if (value === '--help') options.help = true;
    else if (value === '--version') options.version = true;
    else rest.push(value);
  }
  return { options, rest };
}

function seconds(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new UsageError(`${name} は正の数にしてください`);
  return result;
}

function positiveInteger(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new UsageError(`${name} は正の整数にしてください`);
  return result;
}

function parseOptions(argv, specification = {}) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    if (!(value in specification)) throw new UsageError('未知のoptionがあります');
    const name = specification[value];
    if (name === true) result[value.slice(2).replaceAll('-', '_')] = true;
    else {
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${value} には値が必要です`);
      result[name] = next;
    }
  }
  return result;
}

async function readPrompt(options, stdin) {
  const hasPrompt = options.prompt !== undefined;
  const hasStdin = options.stdin === true;
  if (hasPrompt === hasStdin) throw new UsageError('--prompt と --stdin のどちらか一方が必要です');
  if (hasPrompt) {
    if (options.prompt.length === 0) throw new UsageError('promptは空にできません');
    return options.prompt;
  }
  let value = '';
  for await (const chunk of stdin) value += chunk;
  if (value.length === 0) throw new UsageError('stdinは空にできません');
  return value;
}

function validatePromptOptions(options) {
  const hasPrompt = options.prompt !== undefined;
  const hasStdin = options.stdin === true;
  if (hasPrompt === hasStdin) throw new UsageError('--prompt と --stdin のどちらか一方が必要です');
  if (hasPrompt && options.prompt.length === 0) throw new UsageError('promptは空にできません');
}

function jsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function stdoutTransportError() {
  const error = new TransportError('stdoutへの書き込みに失敗しました');
  error.stdoutFailure = true;
  return error;
}

export function writeStreamingJsonLine(stream, value, signal) {
  const line = `${JSON.stringify(value)}\n`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onFailure);
      stream.off('close', onFailure);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(result);
    };
    const onDrain = () => finish(resolve, true);
    const onAbort = () => finish(resolve, false);
    const onFailure = () => finish(reject, stdoutTransportError());

    stream.once('drain', onDrain);
    stream.once('error', onFailure);
    stream.once('close', onFailure);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (stream.write(line)) finish(resolve, true);
      else if (signal?.aborted) onAbort();
    } catch {
      onFailure();
    }
  });
}

function printResult(stdout, json, raw, human) {
  if (json) jsonLine(stdout, raw);
  else stdout.write(`${human}\n`);
}

async function hostStatus(client, { mutation, strict = false, allowUnsupported, stderr }) {
  let status;
  try {
    status = await client.api('getHostStatus');
  } catch (error) {
    if (mutation || strict) throw error;
    stderr.write('warning: host versionを確認できませんでした\n');
    return null;
  }
  const version = typeof status?.hostVersion === 'string' ? status.hostVersion : null;
  if (mutation && version === null) {
    throw new ConfigError('host versionを確認できないため書き込みを拒否しました');
  }
  if (version !== SUPPORTED_HOST_VERSION) {
    if (mutation && !allowUnsupported) {
      throw new ConfigError(`host version ${version ?? 'unknown'} への書き込みは未対応です (--allow-unsupported で明示継続)`);
    }
    stderr.write(`warning: host version ${escapeTerminalControls(version ?? 'unknown')} は対象version ${SUPPORTED_HOST_VERSION} と異なります\n`);
  }
  return status;
}

function appProfile(gateway) {
  if (gateway.source !== 'app-session') return null;
  return APP_PROFILES[gateway.appVersion] ?? null;
}

function capabilityError(reason) {
  const detail = CAPABILITY_ERRORS[reason];
  return new CapabilityError(reason, detail.message, detail.hint);
}

function nextClientNonce(context) {
  const value = context.randomUUID();
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('client nonceを生成できないため操作を拒否しました');
  }
  return value;
}

function assertAgentCreateSupported(gateway) {
  const profile = appProfile(gateway);
  if (profile && profile.capabilities.agentCreate === false) {
    throw capabilityError('temporal-create-unsupported');
  }
}

async function assertAgentResolved(context, agentId, { signal } = {}) {
  const profile = appProfile(context.gateway);
  if (!profile?.capabilities.exactAgentResolutionRequired) return;

  const agents = await context.client.api('listAgents', undefined, { signal });
  if (!Array.isArray(agents)) throw capabilityError('agent-not-found');
  const matches = agents.filter((agent) => agent && typeof agent === 'object' && agent.id === agentId);
  if (matches.length === 0) throw capabilityError('agent-not-found');
  if (matches.length !== 1) throw capabilityError('agent-selection-ambiguous');
}

function appSessionCompatibility(gateway, { mutation, allowUnsupported, stderr }) {
  if (gateway.compatibilitySource !== 'app-bundle' || !isStrictAppVersion(gateway.appVersion)) {
    throw appSessionError('app-version-invalid');
  }
  const profile = appProfile(gateway);
  const supported = profile !== null;
  const warning = supported ? null : '観測対象外のGrok Bot desktop app versionです';
  if (warning) {
    if (mutation && !allowUnsupported) {
      throw new ConfigError(`Grok Bot app version ${gateway.appVersion} への書き込みは未対応です (--allow-unsupported で明示継続)`);
    }
    stderr.write(`warning: ${warning}\n`);
  }
  return {
    source: 'app-bundle',
    observedAppVersion: gateway.appVersion,
    expectedAppVersion: profile?.appVersion ?? LEGACY_APP_VERSION,
    supportedAppVersions: [...SUPPORTED_APP_VERSIONS],
    profile: profile?.id ?? null,
    capabilities: profile ? { ...profile.capabilities } : null,
    supported,
    warning,
  };
}

async function gatewayStatus({ gateway, client }, { mutation, strict = false, allowUnsupported, stderr }) {
  if (gateway.source !== 'app-session') {
    return {
      status: await hostStatus(client, { mutation, strict, allowUnsupported, stderr }),
      compatibility: null,
    };
  }
  const compatibility = appSessionCompatibility(gateway, { mutation, allowUnsupported, stderr });
  try {
    return { status: await client.api('getHostStatus'), compatibility };
  } catch (error) {
    if (mutation || strict) throw error;
    stderr.write('warning: host statusを確認できませんでした\n');
    return { status: null, compatibility };
  }
}

function assertNoPositionals(options) {
  if (options._.length) throw new UsageError('予期しない引数があります');
}

function preflight(rest) {
  const command = rest[0];
  const args = rest.slice(1);
  if (command === 'app-session') {
    if (args[0] !== 'authorize') throw new UsageError('commandまたは引数が不正です');
    const options = parseOptions(args.slice(1), { '--yes': true });
    assertNoPositionals(options);
    if (!options.yes) throw new UsageError('app-session authorize には --yes が必要です');
    return { command, subcommand: 'authorize', options };
  }
  if (command === 'doctor' || command === 'status') {
    const options = parseOptions(args, { '--json': true });
    assertNoPositionals(options);
    return { command, options };
  }
  if (command === 'agents') {
    const subcommand = args[0];
    if (!['list', 'search', 'create'].includes(subcommand)) throw new UsageError('commandまたは引数が不正です');
    const specifications = {
      list: { '--json': true },
      search: { '--query': 'query', '--limit': 'limit', '--json': true },
      create: { '--name': 'name', '--description': 'description', '--json': true },
    };
    const options = parseOptions(args.slice(1), specifications[subcommand]);
    assertNoPositionals(options);
    if (subcommand === 'search') {
      if (!options.query) throw new UsageError('--query が必要です');
      options.limit = positiveInteger(options.limit, '--limit', 20);
    }
    if (subcommand === 'create' && (!options.name || options.description === undefined)) {
      throw new UsageError('--name と --description が必要です');
    }
    return { command, subcommand, options };
  }
  if (command === 'transcript') {
    if (args[0] !== 'tail') throw new UsageError('commandまたは引数が不正です');
    const options = parseOptions(args.slice(1), { '--agent': 'agent', '--limit': 'limit', '--before-seq': 'beforeSeq', '--json': true });
    assertNoPositionals(options);
    if (!options.agent) throw new UsageError('--agent が必要です');
    options.limit = positiveInteger(options.limit, '--limit', 50);
    if (options.beforeSeq !== undefined) options.beforeSeq = positiveInteger(options.beforeSeq, '--before-seq');
    return { command, subcommand: 'tail', options };
  }
  if (command === 'send') {
    const options = parseOptions(args, { '--agent': 'agent', '--prompt': 'prompt', '--stdin': true, '--json': true });
    assertNoPositionals(options);
    if (!options.agent) throw new UsageError('--agent が必要です');
    validatePromptOptions(options);
    return { command, options };
  }
  if (command === 'watch' || command === 'chat') {
    const specification = { '--agent': 'agent', '--timeout': 'timeout' };
    if (command === 'chat') Object.assign(specification, { '--prompt': 'prompt', '--stdin': true });
    const options = parseOptions(args, specification);
    assertNoPositionals(options);
    if (!options.agent) throw new UsageError('--agent が必要です');
    if (command === 'chat') validatePromptOptions(options);
    options.timeout = options.timeout === undefined ? undefined : seconds(options.timeout, '--timeout');
    return { command, options };
  }
  if (command === 'interrupt') {
    const options = parseOptions(args, { '--agent': 'agent', '--yes': true, '--json': true });
    assertNoPositionals(options);
    if (!options.agent) throw new UsageError('--agent が必要です');
    if (!options.yes) throw new UsageError('interrupt には --yes が必要です');
    return { command, options };
  }
  throw new UsageError('commandまたは引数が不正です');
}

async function runAppSessionAuthorize({ dependencies, stdin, stdout, stderr, processObj }) {
  if (stdin.isTTY !== true || stdout.isTTY !== true || stderr.isTTY !== true) {
    throw new UsageError('app-session authorize は対話Terminalで実行してください');
  }
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    controller.abort();
  };
  processObj.on('SIGINT', onSigint);
  try {
    await authorizeAppSession({
      platform: dependencies.platform,
      spawn: dependencies.spawn,
      stdin,
      stderr,
      signal: controller.signal,
      setTimeout: dependencies.setTimeout,
      clearTimeout: dependencies.clearTimeout,
    });
    if (interrupted) return 130;
    stdout.write('app sessionのKeychain accessを確認しました\n');
    return 0;
  } catch (error) {
    if (interrupted) {
      stderr.write('gb: app-session authorizeを中断しました\n');
      return 130;
    }
    throw error;
  } finally {
    controller.abort();
    processObj.off('SIGINT', onSigint);
  }
}

async function runStreaming({ mode, agentId, prompt, timeoutSec, context, stdout, processObj }) {
  const controller = new AbortController();
  let stream;
  let reason = 'ended';
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    reason = 'sigint';
    controller.abort();
  };
  processObj.on('SIGINT', onSigint);
  const timer = timeoutSec === undefined ? null : setTimeout(() => {
    reason = 'timeout';
    controller.abort();
  }, timeoutSec * 1000);
  try {
    stream = subscribeEvents({
      baseUrl: context.gateway.baseUrl,
      token: context.gateway.token,
      appSessionHeaders: context.gateway.headers,
      knownSecrets: context.gateway.secrets,
      fetchImpl: context.fetchImpl,
      signal: controller.signal,
      reconnect: true,
    });
    if (mode === 'chat') {
      const first = await stream.next();
      if (controller.signal.aborted) {
        await writeStreamingJsonLine(stdout, { type: 'end', reason }, controller.signal);
        return interrupted ? 130 : 0;
      }
      if (first.done || first.value.kind !== 'open') throw new GbError('SSE接続を確認できませんでした', 4);
      let accepted;
      try {
        await assertAgentResolved(context, agentId, { signal: controller.signal });
        if (controller.signal.aborted) {
          await writeStreamingJsonLine(stdout, { type: 'end', reason }, controller.signal);
          return interrupted ? 130 : 0;
        }
        accepted = await context.client.api('sendPrompt', {
          agentId,
          prompt,
          clientNonce: nextClientNonce(context),
        }, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          await writeStreamingJsonLine(stdout, { type: 'end', reason }, controller.signal);
          return interrupted ? 130 : 0;
        }
        throw error;
      }
      await writeStreamingJsonLine(stdout, { type: 'accepted', agentId, response: accepted }, controller.signal);
      if (controller.signal.aborted) {
        await writeStreamingJsonLine(stdout, { type: 'end', reason }, controller.signal);
        return interrupted ? 130 : 0;
      }
    }
    for await (const item of stream) {
      if (item.kind !== 'event') continue;
      const filtered = filterTranscriptEvent(item.value, agentId);
      if (filtered) {
        await writeStreamingJsonLine(stdout, filtered, controller.signal);
        if (controller.signal.aborted) break;
      }
    }
    if (!controller.signal.aborted) reason = 'stream-ended';
    await writeStreamingJsonLine(stdout, { type: 'end', reason }, controller.signal);
    return interrupted ? 130 : 0;
  } catch (error) {
    if (controller.signal.aborted) {
      await writeStreamingJsonLine(stdout, { type: 'end', reason }, controller.signal);
      return interrupted ? 130 : 0;
    }
    if (error?.stdoutFailure === true) throw error;
    await writeStreamingJsonLine(stdout, { type: 'end', reason: 'error' }, controller.signal);
    throw error;
  } finally {
    controller.abort();
    try {
      await stream?.return?.();
    } catch {
      // Abort後のtransport終了errorは元の終了理由を上書きしない。
    }
    if (timer) clearTimeout(timer);
    processObj.off('SIGINT', onSigint);
  }
}

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const processObj = dependencies.processObj ?? process;
  const env = dependencies.env ?? process.env;
  let knownSecrets = [];
  let jsonErrors = false;
  try {
    const { options: global, rest } = takeGlobal(argv);
    if (global.appSession) {
      if (!global.allowRemote) throw new UsageError('--app-session には --allow-remote が必要です');
      if (global.dataRoot || global.gatewayUrl || env.GB_GATEWAY_URL) {
        throw new UsageError('--app-session は他の接続先指定と併用できません');
      }
    }
    if (global.version) {
      stdout.write('0.1.0\n');
      return 0;
    }
    if (global.help || rest.length === 0) {
      stdout.write(`${HELP}\n`);
      return 0;
    }
    const parsed = preflight(rest);
    jsonErrors = parsed.options?.json === true;
    const { command } = parsed;

    if (command === 'app-session') {
      return await runAppSessionAuthorize({ dependencies, stdin, stdout, stderr, processObj });
    }

    const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
    const gateway = await discoverGateway(global, {
      env, fetchImpl,
      homedir: dependencies.homedir,
      readFile: dependencies.readFile,
      pidAlive: dependencies.pidAlive,
      isHostMain: dependencies.isHostMain,
      loadAppSession: dependencies.loadAppSession,
      loadAppVersion: dependencies.loadAppVersion,
      platform: dependencies.platform,
      lstat: dependencies.lstat,
      realpath: dependencies.realpath,
      open: dependencies.open,
      plutilSpawn: dependencies.plutilSpawn,
      execFile: dependencies.execFile,
      now: dependencies.now,
      setTimeout: dependencies.setTimeout,
      clearTimeout: dependencies.clearTimeout,
    });
    knownSecrets = gateway.secrets;
    const client = new GatewayClient({
      baseUrl: gateway.baseUrl,
      token: gateway.token,
      appSessionHeaders: gateway.headers,
      knownSecrets: gateway.secrets,
      timeoutMs: global.requestTimeoutMs,
      fetchImpl,
    });
    const context = { gateway, client, fetchImpl, randomUUID: dependencies.randomUUID ?? randomUUID };

    if (command === 'doctor') {
      const { options } = parsed;
      const { status, compatibility } = await gatewayStatus(context, { mutation: false, strict: true, stderr, allowUnsupported: false });
      const gatewayMetadata = gateway.source === 'app-session'
        ? {
            source: 'app-session',
            descriptor: false,
            remote: true,
            authenticated: Boolean(gateway.token),
            routingHeader: Object.keys(gateway.headers).length > 0,
          }
        : { source: gateway.source, descriptor: gateway.descriptor, scheme: new URL(gateway.baseUrl).protocol.slice(0, -1), loopback: isLoopbackHost(new URL(gateway.baseUrl).hostname) };
      const result = gateway.source === 'app-session'
        ? { gateway: gatewayMetadata, health: sanitizeHealth(gateway.health, knownSecrets), compatibility }
        : {
            gateway: gatewayMetadata,
            health: sanitizeHealth(gateway.health, knownSecrets),
            hostVersion: status?.hostVersion ?? null,
            supported: status?.hostVersion === SUPPORTED_HOST_VERSION,
          };
      const humanVersion = compatibility ? `app: ${compatibility.observedAppVersion}` : `host: ${escapeTerminalControls(result.hostVersion ?? 'unknown')}`;
      printResult(stdout, options.json, result, `gateway: ok (${result.gateway.source}); health: ok; ${humanVersion}`);
      return 0;
    }

    if (command === 'status') {
      const { options } = parsed;
      const { status, compatibility } = await gatewayStatus(context, { mutation: false, strict: true, stderr, allowUnsupported: false });
      const agents = await client.api('listAgents');
      const result = gateway.source === 'app-session'
        ? { health: sanitizeHealth(gateway.health, knownSecrets), hostStatus: sanitizeHealth(status, knownSecrets), compatibility, agents }
        : { health: sanitizeHealth(gateway.health, knownSecrets), hostStatus: status, agents };
      const humanVersion = compatibility ? `app: ${compatibility.observedAppVersion}` : `host: ${escapeTerminalControls(status?.hostVersion ?? 'unknown')}`;
      printResult(stdout, options.json, result, `health: ok; ${humanVersion}; agents: ${Array.isArray(agents) ? agents.length : 'unknown'}`);
      return 0;
    }

    if (command === 'agents') {
      const { subcommand, options } = parsed;
      const mutation = subcommand === 'create';
      if (mutation) assertAgentCreateSupported(gateway);
      await gatewayStatus(context, { mutation, stderr, allowUnsupported: global.allowUnsupported });
      if (subcommand === 'list') {
        const result = await client.api('listAgents');
        const human = Array.isArray(result) ? result.map((agent) => `${escapeTerminalControls(agent?.id ?? '?')}\t${escapeTerminalControls(agent?.name ?? '')}`).join('\n') : 'agent一覧を取得しました';
        printResult(stdout, options.json, result, human);
      } else if (subcommand === 'search') {
        const result = await client.api('searchAgents', { query: options.query, limit: options.limit });
        const human = Array.isArray(result) ? result.map((agent) => `${escapeTerminalControls(agent?.id ?? '?')}\t${escapeTerminalControls(agent?.name ?? '')}`).join('\n') : '検索結果を取得しました';
        printResult(stdout, options.json, result, human);
      } else {
        const result = await client.api('createAgent', {
          name: options.name,
          description: options.description,
          clientNonce: nextClientNonce(context),
        });
        printResult(stdout, options.json, result, `agentを作成しました: ${escapeTerminalControls(result?.agent?.id ?? '(ID unavailable)')}`);
      }
      return 0;
    }

    if (command === 'transcript') {
      const { options } = parsed;
      await gatewayStatus(context, { mutation: false, stderr, allowUnsupported: false });
      await assertAgentResolved(context, options.agent);
      const body = { id: options.agent, limit: options.limit };
      if (options.beforeSeq !== undefined) body.beforeSeq = options.beforeSeq;
      const result = await client.api('getAgentTranscriptTail', body);
      printResult(stdout, options.json, result, escapeJsonTerminalControls(JSON.stringify(result, null, 2)));
      return 0;
    }

    if (command === 'send') {
      const { options } = parsed;
      await gatewayStatus(context, { mutation: true, stderr, allowUnsupported: global.allowUnsupported });
      const prompt = await readPrompt(options, stdin);
      await assertAgentResolved(context, options.agent);
      const result = await client.api('sendPrompt', {
        agentId: options.agent,
        prompt,
        clientNonce: nextClientNonce(context),
      });
      printResult(stdout, options.json, result, result?.accepted ? 'promptはacceptedです（完了ではありません）' : 'prompt responseを受信しました');
      return 0;
    }

    if (command === 'watch' || command === 'chat') {
      const { options } = parsed;
      const mutation = command === 'chat';
      await gatewayStatus(context, { mutation, stderr, allowUnsupported: global.allowUnsupported });
      const prompt = command === 'chat' ? await readPrompt(options, stdin) : undefined;
      await assertAgentResolved(context, options.agent);
      return await runStreaming({ mode: command, agentId: options.agent, prompt, timeoutSec: options.timeout, context, stdout, processObj });
    }

    const { options } = parsed;
    await gatewayStatus(context, { mutation: true, stderr, allowUnsupported: global.allowUnsupported });
    await assertAgentResolved(context, options.agent);
    const result = await client.api('interruptAgentRun', { id: options.agent });
    printResult(stdout, options.json, result, result?.hadActiveRun ? 'active runをinterruptしました' : 'active runはありませんでした');
    return 0;
  } catch (error) {
    const code = error instanceof GbError ? error.exitCode : 4;
    const message = error instanceof GbError ? error.message : '予期しないエラーが発生しました';
    const safeMessage = redactText(message, knownSecrets);
    if (jsonErrors && (error?.appSession === true || error?.capability === true)) {
      jsonLine(stderr, {
        error: {
          reason: error.reason,
          message: safeMessage,
          hint: redactText(error.hint, knownSecrets),
        },
      });
    } else if (error?.appSession === true) {
      stderr.write(`gb: ${escapeTerminalControls(safeMessage)} (${escapeTerminalControls(redactText(error.hint, knownSecrets))})\n`);
    } else if (error?.capability === true) {
      stderr.write(`gb: ${escapeTerminalControls(safeMessage)} (reason: ${escapeTerminalControls(error.reason)}; ${escapeTerminalControls(redactText(error.hint, knownSecrets))})\n`);
    } else {
      stderr.write(`gb: ${escapeTerminalControls(safeMessage)}\n`);
    }
    return code;
  }
}
