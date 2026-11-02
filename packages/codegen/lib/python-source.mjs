// python-source.mjs — what the generators of committed Python share: the
// banner that marks a module as generated, a string as Python writes one, a
// comment wrapped to the line, and a constant's name.

/** The lines that open a generated module: what it is generated from, and how. */
export function pyBanner(source, script) {
  return `# Generated from ${source}; do not edit.\n# Regenerate: node ${script}\n`;
}

/** `value` as a Python string literal. JSON's escapes are all Python's. */
export const pyString = (value) => JSON.stringify(value);

/** `text` as `#` comment lines, wrapped at `width` columns, behind `indent`. */
export function pyComment(text, indent = '', width = 96) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== '' && `${indent}# ${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => `${indent}# ${l}`).join('\n');
}

/** `text` as a docstring behind `indent`: one line when it fits, wrapped otherwise. */
export function pyDocstring(text, indent = '', width = 96) {
  const safe = text.replaceAll('\\', '\\\\').replaceAll('"""', '\\"\\"\\"');
  const words = safe.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line !== '' && `${indent}${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  // A docstring that ends in a quote would close early.
  const closes = (last) => (last.endsWith('"') ? `${last} ` : last);
  if (lines.length === 1 && `${indent}"""${lines[0]}"""`.length <= width) return `${indent}"""${closes(lines[0])}"""`;
  return `${indent}"""${lines[0]}\n${lines.slice(1).map((l) => `${indent}${l}`).join('\n')}${lines.length > 1 ? '\n' : ''}${indent}"""`;
}

/** `emitRetry` → `EMIT_RETRY`; `mark:delegate-timeout` → `MARK_DELEGATE_TIMEOUT`. */
export const pyConstant = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();

/** `initialDelayMs` → `initial_delay_ms`. */
export const pySnake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
