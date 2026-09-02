import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { VERSION } from './version.ts';

test('VERSION', async (t) => {
  await t.test('matches package.json, the single source of the version', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    assert.equal(VERSION, pkg.version);
  });

  await t.test('is a non-empty semver-shaped string', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
  });
});
