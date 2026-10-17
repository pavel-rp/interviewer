// Re-copy UInlay's paint library into vendor/uinlay and record the commit.
// Usage: node tools/vendor-uinlay.mjs [path-to-uinlay-checkout]
// Only these four files are taken: the rest of UInlay's src/ imports its own
// plugin contract or demo data, which must not leak into this plugin.
import { copyFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const FILES = ['frame.ts', 'theme.ts', 'components.ts', 'index.ts'];
const source = resolve(process.argv[2] ?? '../uinlay');
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['-C', source, 'status', '--porcelain', '--', ...FILES.map(file => `src/${file}`)], { encoding: 'utf8' }).trim();
for (const file of FILES) await copyFile(resolve(source, 'src', file), resolve('vendor/uinlay', file));
await writeFile('vendor/uinlay/VENDORED.md', `# Vendored UInlay paint library

Copied from UInlay \`src/\` (${FILES.join(', ')}) at commit \`${commit}\`${dirty ? ' **with uncommitted changes**' : ''}.
Do not edit these files here; change UInlay and re-run \`npm run vendor\`.
`);
console.log(`Vendored ${FILES.length} files from ${source} @ ${commit.slice(0, 7)}${dirty ? ' (dirty)' : ''}`);
