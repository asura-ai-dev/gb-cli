import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { candidateRoots, discoverGateway, isHostMainCommand, validateDescriptor, validateGatewayUrl } from '../src/discovery.js';

const startedAt = '2026-08-29T00:00:00.000Z';

function healthResponse(body = { ok: true }) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('candidate rootは明示指定を最優先し、それ以外を追加しない', () => {
  assert.deepEqual(candidateRoots({ dataRoot: './chosen', env: { SAND_DATA_ROOT: '/other' }, homedir: '/home/a' }), [
    { root: path.resolve('./chosen'), source: 'option' },
  ]);
});

test('candidate rootは環境変数とstable/lab/devの順になる', () => {
  assert.deepEqual(candidateRoots({ env: { SAND_DATA_ROOT: '/data', SAND_USER_DATA_DIR: '/user' }, homedir: '/home/a' }), [
    { root: '/data', source: 'SAND_DATA_ROOT' },
    { root: '/user/sand-data', source: 'SAND_USER_DATA_DIR' },
    { root: '/home/a/.grokbot', source: 'stable' },
    { root: '/home/a/.cursor/sand-lab', source: 'lab' },
    { root: '/home/a/.cursor/sand-dev', source: 'dev' },
  ]);
});

test('gateway descriptorを厳格に検証する', () => {
  assert.throws(() => validateDescriptor({ port: 1, pid: 2, startedAt, extra: true }), /未知/);
  assert.throws(() => validateDescriptor({ port: 0, pid: 2, startedAt }), /port/);
  assert.throws(() => validateDescriptor({ port: 1, pid: 2, startedAt: 'not-a-date' }), /startedAt/);
  assert.throws(() => validateDescriptor({ port: 1, pid: 2, startedAt, scheme: 'file' }), /scheme/);
});

test('remote gatewayは明示許可が必要', () => {
  assert.throws(() => validateGatewayUrl('http://192.0.2.1:1234', false), /allow-remote/);
  assert.throws(() => validateGatewayUrl('https://192.0.2.1:1234', false), /allow-remote/);
  assert.throws(() => validateGatewayUrl('http://192.0.2.1:1234', true), /HTTPS/);
  assert.equal(validateGatewayUrl('https://192.0.2.1:1234', true), 'https://192.0.2.1:1234');
  assert.equal(validateGatewayUrl('http://localhost:1234', false), 'http://localhost:1234');
  assert.throws(() => validateGatewayUrl('http://user:pass@localhost:1234', false), /認証情報/);
});

test('明示URLはremote許可とHTTPSをfetch前に検証しloopback HTTPを許可する', async () => {
  let fetches = 0;
  const dependencies = {
    env: {},
    fetchImpl: async () => {
      fetches += 1;
      return healthResponse();
    },
  };

  await assert.rejects(
    () => discoverGateway({ gatewayUrl: 'http://192.0.2.10:3210' }, dependencies),
    /allow-remote/,
  );
  await assert.rejects(
    () => discoverGateway({ gatewayUrl: 'https://192.0.2.10:3210' }, dependencies),
    /allow-remote/,
  );
  await assert.rejects(
    () => discoverGateway({ gatewayUrl: 'http://192.0.2.10:3210', allowRemote: true }, dependencies),
    /HTTPS/,
  );
  assert.equal(fetches, 0);

  const remote = await discoverGateway({ gatewayUrl: 'https://192.0.2.10:3210', allowRemote: true }, dependencies);
  const loopback = await discoverGateway({ gatewayUrl: 'http://127.0.0.1:3210' }, dependencies);
  assert.equal(remote.baseUrl, 'https://192.0.2.10:3210');
  assert.equal(loopback.baseUrl, 'http://127.0.0.1:3210');
  assert.equal(fetches, 2);
});

test('descriptor URLもremote許可とHTTPSをfetch前に検証する', async () => {
  let fetches = 0;
  const descriptor = { port: 3210, pid: 10, startedAt };
  const dependencies = {
    env: {},
    readFile: async () => JSON.stringify(descriptor),
    pidAlive: async () => true,
    isHostMain: async () => true,
    fetchImpl: async () => {
      fetches += 1;
      return healthResponse({ ok: true, pid: descriptor.pid, startedAt });
    },
  };

  descriptor.host = '192.0.2.10';
  descriptor.scheme = 'http';
  await assert.rejects(() => discoverGateway({ dataRoot: '/synthetic' }, dependencies), /見つかりません/);
  await assert.rejects(() => discoverGateway({ dataRoot: '/synthetic', allowRemote: true }, dependencies), /見つかりません/);
  descriptor.scheme = 'https';
  await assert.rejects(() => discoverGateway({ dataRoot: '/synthetic' }, dependencies), /見つかりません/);
  assert.equal(fetches, 0);

  const remote = await discoverGateway({ dataRoot: '/synthetic', allowRemote: true }, dependencies);
  assert.equal(remote.baseUrl, 'https://192.0.2.10:3210');
  descriptor.host = '127.0.0.1';
  descriptor.scheme = 'http';
  const loopback = await discoverGateway({ dataRoot: '/synthetic' }, dependencies);
  assert.equal(loopback.baseUrl, 'http://127.0.0.1:3210');
  assert.equal(fetches, 2);
});

