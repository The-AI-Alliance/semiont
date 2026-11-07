import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { ocamlString } from '../lib/ocaml-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = 'protocol/specs/src/components/schemas';
const check = process.argv.includes('--check');
const enums = readdirSync(resolve(root, source)).filter((file) => file.endsWith('.json')).sort()
  .flatMap((file) => {
    const schema = JSON.parse(readFileSync(resolve(root, source, file), 'utf8'));
    if (schema.type !== 'string' || schema.enum === undefined) return [];
    const name = file.slice(0, -5).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const module = name[0].toUpperCase() + name.slice(1);
    const variants = schema.enum.map((value) => {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9./+-]*$/i.test(value)) {
        throw new Error(`${file}: unsupported enum value ${JSON.stringify(value)}`);
      }
      const constructor = value.replaceAll('+', '_plus').replace(/[./-]/g, '_');
      return { constructor: constructor[0].toUpperCase() + constructor.slice(1), literal: ocamlString(value) };
    });
    if (variants.length === 0 || new Set(variants.map(({ constructor }) => constructor)).size !== variants.length) {
      throw new Error(`${file}: empty enum or colliding constructor names`);
    }
    return [{ module, variants }];
  });

const header = `(* Generated from string enums in ${source}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n`;
const type = (variants) => `type t = ${variants.map(({ constructor }) => constructor).join(' | ')}`;
const impl = enums.map(({ module, variants }) => [
  `module ${module} = struct`, `  ${type(variants)}`,
  '  let to_string = function',
  ...variants.map(({ constructor, literal }) => `    | ${constructor} -> ${literal}`),
  '  let of_string = function',
  ...variants.map(({ constructor, literal }) => `    | ${literal} -> Some ${constructor}`),
  '    | _ -> None', 'end',
].join('\n'));
const api = enums.map(({ module, variants }) => [
  `module ${module} : sig`, `  ${type(variants)}`,
  '  val to_string : t -> string', '  val of_string : string -> t option', 'end',
].join('\n'));
const tests = enums.map(({ module, variants }) => [
  `  let module Model = Semiont.Enums.${module} in`,
  ...variants.flatMap(({ constructor, literal }) => [
    `  Alcotest.(check string) "${module} encode" ${literal} (Model.to_string Model.${constructor});`,
    `  Alcotest.(check bool) "${module} decode" true (Model.of_string ${literal} = Some Model.${constructor});`,
  ]),
  `  Alcotest.(check bool) "${module} rejects unknown values" true (Model.of_string "" = None);`,
].join('\n'));

for (const [file, contents] of [
  ['lib/enums.ml', impl.join('\n\n')],
  ['lib/enums.mli', api.join('\n\n')],
  ['test/enums_cases.ml', `let () =\n${tests.join('\n')}\n  ()`],
]) {
  writeOrCheck(root, resolve(root, 'packages/ocaml/sdk', file), `${header}\n${contents}\n`, check);
}
