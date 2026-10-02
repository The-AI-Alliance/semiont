/**
 * The media-type registry's generator refuses a registry that cannot be meant,
 * and the rules read from the registry do what the shared cases state.
 *
 * specs/src/media-types/registry.json is the authority every SDK generates its
 * table from, so a generated row cannot drift from it. What is left to hold is
 * the registry itself (each case hands the generator the committed one with
 * one fault and expects a refusal that names it) and the rules each SDK
 * writes over the table, which specs/src/media-types/cases.json states once
 * for all of them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_TYPES, cloneFormat, isSupportedMediaType, mediaTypeForExtension } from '../media-types';
import { deriveStorageUri, storageFileName } from '../storage-uri';

const at = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const GENERATOR = at('scripts/spec/generate-media-types.mjs');
const TABLE = at('specs/src/media-types/registry.json');
const ENUM = at('specs/src/components/schemas/SupportedMediaType.json');
const CASES = at('specs/src/media-types/cases.json');

interface Row {
  mediaType: string;
  extension: string;
  label?: string;
  render: string;
  authorable: unknown;
  [key: string]: unknown;
}

interface Registry {
  render: string[];
  extensionAliases: Record<string, string>;
  mediaTypes: Row[];
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'media-types-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the generator on the committed registry and enum after `fault` has changed them. */
function generate(fault: (registry: Registry, admitted: string[]) => void): { status: number | null; stderr: string; out: string } {
  const registry = JSON.parse(readFileSync(TABLE, 'utf8')) as Registry;
  const schema = JSON.parse(readFileSync(ENUM, 'utf8')) as { enum: string[] };
  fault(registry, schema.enum);
  const tablePath = join(dir, 'registry.json');
  const enumPath = join(dir, 'SupportedMediaType.json');
  const out = join(dir, 'media-types.ts');
  writeFileSync(tablePath, JSON.stringify(registry));
  writeFileSync(enumPath, JSON.stringify(schema));
  const run = spawnSync(process.execPath, [GENERATOR, '--table', tablePath, '--enum', enumPath, '--out', out], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr, out };
}

const row = (registry: Registry, mediaType: string): Row => {
  const found = registry.mediaTypes.find((r) => r.mediaType === mediaType);
  if (!found) throw new Error(`the committed registry has no ${mediaType}`);
  return found;
};

describe('the media-type registry generator', () => {
  it('accepts the committed registry, writing a row per type in its order', () => {
    const run = generate(() => {});
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const generated = readFileSync(run.out, 'utf8');
    expect(generated).toContain(
      "  'text/markdown': { extension: '.md', label: 'Markdown', render: 'text', anchoring: 'text-selector', textSource: 'decode', authorable: true, uploadable: true, generatable: true },",
    );
    expect(generated).toContain("export type TextSource = 'decode' | 'pdf-text-layer' | 'none';");
    expect(generated).toContain("  '.markdown': '.md',");
    const stated = (JSON.parse(readFileSync(TABLE, 'utf8')) as Registry).mediaTypes.map((r) => r.mediaType);
    expect(Object.keys(MEDIA_TYPES)).toEqual(stated);
  });

  it('refuses a type stated twice', () => {
    const run = generate((r) => {
      r.mediaTypes.push({ ...row(r, 'text/plain') });
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('text/plain is stated twice');
  });

  it('refuses a type that is not a base media type', () => {
    for (const mediaType of ['Text/Plain', 'text/plain; charset=utf-8']) {
      const run = generate((r) => {
        row(r, 'text/plain').mediaType = mediaType;
      });
      expect(run.status, mediaType).toBe(1);
      expect(run.stderr).toContain('is not a base media type');
    }
  });

  it('refuses a row the API does not admit', () => {
    const run = generate((r) => {
      r.mediaTypes.push({ ...row(r, 'text/plain'), mediaType: 'text/x-unheard-of' });
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('text/x-unheard-of has a row here and is not in the SupportedMediaType schema');
  });

  it('refuses a type the API admits that has no row', () => {
    const run = generate((_, admitted) => {
      admitted.push('text/x-unheard-of');
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('text/x-unheard-of is in the SupportedMediaType schema and has no row here');
  });

  it('refuses a capability outside its vocabulary', () => {
    const run = generate((r) => {
      row(r, 'application/pdf').render = 'hologram';
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`application/pdf's render is "hologram"`);
  });

  it('refuses a row that does not say whether it is authorable', () => {
    for (const value of [undefined, 'true', 1]) {
      const run = generate((r) => {
        row(r, 'text/html').authorable = value;
      });
      expect(run.status, String(value)).toBe(1);
      expect(run.stderr).toContain('text/html does not say whether it is authorable');
    }
  });

  it('refuses an extension that is not a dot and a lower-case name', () => {
    for (const extension of ['md', '.MD', '.', '.tar.gz']) {
      const run = generate((r) => {
        row(r, 'text/markdown').extension = extension;
      });
      expect(run.status, extension).toBe(1);
      expect(run.stderr).toContain("text/markdown's extension is");
    }
  });

  it('refuses a row with no label, and one that states what no generator reads', () => {
    const unlabelled = generate((r) => {
      delete row(r, 'text/markdown').label;
    });
    expect(unlabelled.status).toBe(1);
    expect(unlabelled.stderr).toContain('text/markdown has no label');

    const extra = generate((r) => {
      row(r, 'text/markdown')['editable'] = true;
    });
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain('text/markdown states editable, which no generator reads');
  });

  it('refuses a vocabulary that states a word twice', () => {
    const run = generate((r) => {
      r.render.push('text');
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('render states a word twice');
  });

  it('refuses an alias of an extension no row states, and one that is a row\'s own', () => {
    const nowhere = generate((r) => {
      r.extensionAliases['.mdown'] = '.mdx';
    });
    expect(nowhere.status).toBe(1);
    expect(nowhere.stderr).toContain('.mdown is read as ".mdx", which no row states');

    const shadowed = generate((r) => {
      r.extensionAliases['.txt'] = '.md';
    });
    expect(shadowed.status).toBe(1);
    expect(shadowed.stderr).toContain(".txt is an alias and a row's own extension");
  });
});

interface Cases {
  cloneFormat: Array<{ why: string; source: string | null; format: string }>;
  storageFileName: Array<{ why: string; name: string; format: string; fileName: string }>;
}

describe('the rules read from the registry, as every SDK runs them', () => {
  const cases = JSON.parse(readFileSync(CASES, 'utf8')) as Cases;

  it.each(cases.cloneFormat)('a clone of $source: $why', ({ source, format }) => {
    expect(cloneFormat(source ?? undefined)).toBe(format);
  });

  it.each(cases.storageFileName)('$name as $format: $why', ({ name, format, fileName }) => {
    if (!isSupportedMediaType(format)) throw new Error(`the case's format ${format} has no row`);
    expect(storageFileName(name, format)).toBe(fileName);
    expect(deriveStorageUri(name, format)).toBe(`file://${fileName}`);
  });

  it('reads an alias as the extension it is another spelling of', () => {
    const registry = JSON.parse(readFileSync(TABLE, 'utf8')) as Registry;
    const aliases = Object.entries(registry.extensionAliases);
    expect(aliases.length).toBeGreaterThan(0);
    for (const [alias, extension] of aliases) {
      expect(mediaTypeForExtension(alias), alias).toBe(mediaTypeForExtension(extension));
      expect(mediaTypeForExtension(alias), alias).toBeDefined();
    }
  });
});
