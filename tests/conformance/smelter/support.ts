/**
 * What the cases of this suite share: the documents they give a Smelter.
 *
 * A PDF here is written out object by object, with the byte offsets its
 * cross-reference table states, so the suite needs no library to make one and
 * every implementation is given the same bytes. Its text is drawn with one of
 * the fonts every reader has, in characters of ASCII alone.
 */

/** A string as a PDF writes one between parentheses. */
const literal = (text: string): string => text.replace(/[\\()]/g, (mark) => `\\${mark}`);

/**
 * A PDF with one page for each entry of `pages`, each page drawing its lines
 * of text from the top of the page down. A page given no lines draws nothing:
 * it has no text of its own and no image, and a document of such pages alone
 * is one a Smelter declines as having no text layer.
 */
export function pdfOf(pages: readonly (readonly string[])[]): Buffer {
  const pageNumbers = pages.map((_, at) => 4 + at * 2);
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((lines, at) => {
    const drawn = lines.length === 0 ? '' : ['BT', '/F1 12 Tf', '16 TL', '72 720 Td', ...lines.map((line) => `(${literal(line)}) Tj T*`), 'ET'].join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + at * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(drawn, 'latin1')} >>\nstream\n${drawn}\nendstream`);
  });

  let written = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, at) => {
    offsets.push(Buffer.byteLength(written, 'latin1'));
    written += `${at + 1} 0 obj\n${object}\nendobj\n`;
  });
  const table = Buffer.byteLength(written, 'latin1');
  written += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  written += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  written += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`;
  return Buffer.from(written, 'latin1');
}

/** Bytes that are no PDF, to be recorded as one: a Smelter declines them as corrupt. */
export const NOT_A_PDF = Buffer.from('not a pdf at all', 'utf8');
