import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredShapes } from '../schemas/required-shapes.mjs';
import { readIdentifierKinds } from '../schemas/identifier-kinds.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { ocamlString } from '../lib/ocaml-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const check = process.argv.includes('--check');
const refuse = (message) => { throw new Error(message); };
const { shapes } = readRequiredShapes(root, refuse);
const { kinds } = JSON.parse(readFileSync(resolve(root, 'protocol/specs/src/identifiers/kinds.json'), 'utf8'));
const definitions = readIdentifierKinds(
  resolve(root, 'protocol/specs/src/identifiers/kinds.json'),
  resolve(root, 'protocol/specs/src/components/schemas'), refuse);
const moduleName = (schema) => schema.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/^./, (c) => c.toUpperCase());
const header = '(* Generated from protocol identifier kinds and shared required shapes. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n';
const implementations = [];
const signatures = [];
const tests = [];
for (const [index, definition] of definitions.entries()) {
  const kind = kinds[index];
  if (kind.schema !== definition.name) refuse('Identifier cases and definitions disagree');
  const shape = shapes.get(kind.schema);
  if (!shape || Object.keys(shape).sort().join(',') !== 'kinds,pattern' || shape.kinds.join(',') !== 'string') {
    refuse(`${kind.schema}: identifier generator must account for its entire shape`);
  }
  const name = moduleName(kind.schema);
  const steps = shape.pattern.map(({ of, min, max }) =>
    `([${of.map(([a, b]) => `(${a}, ${b})`).join('; ')}], ${min}, ${max === undefined ? 'None' : `Some ${max}`})`).join('; ');
  implementations.push(`module ${name} = struct
  type t = string
  let of_string value =
    if Pattern.matches [${steps}] value then Ok value
    else Error ${ocamlString(`Invalid ${kind.schema}`)}
  let to_string value = value
  let compare = String.compare
  let equal = String.equal
end\n`);
  signatures.push(`module ${name} : sig
  type t
  val of_string : string -> (t, string) result
  val to_string : t -> string
  val compare : t -> t -> int
  val equal : t -> t -> bool
end\n`);
  for (const [group, accepted] of [['accepts', true], ['refuses', false]]) {
    for (const { id, why } of kind[group]) {
      tests.push(`  Alcotest.(check bool) ${ocamlString(`${kind.schema}: ${why}`)} ${accepted}
    (Result.is_ok (Semiont.Identifiers.${name}.of_string ${ocamlString(id)}));`);
    }
  }
}
for (const [path, body] of [
  ['lib/identifiers.ml', implementations.join('\n')],
  ['lib/identifiers.mli', signatures.join('\n')],
  ['test/identifiers.ml', `let () =\n${tests.join('\n')}\n  ()\n`],
]) writeOrCheck(root, resolve(root, 'packages/ocaml/sdk', path), header + body, check);
