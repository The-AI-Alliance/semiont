/**
 * The order of two names by code point, which is the order the protocol
 * states wherever it orders names (an annotation id's rule,
 * protocol/specs/src/annotations/id-cases.json, and the table of what each
 * schema requires). A string compares by UTF-16 code unit, and that is
 * another order: it puts a name with a character outside the Basic
 * Multilingual Plane before one with a character from U+E000 to U+FFFF.
 */
export function byCodePoint(a: string, b: string): number {
  const [left, right] = [Array.from(a), Array.from(b)];
  for (let i = 0; i < left.length && i < right.length; i++) {
    const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
