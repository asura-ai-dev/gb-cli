import { execFile as execFileCallback } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedFiles = new Set([
  'package.json',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'bin/gb.js',
  'src/app-session.js',
  'src/cli.js',
  'src/discovery.js',
  'src/errors.js',
  'src/http.js',
  'src/sanitize.js',
  'src/sse.js',
  'skills/gb-cli/SKILL.md',
  'skills/gb-cli/agents/openai.yaml',
  'skills/gb-cli/references/commands.md',
  'skills/gb-cli/references/safety.md',
]);

function safePath(value) {
  return String(value).replace(/[^A-Za-z0-9._/-]/g, '?');
}

function fail(message) {
  console.error(`package検査に失敗しました: ${message}`);
  process.exitCode = 1;
}

let stdout;
try {
  ({ stdout } = await execFile('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }));
} catch {
  fail('npm pack --dry-runを実行できませんでした');
}

if (stdout !== undefined) {
  let results;
  try {
    results = JSON.parse(stdout);
  } catch {
    fail('npm packのJSON結果が不正です');
  }

  if (results !== undefined) {
    if (!Array.isArray(results) || results.length !== 1 || !results[0] || !Array.isArray(results[0].files)) {
      fail('npm packの結果はpackage 1件ではありません');
    } else {
      const pack = results[0];
      const actualFiles = pack.files.map((file) => file?.path).filter((file) => typeof file === 'string');
      const actualSet = new Set(actualFiles);
      const missing = [...expectedFiles].filter((file) => !actualSet.has(file));
      const unexpected = [...actualSet].filter((file) => !expectedFiles.has(file));
      if (actualFiles.length !== expectedFiles.size || missing.length > 0 || unexpected.length > 0) {
        const detail = [
          missing.length > 0 ? `missing=${missing.map(safePath).join(',')}` : null,
          unexpected.length > 0 ? `unexpected=${unexpected.map(safePath).join(',')}` : null,
        ].filter(Boolean).join('; ');
        fail(detail || 'file件数が一致しません');
      }
      if (!Array.isArray(pack.bundled) || pack.bundled.length !== 0) {
        fail('bundled dependencyが空ではありません');
      }
      const executable = pack.files.find((file) => file?.path === 'bin/gb.js');
      if (!Number.isInteger(executable?.mode) || (executable.mode & 0o111) === 0) {
        fail('bin/gb.jsに実行権限がありません');
      }
      if (process.exitCode !== 1) console.log('package内容の検査に成功しました');
    }
  }
}
