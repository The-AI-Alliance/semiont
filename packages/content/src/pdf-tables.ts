/**
 * Table reconstruction from PDF text-layer geometry (SMELTER-MEDIA-TYPES
 * class D).
 *
 * A PDF has no table structure — only positioned text runs. Read in reading
 * order a grid's cells interleave, so a row's values scatter across chunks
 * and semantic recall over an outcome table returns nothing useful. This
 * module recovers the grid from the geometry the reader already carries
 * (`PdfTextItem.x/y/width/height`), then renders markdown rows so a row's
 * cells stay adjacent for the shared chunker. No new dependency: the
 * clustering is the same arithmetic a table library would do, over data we
 * already have.
 *
 * PRECISION OVER RECALL. A false positive scrambles prose into a fake table;
 * a false negative merely falls back to class A, which is Phase 1 behavior.
 * So detection demands a strict, regular grid — every row the same cell
 * count, every column aligned — and declines everything else.
 */

import type { PdfTextItem } from './pdf-text-layer';

/** A reconstructed cell: its text plus the bounding box of its runs. */
export interface TableCell {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A header row plus at least two data rows — below this, prose in columns
 *  is indistinguishable from a table. */
const MIN_ROWS = 3;
const MIN_COLUMNS = 2;

/** Row grouping tolerance, as a fraction of text height: runs whose
 *  baselines differ by less than half a line belong to one row. */
const ROW_TOLERANCE = 0.5;
/** Horizontal gap that separates cells, as a fraction of text height. Word
 *  spaces are far narrower; column gutters are far wider. */
const CELL_GAP = 0.8;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Group runs into visual rows, top of page first. */
function groupRows(items: PdfTextItem[], tolerance: number): PdfTextItem[][] {
  const rows: PdfTextItem[][] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }
  return rows;
}

function toCell(runs: PdfTextItem[], text: string): TableCell {
  const x = Math.min(...runs.map((r) => r.x));
  const y = Math.min(...runs.map((r) => r.y));
  const right = Math.max(...runs.map((r) => r.x + r.width));
  const top = Math.max(...runs.map((r) => r.y + r.height));
  return {
    text: runs.map((r) => text.slice(r.start, r.end)).join(' ').trim(),
    x,
    y,
    width: right - x,
    height: top - y,
  };
}

/** Split a row into cells: runs closer than a gutter belong to one cell. */
function toCells(row: PdfTextItem[], gap: number, text: string): TableCell[] {
  const cells: TableCell[] = [];
  let current: PdfTextItem[] = [];
  for (const item of [...row].sort((a, b) => a.x - b.x)) {
    const previous = current[current.length - 1];
    if (previous && item.x - (previous.x + previous.width) > gap) {
      cells.push(toCell(current, text));
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) cells.push(toCell(current, text));
  return cells;
}

/**
 * Recover a grid from one page's runs, or null when the page is not a
 * regular table.
 */
export function detectTable(items: PdfTextItem[], text: string): TableCell[][] | null {
  if (items.length === 0) return null;
  const unit = median(items.map((i) => i.height).filter((h) => h > 0)) || 12;

  const rows = groupRows(items, unit * ROW_TOLERANCE).map((row) => toCells(row, unit * CELL_GAP, text));
  if (rows.length < MIN_ROWS) return null;

  const columnCount = rows[0]!.length;
  if (columnCount < MIN_COLUMNS) return null;
  if (!rows.every((row) => row.length === columnCount)) return null;

  // Every column must start at the same offset down the page; ragged left
  // edges mean prose that happens to wrap into blocks, not a grid.
  for (let column = 0; column < columnCount; column++) {
    const lefts = rows.map((row) => row[column]!.x);
    if (Math.max(...lefts) - Math.min(...lefts) > unit) return null;
  }
  if (rows.some((row) => row.some((cell) => cell.text.length === 0))) return null;

  return rows;
}

/**
 * Render a grid as markdown rows, anchoring every cell to the geometry it
 * came from. `offset` is where this text lands in the assembled document, so
 * the returned blocks index the final string.
 */
export function renderTable(
  rows: TableCell[][],
  page: number,
  offset: number,
): { text: string; items: PdfTextItem[] } {
  let text = '';
  const items: PdfTextItem[] = [];
  rows.forEach((row, rowIndex) => {
    text += '|';
    for (const cell of row) {
      text += ' ';
      const start = offset + text.length;
      text += cell.text;
      items.push({
        start,
        end: offset + text.length,
        page,
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
      });
      text += ' |';
    }
    text += '\n';
    // Markdown needs the delimiter row for the header to read as a table.
    if (rowIndex === 0) text += `|${' --- |'.repeat(row.length)}\n`;
  });
  return { text, items };
}
