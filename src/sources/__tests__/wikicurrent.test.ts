import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeWikicurrent, parseSections } from '../wikicurrent.js';

const fixture = readFileSync(
  path.resolve(process.cwd(), 'eval/fixtures/wikicurrent-portal.html'),
  'utf8',
);

test('parseSections', async (t) => {
  await t.test('splits the portal HTML into day sections by date', () => {
    const sections = parseSections(fixture);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].date, '2026-09-01');
    assert.ok(sections[0].text.includes('Fighting continues'));
    assert.equal(sections[1].date, '2026-08-31');
    assert.ok(sections[1].text.includes('quarter-point rate cut'));
  });
});

test('normalizeWikicurrent', async (t) => {
  await t.test('maps a day section to a LibraryResult', () => {
    const sections = parseSections(fixture);
    const out = normalizeWikicurrent(sections[0]);
    assert.equal(out.id, '2026-09-01');
    assert.equal(out.source, 'wikicurrent');
    assert.equal(out.title, 'Current events 2026-09-01');
    assert.equal(out.year, 2026);
    assert.ok(out.description?.includes('Fighting continues'));
  });
});
