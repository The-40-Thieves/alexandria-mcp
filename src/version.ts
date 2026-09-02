// The single source of the package version. Everything that reports a
// version (the McpServer handshake, GET /health, the generated docs) reads
// it from here, so a release bump touches package.json only.
//
// Read with fs rather than an import: the build emits CommonJS
// (module: NodeNext with no "type": "module"), so import.meta.url is
// unavailable and createRequire cannot be used, while a plain
// `import pkg from '../package.json'` would put package.json under rootDir
// and shift every emitted path down a directory. __dirname is dist/ after
// a build and src/ under tsx, and package.json sits one level above both.
import { readFileSync } from 'node:fs';
import path from 'node:path';

interface PackageJson {
  version?: string;
}

function readVersion(): string {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
  if (!pkg.version) throw new Error(`no version field in ${pkgPath}`);
  return pkg.version;
}

export const VERSION = readVersion();
