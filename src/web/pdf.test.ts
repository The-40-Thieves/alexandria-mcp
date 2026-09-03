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
      // scanned PDF with no text layer looks like this to unpdf. Built
      // with a real xref table (buildBlankPdf below), not just bare
      // objects + trailer: without one, pdf.js falls back to its object-
      // scanning recovery path and logs "Indexing all PDF objects" on
      // every parse, which would leave that warning in every test run's
      // output even though this test's own assertion still passes.
      await assert.rejects(
        () => extractPdf(buildBlankPdf(), 'https://example.org/blank.pdf'),
        /extractPdf: no extractable text in PDF at https:\/\/example.org\/blank.pdf/,
      );
    },
  );
});

// A minimal, valid, single blank page (a Catalog, a Pages node, one Page
// with no /Contents at all) with a byte-accurate xref table, built the
// same way scripts/gen-pdf-fixture.ts builds eval/fixtures/sample.pdf:
// compute each object's offset as it's written, rather than hand-counting
// bytes, so a future edit to the object bodies can't silently desync the
// xref and reintroduce the same recovery-mode warning.
function buildBlankPdf(): Uint8Array {
  const objs = [
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { id: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' },
  ];
  const chunks: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [0];
  let offset = Buffer.byteLength(chunks[0], 'latin1');
  for (const obj of objs) {
    offsets[obj.id] = offset;
    const text = `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
    chunks.push(text);
    offset += Buffer.byteLength(text, 'latin1');
  }
  const xrefOffset = offset;
  const totalObjs = objs.length + 1;
  let xref = `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
  for (let id = 1; id < totalObjs; id++) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  chunks.push(xref);
  chunks.push(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return new Uint8Array(Buffer.from(chunks.join(''), 'latin1'));
}
