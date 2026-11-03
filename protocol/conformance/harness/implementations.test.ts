/**
 * The implementations file: how a run names what it tests, without editing
 * the kit. A file anywhere is read, its paths resolved against its own
 * directory, and anything else refused before a suite starts.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readImplementations } from './implementations';
import { REPO_ROOT } from './paths';

const SHIPPED = fileURLToPath(new URL('../semiont.implementations.json', import.meta.url));

/** A file of `content` in a directory of its own, and that directory. */
function written(content: string): { file: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'implementations-'));
  const file = join(directory, 'mine.json');
  writeFileSync(file, content);
  return { file, directory };
}

/** A complete file naming one build of each, under `prefix`. */
function complete(prefix: string): Record<string, unknown> {
  return {
    gateway: [`${prefix}gateway`],
    dispatcher: [`${prefix}dispatcher`],
    archivist: [`${prefix}archivist`],
    sdks: { mine: { wire: ['node', `${prefix}wire.js`], live: { command: [`${prefix}live`], tier: 'fleet' }, exempt: { 'attach-gate': 'no attach' } } },
    workerServices: { mine: [`${prefix}worker`, '-P'] },
    weaverServices: { mine: { command: [`${prefix}weaver`], healthPort: 24999 } },
    smelterServices: {},
    librarianServices: {},
  };
}

describe('the implementations file', () => {
  it('Semiont\'s own file is of the shape, and every path it names is in the repository', () => {
    const implementations = readImplementations(['--implementations', SHIPPED]);
    const commands = [
      implementations.gateway,
      implementations.dispatcher,
      implementations.archivist,
      ...Object.values(implementations.sdks).flatMap((drivers) => [drivers.wire, drivers.live?.command, drivers.worker]),
      ...Object.values(implementations.workerServices),
      ...Object.values(implementations.weaverServices).map((service) => service.command),
      ...Object.values(implementations.smelterServices),
      ...Object.values(implementations.librarianServices),
    ];
    const paths = commands.flatMap((command) => command ?? []).filter((argument) => isAbsolute(argument));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(relative(REPO_ROOT, path).startsWith('..'), path).toBe(false);
  });

  it('resolves an argument that starts with ./ or ../ against the file\'s own directory, and passes any other as written', () => {
    const { file, directory } = written(JSON.stringify(complete('./bin/')));
    const implementations = readImplementations(['vitest', 'run', '--', '--implementations', file]);
    expect(implementations.gateway).toEqual([join(directory, 'bin/gateway')]);
    expect(implementations.sdks['mine']?.wire).toEqual(['node', join(directory, 'bin/wire.js')]);
    expect(implementations.workerServices['mine']).toEqual([join(directory, 'bin/worker'), '-P']);
    expect(implementations.weaverServices['mine']).toEqual({ command: [join(directory, 'bin/weaver')], healthPort: 24999 });
    expect(implementations.sdks['mine']?.exempt).toEqual({ 'attach-gate': 'no attach' });

    const above = readImplementations(['--implementations', written(JSON.stringify(complete('../elsewhere/'))).file]);
    expect(above.dispatcher).toEqual([join(directory, '..', 'elsewhere/dispatcher')]);
  });

  it('refuses a run that names no file, names one twice, or gives none after the flag', () => {
    const { file } = written(JSON.stringify(complete('/opt/')));
    expect(() => readImplementations(['vitest', 'run'])).toThrow(/names none/);
    expect(() => readImplementations(['--implementations', file, '--implementations', file])).toThrow(/names 2/);
    expect(() => readImplementations(['--implementations'])).toThrow(/names no file/);
    expect(() => readImplementations(['--implementations', '--project'])).toThrow(/names no file/);
  });

  it('refuses a file that is not JSON, lacks a key, has one it does not know, or gives a tier that is none', () => {
    expect(() => readImplementations(['--implementations', written('{ "gateway": [').file])).toThrow(/cannot be read as JSON/);

    const lacking = complete('/opt/');
    delete lacking['gateway'];
    expect(() => readImplementations(['--implementations', written(JSON.stringify(lacking)).file])).toThrow(/is not of the shape/);

    const unknown = { ...complete('/opt/'), gatway: ['/opt/gateway'] };
    expect(() => readImplementations(['--implementations', written(JSON.stringify(unknown)).file])).toThrow(/is not of the shape/);

    const tier = { ...complete('/opt/'), sdks: { mine: { live: { command: ['/opt/live'], tier: 'all' } } } };
    expect(() => readImplementations(['--implementations', written(JSON.stringify(tier)).file])).toThrow(/is not of the shape/);
  });
});
