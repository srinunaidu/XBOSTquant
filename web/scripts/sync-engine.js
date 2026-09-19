// Copies the canonical quant sources into web/public so the built app and
// the classic Web Worker always run byte-identical engine code.
// Runs automatically before `vite build` (prebuild) — run manually for dev:
//   node scripts/sync-engine.js
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['engine.js', 'worker.js'];
mkdirSync(join(root, 'public'), { recursive: true });
for (const f of files) {
  copyFileSync(join(root, '..', 'public', f), join(root, 'public', f));
  console.log(`synced public/${f}`);
}
