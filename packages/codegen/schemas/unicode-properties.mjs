// unicode-properties.mjs — the code points Unicode gives a property, as this
// Node's Unicode data has them: what the SDKs that cannot read the property
// from their own runtime are generated from.
//
//   packages/codegen/schemas/generate-annotation-adapters-haskell.mjs → packages/haskell/sdk/generated/Semiont/Internal/Generated/UnicodeCase.hs
//   packages/codegen/schemas/generate-unicode-case.mjs                → packages/csharp/sdk/generators/Semiont.Generator/unicode-case.json,
//                                                                       packages/kotlin/sdk/src/codegen/unicode-case.json and
//                                                                       packages/go/sdk/annotations/unicodecase_gen.go

/** The Unicode version of this Node's data. */
export const unicodeVersion = process.versions.unicode;

/** Every scalar value, in order: the code points but the surrogates. */
export function* scalars() {
  for (let code = 0; code <= 0x10ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    yield code;
  }
}

/** The scalar values `property` (a Unicode property escape) matches, as ascending `[first, last]` ranges. */
export function propertyRanges(property) {
  const ranges = [];
  for (const code of scalars()) {
    if (!property.test(String.fromCodePoint(code))) continue;
    const last = ranges.at(-1);
    if (last && last[1] + 1 === code) last[1] = code;
    else ranges.push([code, code]);
  }
  return ranges;
}
