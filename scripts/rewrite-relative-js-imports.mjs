#!/usr/bin/env node
// One-shot, deterministic rewrite: every relative import specifier ending in
// .js becomes .ts, across static import/export...from, dynamic import(), and
// import type. Non-relative and package imports are untouched. Run once,
// documented in the commit that used it; not meant to run again.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const files = execSync("git ls-files 'src/*.ts' 'src/**/*.ts' 'scripts/*.ts' 'scripts/**/*.ts'", {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((file, index, all) => all.indexOf(file) === index);

// Matches a quoted relative specifier ending in .js immediately after
// `from `, `import(`, or a bare `import `, covering:
//   import x from '../foo.js'
//   export { x } from '../foo.js'
//   import type x from '../foo.js'
//   await import('../foo.js')
//   import '../foo.js' (side-effect only, no binding)
const RELATIVE_JS_SPECIFIER = /((?:from\s+|import\(\s*|import\s+))(['"])(\.\.?\/[^'"]+)\.js\2/g;

let sites = 0;
let changedFiles = 0;
for (const file of files) {
  const original = readFileSync(file, 'utf8');
  let count = 0;
  const rewritten = original.replace(RELATIVE_JS_SPECIFIER, (_match, prefix, quote, specifier) => {
    count += 1;
    return `${prefix}${quote}${specifier}.ts${quote}`;
  });
  if (count > 0) {
    writeFileSync(file, rewritten);
    sites += count;
    changedFiles += 1;
  }
}

console.log(`rewrote ${sites} import specifiers across ${changedFiles} files`);
