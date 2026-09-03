// One-time generator for eval/fixtures/sample.pdf, the fixture pdf.test.ts
// and fetchTier.test.ts read to exercise extractPdf()/the PDF tier without
// fetching anything over the network. Hand-builds a minimal, valid
// two-page PDF (uncompressed objects, Helvetica text, one /Info title)
// byte-for-byte rather than pulling in a PDF-authoring library - unpdf is
// the one runtime dependency task 6 is allowed to add, and this script
// only ever runs by hand, so it isn't a runtime dependency at all.
//
// Run once with `node scripts/gen-pdf-fixture.ts` and commit the resulting
// bytes; nothing else in the test suite re-runs this script.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const PAGE_TEXTS = [
  'Hello from page one of the fixture PDF.',
  'Hello from page two of the fixture PDF.',
];
const TITLE = 'Alexandria Fixture PDF';

interface Obj {
  id: number;
  body: string; // everything between "N 0 obj" and "endobj", exclusive
}

function buildPdf(): Buffer {
  const objs: Obj[] = [];
  // 1: Catalog
  objs.push({ id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  // 2: Pages
  objs.push({
    id: 2,
    body: `<< /Type /Pages /Kids [${PAGE_TEXTS.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${PAGE_TEXTS.length} >>`,
  });
  // 3: Font (shared by every page)
  const fontId = 3 + PAGE_TEXTS.length * 2;
  // Pages + content streams, interleaved: page N is object (3 + 2*i), its
  // content stream is (4 + 2*i).
  PAGE_TEXTS.forEach((text, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    const escaped = text.replace(/([()\\])/g, '\\$1');
    const stream = `BT /F1 18 Tf 72 700 Td (${escaped}) Tj ET`;
    objs.push({
      id: pageId,
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    });
    objs.push({
      id: contentId,
      body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    });
  });
  objs.push({ id: fontId, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });
  const infoId = fontId + 1;
  objs.push({ id: infoId, body: `<< /Title (${TITLE}) >>` });

  objs.sort((a, b) => a.id - b.id);

  const chunks: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [0]; // object 0 is always free, offset 0
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
  chunks.push(
    `trailer\n<< /Size ${totalObjs} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  );

  return Buffer.from(chunks.join(''), 'latin1');
}

const pdf = buildPdf();
const outPath = path.resolve(process.cwd(), 'eval/fixtures/sample.pdf');
writeFileSync(outPath, pdf);
console.log(`wrote ${pdf.byteLength} bytes to ${outPath}`);
