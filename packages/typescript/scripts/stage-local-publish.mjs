/** Copy local publication inputs, including built artifacts, without stamping the checkout. */
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const version = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
const [operation, destination] = process.argv.slice(2);
if (!['verify', 'stage'].includes(operation) || (operation === 'stage' && !destination)) {
  throw new Error('Usage: stage-local-publish.mjs verify | stage <directory>');
}
for (const entry of Object.values(version.packages).filter((entry) => entry.publish && !entry.stage)) {
  const manifest = JSON.parse(readFileSync(join(root, entry.dir, 'package.json'), 'utf8'));
  for (const output of [manifest.main, manifest.types].filter(Boolean)) {
    if (!existsSync(join(root, entry.dir, output))) {
      throw new Error(`${entry.dir}/${output} is missing; run make packages PACKAGE_NAMES=typescript first.`);
    }
  }
}
execFileSync(process.execPath, [join(root, 'packages/typescript/scripts/publish-npm-apps.mjs'), '--verify'], { stdio: 'inherit' });
if (operation === 'stage') {
  const copy = (relative) => {
    const target = join(destination, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, relative), target, {
      recursive: true,
      filter: (path) => !['node_modules', '.git', '.venv', '__pycache__'].includes(basename(path)),
    });
  };
  copy('version.json');
  copy('LICENSE');
  copy('packages/typescript/scripts');
  for (const entry of Object.values(version.packages)) {
    copy(entry.publish ? entry.dir : `${entry.dir}/package.json`);
  }
}
