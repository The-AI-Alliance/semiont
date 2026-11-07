/** UTF-8 bytes expressed without OCaml/JSON escape ambiguity. */
export function ocamlString(value) {
  return '"' + [...Buffer.from(value)].map((byte) =>
    byte >= 32 && byte < 127 && byte !== 34 && byte !== 92
      ? String.fromCharCode(byte) : '\\' + String(byte).padStart(3, '0')).join('') + '"';
}
