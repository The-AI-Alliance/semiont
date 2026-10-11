/**
 * What deriving a PDF's text comes to, held to
 * specs/src/smelter/extraction-cases.json: the table every Smelter runs, so
 * that a document is sorted into the same class, read the same way and
 * declined by the same name, whoever reads it.
 *
 * Nothing is stood in for: the reader and the OCR engine are the ones the
 * Smelter runs, since a table run against a stand-in holds nothing. The
 * fixtures are the generator's (vitest globalSetup).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { textOffsets } from '@semiont/core';
import { derivingExtractorFor, type ExtractedText, type ExtractionDecline } from '../text-extractor';
import type { AnchoredTextStore } from '../anchored-text-store';
import { MAX_PDF_BYTES } from '../pdf-extractor';

/** A document that is read, and what the table states of its text. */
interface Read {
  why: string;
  fixture: string;
  pdfClass: NonNullable<ExtractedText['pdfClass']>;
  method: ExtractedText['method'];
  unreadPages?: number[];
  pagesWithItems: number;
  words: string[];
  onPage?: Record<string, number>;
  absent?: string[];
  rows?: string[][];
}

/** A document that is declined, and the name it is declined by. */
interface Declined {
  why: string;
  fixture?: string;
  bytes?: { utf8?: string; length?: number };
  declined: ExtractionDecline['declined'];
}

type Case = Read | Declined;

const REPO = new URL('../../../../', import.meta.url);
const table: { fixtures: string; largestPdfBytes: number; cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/smelter/extraction-cases.json', import.meta.url), 'utf8'),
);

const TABLE_MEMBERS = ['$comment', 'cases', 'fixtures', 'largestPdfBytes'];
const READ_MEMBERS = ['why', 'fixture', 'pdfClass', 'method', 'unreadPages', 'pagesWithItems', 'words', 'onPage', 'absent', 'rows'];
const DECLINED_MEMBERS = ['why', 'fixture', 'bytes', 'declined'];
const BYTES_MEMBERS = ['utf8', 'length'];

/** The members of `stated` that are none of `known`: what this runner would pass over. */
const membersOutside = (stated: object, known: string[]): string[] =>
  Object.keys(stated).filter((member) => !known.includes(member));

/** Whether `line` has every one of `cells`, each after the one before it. */
function hasInOrder(line: string, cells: string[]): boolean {
  let from = 0;
  for (const cell of cells) {
    const at = line.indexOf(cell, from);
    if (at === -1) return false;
    from = at + cell.length;
  }
  return true;
}

/** These cases are about what is derived, so the store keeps nothing. */
const KEEPS_NOTHING: AnchoredTextStore = { read: async () => null, write: async () => {}, list: async () => [] };

/** The document a case is of: a fixture's bytes, or the bytes the case says how to make. */
function documentOf(stated: Case): Buffer {
  if (stated.fixture !== undefined) return readFileSync(new URL(`${table.fixtures}/${stated.fixture}`, REPO));
  const bytes = 'bytes' in stated ? stated.bytes : undefined;
  if (bytes === undefined) throw new Error(`${stated.why}: neither a fixture nor bytes`);
  const { utf8, length } = bytes;
  if (utf8 !== undefined) return Buffer.from(utf8, 'utf8');
  if (length === undefined) throw new Error(`${stated.why}: bytes made in a way this runner does not know`);
  // A document of that many bytes with none of them made. It is declined by
  // its size before a byte is read, and allocating 200 MB to ask a question
  // about a number would only make the suite slow, and fragile under a
  // memory limit.
  const unmade = Buffer.alloc(0);
  Object.defineProperty(unmade, 'length', { value: length });
  return unmade;
}

describe('deriving a PDF\'s text (specs/src/smelter/extraction-cases.json)', () => {
  it('has cases, each of one document that is read or declined, and no member this runner does not read', () => {
    expect(Object.keys(table).sort()).toStrictEqual(TABLE_MEMBERS);
    expect(table.cases.length).toBeGreaterThan(0);
    for (const stated of table.cases) {
      expect(typeof stated.why).toBe('string');
      if ('declined' in stated) {
        expect(membersOutside(stated, DECLINED_MEMBERS), stated.why).toStrictEqual([]);
        expect([stated.fixture, stated.bytes].filter((given) => given !== undefined), stated.why).toHaveLength(1);
        if (stated.bytes !== undefined) {
          expect(membersOutside(stated.bytes, BYTES_MEMBERS), stated.why).toStrictEqual([]);
          expect(Object.keys(stated.bytes), stated.why).toHaveLength(1);
        }
      } else {
        expect(membersOutside(stated, READ_MEMBERS), stated.why).toStrictEqual([]);
        expect(Object.keys(stated), stated.why)
          .toEqual(expect.arrayContaining(['fixture', 'pdfClass', 'method', 'pagesWithItems', 'words']));
        expect(stated.words.length, stated.why).toBeGreaterThan(0);
        // A word given a page is one of the words the text must have.
        expect(stated.words, stated.why).toEqual(expect.arrayContaining(Object.keys(stated.onPage ?? {})));
        // A row of no cells is on every line, and holds nothing.
        expect((stated.rows ?? []).filter((row) => row.length === 0), stated.why).toStrictEqual([]);
      }
    }
  });

  it('has a case of every fixture, and one of each', () => {
    const made = readdirSync(new URL(`${table.fixtures}/`, REPO)).filter((name) => name.endsWith('.pdf'));
    const stated = table.cases.flatMap((given) => (given.fixture === undefined ? [] : [given.fixture]));
    expect(stated.sort()).toStrictEqual(made.sort());
  });

  it('takes the table\'s bound as the largest PDF it reads', () => {
    expect(MAX_PDF_BYTES).toBe(table.largestPdfBytes);
  });

  for (const stated of table.cases) {
    // Long enough for the OCR engine to start and to read a page's images,
    // where a case comes to that.
    it(stated.why, { timeout: 60_000 }, async () => {
      const outcome = await derivingExtractorFor('application/pdf')!
        .extract(documentOf(stated), 'application/pdf', { key: 'extraction-cases', store: KEEPS_NOTHING });

      if ('declined' in stated) {
        expect(outcome).toEqual({ kind: 'declined', declined: stated.declined });
        return;
      }
      if (outcome.kind === 'declined') throw new Error(`declined as ${outcome.declined}`);

      expect(outcome.pdfClass, 'pdfClass').toBe(stated.pdfClass);
      expect(outcome.method, 'method').toBe(stated.method);
      expect(outcome.unreadPages, 'unreadPages').toStrictEqual(stated.unreadPages);

      const items = outcome.items ?? [];
      expect(new Set(items.map((item) => item.page)).size, 'pagesWithItems').toBe(stated.pagesWithItems);
      for (const word of stated.words) expect(outcome.text, `the word ${word}`).toContain(word);
      for (const unwanted of stated.absent ?? []) expect(outcome.text, `the absent ${unwanted}`).not.toContain(unwanted);

      const lines = outcome.text.split('\n');
      for (const row of stated.rows ?? []) {
        expect(lines.some((line) => hasInOrder(line, row)), `one line with the row ${row.join(', ')}`).toBe(true);
      }

      // An item's offsets count code points: this is where they meet the string.
      const offsets = textOffsets(outcome.text);
      for (const [word, page] of Object.entries(stated.onPage ?? {})) {
        const having = items.filter((item) =>
          item.page === page && outcome.text.slice(offsets.indexAt(item.start), offsets.indexAt(item.end)).includes(word));
        expect(having.length, `items on page ${page} that have the word ${word}`).toBeGreaterThan(0);
      }
    });
  }
});