test('invalid/dead/wrong/stale descriptorを除外して次候補を使う', async () => {
  const token = `token-${randomUUID()}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'gb-discovery-'));
  const dataRoot = path.join(root, 'data');
  const userRoot = path.join(root, 'user', 'sand-data');
  const stable = path.join(root, 'home', '.grokbot');
  await Promise.all([dataRoot, userRoot, stable].map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(path.join(dataRoot, 'gateway.json'), JSON.stringify({ port: 1111, pid: 11, startedAt }));
  await writeFile(path.join(userRoot, 'gateway.json'), JSON.stringify({ port: 2222, pid: 22, startedAt }));
  await writeFile(path.join(stable, 'gateway.json'), JSON.stringify({ port: 3333, pid: 33, startedAt, token }));

  const result = await discoverGateway({}, {
    env: { SAND_DATA_ROOT: dataRoot, SAND_USER_DATA_DIR: path.join(root, 'user') },
    homedir: () => path.join(root, 'home'),
    pidAlive: async (pid) => pid !== 11,
    isHostMain: async (pid) => pid !== 22,
    fetchImpl: async (url) => healthResponse({ ok: true, pid: 33, startedAt }),
  });
  assert.equal(result.source, 'stable');
  assert.equal(result.baseUrl, 'http://127.0.0.1:3333');
  assert.equal(result.token, token);
});

test('healthのPIDが違うdescriptorはstale', async () => {
  await assert.rejects(() => discoverGateway({ dataRoot: '/unused' }, {
    env: {},
    readFile: async () => JSON.stringify({ port: 1234, pid: 10, startedAt }),
    pidAlive: async () => true,
    isHostMain: async () => true,
    fetchImpl: async () => healthResponse({ ok: true, pid: 999, startedAt }),
  }), /見つかりません/);
});

test('healthのstartedAtだけが違うdescriptorもstale', async () => {
  await assert.rejects(() => discoverGateway({ dataRoot: '/unused' }, {
    env: {},
    readFile: async () => JSON.stringify({ port: 1234, pid: 10, startedAt }),
    pidAlive: async () => true,
    isHostMain: async () => true,
    fetchImpl: async () => healthResponse({ ok: true, pid: 10, startedAt: '2026-08-29T00:00:01.000Z' }),
  }), /見つかりません/);
});

test('descriptor discoveryはhealth identityの欠落・型不正をstaleとして次候補へ進む', async () => {
  for (const firstHealth of [
    { ok: true, startedAt },
    { ok: true, pid: 11 },
    { ok: true, pid: '11', startedAt },
    { ok: true, pid: 11, startedAt: 123 },
  ]) {
    const result = await discoverGateway({}, {
      env: { SAND_DATA_ROOT: '/first' },
      homedir: () => '/home/test',
      readFile: async (filename) => {
        if (filename === '/first/gateway.json') return JSON.stringify({ port: 1111, pid: 11, startedAt });
        if (filename === '/home/test/.grokbot/gateway.json') return JSON.stringify({ port: 2222, pid: 22, startedAt });
        throw new Error('missing');
      },
      pidAlive: async () => true,
      isHostMain: async () => true,
      fetchImpl: async (url) => url.includes(':1111/')
        ? healthResponse(firstHealth)
        : healthResponse({ ok: true, pid: 22, startedAt }),
    });
    assert.equal(result.source, 'stable');
    assert.equal(result.baseUrl, 'http://127.0.0.1:2222');
  }
});

test('host-main判定は独立argvの完全なhost-main.cjsだけを受理する', () => {
  assert.equal(isHostMainCommand('node /Applications/Grok Bot.app/Contents/Resources/app/dist/host/host-main.cjs --port 1'), true);
  assert.equal(isHostMainCommand('node "/Applications/Grok Bot.app/Contents/Resources/host-main.cjs" --port 1'), true);
  assert.equal(isHostMainCommand('/usr/local/bin/host-main.cjs'), true);
  assert.equal(isHostMainCommand('node host-main.cjs'), true);
  assert.equal(isHostMainCommand('node worker.cjs --label host-main'), false);
  assert.equal(isHostMainCommand('node worker.cjs --label host-main.cjs'), false);
  assert.equal(isHostMainCommand('node worker --label host-main.cjs'), false);
  assert.equal(isHostMainCommand('node worker --label /tmp/host-main.cjs'), false);
  assert.equal(isHostMainCommand('curl --output /tmp/host-main.cjs'), false);
  assert.equal(isHostMainCommand('worker --label /tmp/host-main.cjs'), false);
  assert.equal(isHostMainCommand('node --require /tmp/host-main.cjs worker.cjs'), false);
  assert.equal(isHostMainCommand('node --import /tmp/host-main.cjs worker.mjs'), false);
  assert.equal(isHostMainCommand('nodejs /tmp/host-main.cjs'), true);
  assert.equal(isHostMainCommand('electron /tmp/host-main.cjs'), true);
  assert.equal(isHostMainCommand('"/Applications/Grok Bot.app/Contents/Frameworks/Grok Bot Helper.app/Contents/MacOS/Grok Bot Helper" "/tmp/host-main.cjs"'), true);
  assert.equal(isHostMainCommand('/Applications/Grok Bot.app/Contents/Frameworks/Grok Bot Helper.app/Contents/MacOS/Grok Bot Helper /tmp/host-main.cjs'), true);
  assert.equal(isHostMainCommand('node worker.cjs --label=host-main.cjs'), false);
  assert.equal(isHostMainCommand('node /tmp/not-host-main.cjs-extra'), false);
});

test('明示URLではdescriptorを読まずhealthを検証し、tokenは環境変数だけ', async () => {
  const token = `token-${randomUUID()}`;
  let read = false;
  let healthHeaders;
  const result = await discoverGateway({ gatewayUrl: 'http://localhost:3210' }, {
    env: { GB_GATEWAY_TOKEN: token },
    readFile: async () => { read = true; },
    fetchImpl: async (_url, init) => {
      healthHeaders = init.headers;
      return healthResponse();
    },
  });
  assert.equal(read, false);
  assert.equal(result.token, token);
  assert.equal(healthHeaders.Authorization, undefined);
  assert.equal(healthHeaders.Origin, undefined);
});

test('app session指定時だけloaderを使いauth付きhealthをredirect拒否で確認する', async () => {
  const token = `token-${randomUUID()}`;
  const routing = `routing-${randomUUID()}`;
  const baseUrl = `https://${randomUUID()}.invalid`;
  let loaderCalls = 0;
  let healthCall;
  const result = await discoverGateway({ appSession: true, allowRemote: true }, {
    env: {},
    loadAppSession: async () => {
      loaderCalls += 1;
      return {
        baseUrl, token,
        headers: { 'x-anyrun-network-token': routing }, secrets: [token, routing],
        appVersion: '0.24.0', compatibilitySource: 'app-bundle',
      };
    },
    fetchImpl: async (...args) => {
      healthCall = args;
      return healthResponse();
    },
  });
  assert.equal(loaderCalls, 1);
  assert.equal(result.source, 'app-session');
  assert.equal(result.descriptor, false);
  assert.equal(result.remote, true);
  assert.equal(result.appVersion, '0.24.0');
  assert.equal(result.compatibilitySource, 'app-bundle');
  assert.equal(healthCall[0], `${baseUrl}/health`);
  assert.equal(healthCall[1].headers.Authorization, `Bearer ${token}`);
  assert.equal(healthCall[1].headers['x-anyrun-network-token'], routing);
  assert.equal(healthCall[1].redirect, 'error');
});

test('app sessionのunknown compatibility sourceはhealth前に拒否されoverrideできない', async () => {
  let fetches = 0;
  await assert.rejects(() => discoverGateway({ appSession: true, allowRemote: true, allowUnsupported: true }, {
    env: {},
    loadAppSession: async () => ({
      baseUrl: `https://${randomUUID()}.invalid`, token: randomUUID(), headers: {}, secrets: [],
      appVersion: '0.24.0', compatibilitySource: 'unknown',
    }),
    fetchImpl: async () => { fetches += 1; throw new Error('unexpected'); },
  }), (error) => error.reason === 'app-version-invalid');
  assert.equal(fetches, 0);
});

test('通常discoveryはapp session loaderへ自動fallbackしない', async () => {
  let loaderCalls = 0;
  await assert.rejects(() => discoverGateway({ dataRoot: '/unused' }, {
    env: {},
    readFile: async () => { throw new Error('missing'); },
    loadAppSession: async () => { loaderCalls += 1; throw new Error('unexpected'); },
  }), /見つかりません/);
  assert.equal(loaderCalls, 0);
});
