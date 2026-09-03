import assert from 'node:assert/strict';
import test from 'node:test';
import './sources/all.ts';
import { buildInstructions } from './instructions.ts';
import { listSources } from './sources/registry.ts';

test('buildInstructions', () => {
  const sourceCount = listSources().length;
  const instructions = buildInstructions(sourceCount);

  assert.ok(
    instructions.includes(`${sourceCount} public research libraries`),
    'the live source count is embedded, not a hardcoded snapshot',
  );
  assert.ok(instructions.length < 1500, `expected under 1500 chars, got ${instructions.length}`);
  assert.ok(!instructions.includes('—'), 'no em dashes');
});

test('buildInstructions reflects a changed source count, not a baked-in one', () => {
  assert.ok(buildInstructions(1).includes('1 public research libraries'));
  assert.ok(buildInstructions(999).includes('999 public research libraries'));
});
