/**
 * Renames the compiled preload to `.cjs`.
 *
 * The package is `"type": "module"`, so a `.js` file in dist would be treated as
 * ESM and Electron's require()-based preload loader would fail with
 * ERR_REQUIRE_ESM. The `.cjs` extension opts this one file back into CommonJS.
 *
 * Done in Node rather than `mv` so the build works on Windows too — which is
 * where this app actually runs.
 */
import { rename, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'dist', 'main', 'preload');
const from = join(dir, 'index.js');
const to = join(dir, 'index.cjs');

if (!existsSync(from)) {
  console.error(`finalizePreload: expected ${from} to exist`);
  process.exit(1);
}

await rm(to, { force: true });
await rename(from, to);

// Keep the sourcemap reference pointing at a file that exists.
const mapFrom = join(dir, 'index.js.map');
if (existsSync(mapFrom)) {
  const mapTo = join(dir, 'index.cjs.map');
  await rm(mapTo, { force: true });
  await rename(mapFrom, mapTo);
  const source = await readFile(to, 'utf8');
  await writeFile(to, source.replace('//# sourceMappingURL=index.js.map', '//# sourceMappingURL=index.cjs.map'));
}

console.log('finalizePreload: emitted dist/main/preload/index.cjs');
