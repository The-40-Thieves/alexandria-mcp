import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractPdf } from './pdf.ts';

// eval/fixtures/sample.pdf is a hand-built, two-page PDF (see
// scripts/gen-pdf-fixture.ts) - real bytes committed to the repo rather
// than fetched, per task 6's brief.
function sampleBytes(): Uint8Array {
  return new Uint8Array(readFileSync(path.resolve(process.cwd(), 'eval/fixtures/sample.pdf')));
}

test('extractPdf', async (t) => {
  await t.test('extracts per-page text, in page order', async () => {
    const result = await extractPdf(sampleBytes(), 'https://example.org/sample.pdf');
    assert.deepEqual(
      result.pages.map((p) => p.page),
      [1, 2],
    );
    assert.equal(result.pages[0].text, 'Hello from page one of the fixture PDF.');
    assert.equal(result.pages[1].text, 'Hello from page two of the fixture PDF.');
  });

  await t.test('joins page text into `text` with the documented separator', async () => {
    const result = await extractPdf(sampleBytes(), 'https://example.org/sample.pdf');
    assert.equal(
      result.text,
      'Hello from page one of the fixture PDF.\n\nHello from page two of the fixture PDF.',
    );
  });

  await t.test('reads the /Info /Title as the extracted title', async () => {
    const result = await extractPdf(sampleBytes(), 'https://example.org/sample.pdf');
    assert.equal(result.title, 'Alexandria Fixture PDF');
  });

  await t.test(
    'throws with the url in the message when a PDF has no extractable text',
    async () => {
      // A minimal, valid, single blank page (no content stream at all) - a
      // scanned PDF with no text layer looks like this to unpdf.
      const blankPdf = Buffer.from(
        '%PDF-1.4\n' +
          '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
          '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
          '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n' +
          'trailer\n<< /Size 4 /Root 1 0 R >>\n%%EOF',
        'latin1',
      );
      await assert.rejects(
        () => extractPdf(new Uint8Array(blankPdf), 'https://example.org/blank.pdf'),
        /extractPdf: no extractable text in PDF at https:\/\/example.org\/blank.pdf/,
      );
    },
  );
});
