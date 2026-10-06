// go-source.mjs — what the generators of committed Go share: a comment wrapped
// as gofmt leaves it.

/** `text` as `//` comment lines, wrapped at `width` columns, behind `indent`. */
export function goComment(text, indent = '', width = 78) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== '' && `${indent}// ${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => `${indent}// ${l}`).join('\n');
}
