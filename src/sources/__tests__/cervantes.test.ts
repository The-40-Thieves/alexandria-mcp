import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cervantesRead, normalizeCervantesSparql } from '../cervantes.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/cervantes-sparql.json'), 'utf8'),
);

test('normalizeCervantesSparql', async (t) => {
  await t.test('maps SPARQL results bindings (Work label + author label)', () => {
    const out = normalizeCervantesSparql(fixture, 10);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, 'https://data.cervantesvirtual.com/work/698268');
    assert.match(out[0].title, /Quijote/);
    assert.deepEqual(out[0].authors, ['Gómez Labrador, Pedro Benito']);
    assert.equal(out[0].hasFullText, false);
    assert.equal(out[0].previewUrl, out[0].id);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeCervantesSparql(fixture, 1).length, 1);
  });

  await t.test('handles a binding with no author', () => {
    const noAuthor = { results: { bindings: [{ work: { value: 'x' }, title: { value: 'y' } }] } };
    assert.deepEqual(normalizeCervantesSparql(noAuthor, 10)[0].authors, []);
  });

  await t.test('handles an empty response', () => {
    assert.deepEqual(normalizeCervantesSparql({}, 10), []);
  });
});

test('cervantesRead serves the curated full-text catalog (fetch monkeypatched)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      '<html><body><article>El ingenioso hidalgo Don Quijote de la Mancha / Miguel de Cervantes Saavedra. Capítulo primero.</article></body></html>',
      { status: 200 },
    )) as typeof fetch;
  try {
    const out = await cervantesRead('quijote');
    assert.equal(out.title, 'Don Quijote de la Mancha');
    assert.match(out.text, /Capítulo primero/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cervantesRead reports a clear error for a SPARQL-only work id (no full text)', async () => {
  await assert.rejects(
    cervantesRead('https://data.cervantesvirtual.com/work/698268'),
    /bibliographic metadata only/,
  );
});
