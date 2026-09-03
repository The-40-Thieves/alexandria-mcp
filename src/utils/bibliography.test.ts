import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryResult } from '../types.ts';
import { formatBibliography } from './bibliography.ts';

const full: LibraryResult = {
  id: '10.1038/nature12373',
  source: 'crossref',
  title: 'Nanometre-scale thermometry in a living cell',
  authors: ['G. Kucsko', 'P. C. Maurer'],
  year: 2013,
  hasFullText: false,
  previewUrl: 'https://doi.org/10.1038/nature12373',
};

const sparse: LibraryResult = {
  id: '10.1063/1.5011231',
  source: 'opencitations',
  title: 'Citing work (doi:10.1063/1.5011231)',
  authors: [],
  hasFullText: false,
};

test('formatBibliography: bibtex', async (t) => {
  await t.test('one item with authors, year, and a url', () => {
    const out = formatBibliography([full], 'bibtex');
    assert.equal(
      out,
      [
        '@article{Kucsko2013Nanometrescale,',
        '  title = {Nanometre-scale thermometry in a living cell},',
        '  author = {G. Kucsko and P. C. Maurer},',
        '  year = {2013},',
        '  url = {https://doi.org/10.1038/nature12373},',
        '  note = {crossref:10.1038/nature12373}',
        '}',
      ].join('\n'),
    );
  });

  await t.test('falls back to source:id for the cite key when authors/title are empty', () => {
    const out = formatBibliography([{ ...sparse, title: '' }], 'bibtex');
    assert.match(out, /^@article\{opencitations10106315011231,/);
  });

  await t.test('two items join with a blank line, forming one multi-entry file', () => {
    const out = formatBibliography([full, sparse], 'bibtex');
    const entries = out.split('\n\n');
    assert.equal(entries.length, 2);
    assert.match(entries[0] ?? '', /^@article\{Kucsko2013/);
    assert.match(entries[1] ?? '', /^@article\{/);
  });

  await t.test('omits author/year/url fields when absent', () => {
    const out = formatBibliography([sparse], 'bibtex');
    assert.ok(!out.includes('author ='));
    assert.ok(!out.includes('year ='));
    assert.ok(!out.includes('url ='));
    assert.match(out, /note = \{opencitations:10\.1063\/1\.5011231\}/);
  });
});

test('formatBibliography: ris', () => {
  const out = formatBibliography([full], 'ris');
  assert.equal(
    out,
    [
      'TY  - JOUR',
      'TI  - Nanometre-scale thermometry in a living cell',
      'AU  - G. Kucsko',
      'AU  - P. C. Maurer',
      'PY  - 2013',
      'UR  - https://doi.org/10.1038/nature12373',
      'ID  - crossref:10.1038/nature12373',
      'ER  - ',
    ].join('\n'),
  );
});

test('formatBibliography: apa', () => {
  const out = formatBibliography([full], 'apa');
  assert.equal(
    out,
    'G. Kucsko, P. C. Maurer (2013). Nanometre-scale thermometry in a living cell. https://doi.org/10.1038/nature12373',
  );
});

test('formatBibliography: apa falls back to source name and (n.d.) when authors/year are missing', () => {
  const out = formatBibliography([sparse], 'apa');
  assert.equal(out, 'opencitations (n.d.). Citing work (doi:10.1063/1.5011231).');
});
