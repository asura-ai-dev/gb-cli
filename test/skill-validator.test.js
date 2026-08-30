import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('validate-skillsは別directoryを指すsymlinkを拒否する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gb-skills-'));
  await Promise.all([
    mkdir(path.join(root, 'scripts'), { recursive: true }),
    mkdir(path.join(root, 'skills'), { recursive: true }),
    mkdir(path.join(root, '.agents', 'skills'), { recursive: true }),
    mkdir(path.join(root, '.claude', 'skills'), { recursive: true }),
  ]);
  await cp(path.join(repositoryRoot, 'scripts', 'validate-skills'), path.join(root, 'scripts', 'validate-skills'));
  await cp(path.join(repositoryRoot, 'skills', 'gb-cli'), path.join(root, 'skills', 'gb-cli'), { recursive: true });
  await cp(path.join(repositoryRoot, 'skills', 'gb-cli'), path.join(root, 'skills', 'other'), { recursive: true });
  await symlink('../../skills/other', path.join(root, '.agents', 'skills', 'gb-cli'));
  await symlink('../../skills/gb-cli', path.join(root, '.claude', 'skills', 'gb-cli'));
  await assert.rejects(
    execFileAsync('bash', [path.join(root, 'scripts', 'validate-skills')]),
    (error) => {
      assert.match(error.stderr, /正本を指してください/);
      return true;
    },
  );
});
