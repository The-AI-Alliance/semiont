#!/usr/bin/env node
// Generate the Python SDK's kinds of id from specs/src/identifiers/kinds.json
// and each kind's schema: a type of its own for each, made only through the
// kind's rule.
//
//   packages/sdk-python/src/semiont/identifiers.py
//
// The reading of the table is identifier-kinds.mjs's, shared with the
// TypeScript generator. The output is committed; `--check` compares without
// writing (the CI drift gate).
//
// `--kinds <path>`, `--schemas <dir>` and `--out <path>` name other inputs
// and another output.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIdentifierKinds } from './identifier-kinds.mjs';
import { writeOrCheck } from './committed-source.mjs';
import { pyBanner, pyDocstring, pyString } from './python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const KINDS = resolve(option('--kinds') ?? resolve(ROOT, 'specs/src/identifiers/kinds.json'));
const SCHEMAS = resolve(option('--schemas') ?? resolve(ROOT, 'specs/src/components/schemas'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/sdk-python/src/semiont/identifiers.py'));
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${KINDS}: ${message}`);
  process.exit(1);
}

const kinds = readIdentifierKinds(KINDS, SCHEMAS, refuse).map((kind) => {
  // Python asks a rule of the whole text (`fullmatch`): `$` in its own regular
  // expressions also matches before a final newline, which the rule refuses.
  // So the pattern has to say it is the whole text, and its anchors are dropped.
  if (!kind.pattern.startsWith('^') || !kind.pattern.endsWith('$') || kind.pattern.endsWith('\\$')) {
    refuse(`${kind.name}'s pattern is not anchored at both ends (^…$), so Python cannot ask it of the whole text`);
  }
  return { ...kind, whole: kind.pattern.slice(1, -1) };
});

const classes = kinds.map(
  ({ name, description, pattern, whole }) => `@final
class ${name}(_Identifier):
${pyDocstring(description, '    ')}

    __slots__ = ()
    PATTERN: ClassVar[str] = ${pyString(pattern)}
    _RULE: ClassVar[re.Pattern[str]] = re.compile(${pyString(whole)})
`,
);

const text = `${pyBanner("specs/src/identifiers/kinds.json and each kind's schema", 'scripts/spec/generate-identifiers-python.mjs')}
"""The kinds of id.

A value of one of these types is text that passed its kind's rule, which is the
schema's pattern. It is made here and nowhere else: by the kind's constructor,
which raises \`InvalidIdentifier\` for text the rule refuses, by \`parse\`, which
answers \`None\` instead, and by decoding, which goes through the same rule. It
is a \`str\`, so it reads as the text it is. One kind is not another: a type
checker refuses a \`ResourceId\` where an \`AnnotationId\` is wanted.
"""

import re
from typing import ClassVar, Final, Self, final

from pydantic import GetCoreSchemaHandler
from pydantic_core import CoreSchema, core_schema

__all__ = [${['InvalidIdentifier', ...kinds.map((kind) => kind.name)].sort().map(pyString).join(', ')}]


@final
class InvalidIdentifier(ValueError):
    """Text that is not an id of the kind it was to be."""

    def __init__(self, kind: str, pattern: str, value: str) -> None:
        super().__init__(f"{value!r} is not a {kind}: it does not match {pattern}")
        self.kind: Final = kind
        self.pattern: Final = pattern
        self.value: Final = value


class _Identifier(str):
    """What the kinds share: text held to a rule, wherever it is made."""

    __slots__ = ()
    PATTERN: ClassVar[str]
    """The kind's rule, as its schema states it."""
    _RULE: ClassVar[re.Pattern[str]]

    def __new__(cls, text: str) -> Self:
        if cls._RULE.fullmatch(text) is None:
            raise InvalidIdentifier(cls.__name__, cls.PATTERN, text)
        return super().__new__(cls, text)

    @classmethod
    def parse(cls, text: str) -> Self | None:
        """\`text\` as this kind of id, or \`None\` when the kind's rule refuses it.

        For where text that is not an id is an ordinary answer and not a fault:
        an address someone typed, a key read from storage.
        """
        return super().__new__(cls, text) if cls._RULE.fullmatch(text) is not None else None

    @classmethod
    def __get_pydantic_core_schema__(cls, source: object, handler: GetCoreSchemaHandler) -> CoreSchema:
        # Decoding goes through the constructor: an id in an answer passed the
        # same rule as one a caller made.
        return core_schema.no_info_after_validator_function(cls, core_schema.str_schema())


${classes.join('\n\n')}`;

writeOrCheck(ROOT, OUT, text, CHECK);
if (!CHECK) console.log(`${kinds.length} kinds of id: ${kinds.map((kind) => kind.name).join(', ')}`);
