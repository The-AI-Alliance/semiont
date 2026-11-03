import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'semiont-local-publication-'));
  const source = join(directory, 'source');
  const stage = join(directory, 'stage');
  const put = (path, text) => { mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), text); };
  const version = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
  put('version.json', JSON.stringify(version));
  put('LICENSE', 'fixture license');
  put('package-lock.json', 'dirty lockfile bytes');
  cpSync(join(root, 'packages/typescript/scripts'), join(source, 'packages/typescript/scripts'), { recursive: true });
  for (const entry of Object.values(version.packages)) {
    put(`${entry.dir}/package.json`, readFileSync(join(root, entry.dir, 'package.json'), 'utf8'));
    if (entry.publish && !entry.stage) {
      const manifest = JSON.parse(readFileSync(join(root, entry.dir, 'package.json'), 'utf8'));
      for (const path of [manifest.main, manifest.types]) put(`${entry.dir}/${path}`, 'built artifact');
    }
  }
  for (const path of ['server.js', 'README.npm.md', 'package.publish.json']) {
    put(`images/browser/${path}`, readFileSync(join(root, 'images/browser', path), 'utf8'));
  }
  put('images/browser/dist/index.html', '<html>built</html>');
  const run = (...args) => spawnSync(process.execPath, [join(source, 'packages/typescript/scripts/stage-local-publish.mjs'), ...args], { encoding: 'utf8' });
  return { directory, source, stage, run, version };
}

test('missing Browser artifacts fail before creating staging or touching source', () => {
  const f = fixture();
  try {
    rmSync(join(f.source, 'images/browser/dist/index.html'));
    const before = readFileSync(join(f.source, 'package-lock.json'));
    const result = f.run('stage', f.stage);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Browser not built/);
    assert.equal(existsSync(f.stage), false);
    assert.deepEqual(readFileSync(join(f.source, 'package-lock.json')), before);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('publication stamping is confined to the complete isolated npm input set', () => {
  const f = fixture();
  try {
    const manifests = Object.values(f.version.packages).map((entry) => `${entry.dir}/package.json`);
    const paths = ['version.json', 'package-lock.json', ...manifests];
    const before = paths.map((path) => readFileSync(join(f.source, path)));
    const result = f.run('stage', f.stage);
    assert.equal(result.status, 0, result.stderr);
    const stamp = spawnSync(process.execPath, [join(f.stage, 'packages/typescript/scripts/stamp-versions.mjs'), f.version.version], { encoding: 'utf8' });
    assert.equal(stamp.status, 0, stamp.stderr);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(join(f.source, path)), before[index], path));
    for (const entry of Object.values(f.version.packages).filter((entry) => entry.publish)) {
      assert.equal(existsSync(join(f.stage, entry.dir, 'package.json')), true);
    }
    assert.equal(existsSync(join(f.source, '.npm-stage')), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
