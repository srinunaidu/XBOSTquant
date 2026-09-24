// Copies the canonical quant sources into web/public so the built app and
// the classic Web Worker always run byte-identical engine code.
// Runs automatically before `vite build` (prebuild) — run manually for dev:
//   node scripts/sync-engine.js
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['engine.js', 'worker.js', 'robustness.js'];
mkdirSync(join(root, 'public'), { recursive: true });
for (const f of files) {
  copyFileSync(join(root, '..', 'public', f), join(root, 'public', f));
  console.log(`synced public/${f}`);
}

// Build stamp: version id + last-update timestamp baked into the bundle and
// shown in the Home footer. Regenerated on every build (git-ignored).
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: join(root, '..') }).toString().trim(); } catch { /* non-git build */ }
  const info = { version: pkg.version || '0.0.0', commit, builtAt: new Date().toISOString() };
  writeFileSync(
    join(root, 'src', 'lib', 'buildinfo.ts'),
    `// GENERATED at prebuild — do not edit (see scripts/sync-engine.js).\n` +
    `export const BUILD_INFO = ${JSON.stringify(info)} as { version: string; commit: string; builtAt: string };\n`
  );
  console.log(`stamped build ${info.version} · ${info.commit} · ${info.builtAt}`);
} catch (e) {
  console.log('build stamp skipped: ' + (e && e.message || e));
}
