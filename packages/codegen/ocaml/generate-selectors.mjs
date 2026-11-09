import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { ocamlString } from '../lib/ocaml-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = 'protocol/specs/src/components/schemas';
const read = (file) => JSON.parse(readFileSync(resolve(root, source, file), 'utf8'));
const schema = read('Selector.json');
const { propertyName: tag, mapping } = schema.discriminator;
const refs = new Set(schema.oneOf.map((branch) => branch.$ref));
if (refs.size !== schema.oneOf.length || refs.size !== Object.keys(mapping).length) {
  throw new Error('Selector discriminator does not cover its branches one to one');
}
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const variants = Object.entries(mapping).map(([constructor, ref]) => {
  if (!refs.delete(ref) || !/^[A-Z][A-Za-z0-9]*$/.test(constructor)) throw new Error(`Unsupported selector branch ${constructor}`);
  const { type, properties, required, additionalProperties } = read(ref);
  if (type !== 'object' || (additionalProperties !== undefined && additionalProperties !== true) ||
      !required.includes(tag) || JSON.stringify(properties[tag].enum) !== JSON.stringify([constructor])) {
    throw new Error(`${ref} is no supported open selector object`);
  }
  const fields = Object.entries(properties).filter(([name]) => name !== tag).map(([name, field]) => {
    const { type, minimum, description, example, ...other } = field;
    if (Object.keys(other).length || !['string', 'integer'].includes(type) ||
        (minimum !== undefined && (type !== 'integer' || !Number.isSafeInteger(minimum)))) {
      throw new Error(`Unsupported selector field ${ref}:${name}`);
    }
    return {
      name: ocamlString(name), label: name === 'end' ? 'end_' : snake(name),
      reader: type === 'string' ? 'string' : minimum === undefined ? 'integer' : `(integer_at_least ${minimum})`,
      type: type === 'string' ? 'string' : 'Z.t',
      writer: type === 'string' ? 'json_string' : 'json_integer',
      optional: !required.includes(name),
    };
  });
  const reading = [...fields.filter(({ optional }) => !optional), ...fields.filter(({ optional }) => optional)];
  return { constructor, fields, reading, name: snake(constructor) };
});

const types = [
  ...variants.map(({ name, fields }) => `type ${name} = { ${fields.map(({ label, type, optional }) =>
    `${label} : ${type}${optional ? ' option' : ''}`).join('; ')}; extra : (string * Yojson.Safe.t) list }`),
  `type t = ${variants.map(({ constructor, name }) => `${constructor} of ${name}`).join(' | ')}`,
  'type fault = { member : string; reason : [ `Lacks | `Malformed ] }',
];
const helpers = [
  'let ( let* ) = Result.bind',
  'let malformed member = Error { member; reason = `Malformed }',
  'let string member = function `String value -> Ok value | _ -> malformed member',
  'let integer member = function',
  '  | `Int value -> Ok (Z.of_int value)',
  '  | `Intlit value ->',
  '      (try',
  '         let number = Z.of_string value in',
  '         if Z.to_string number = value || value = "-0" then Ok number else malformed member',
  '       with Invalid_argument _ -> malformed member)',
  '  | _ -> malformed member',
  'let integer_at_least minimum member json =',
  '  let* value = integer member json in',
  '  if Z.geq value (Z.of_int minimum) then Ok value else malformed member',
  'let required read member fields =',
  '  match List.assoc_opt member fields with',
  '  | None -> Error { member; reason = `Lacks }',
  '  | Some value -> read member value',
  'let optional read member fields =',
  '  match List.assoc_opt member fields with',
  '  | None -> Ok None',
  '  | Some value -> Result.map Option.some (read member value)',
  'let extra names = List.filter (fun (name, _) -> not (List.mem name names))',
  'let json_string value = `String value',
  'let json_integer value = if Z.fits_int value then `Int (Z.to_int value) else `Intlit (Z.to_string value)',
];
const tagName = ocamlString(tag);
const names = (fields) => `[${[tagName, ...fields.map(({ name }) => name)].join('; ')}]`;
const branches = variants.flatMap(({ constructor, fields, reading }) => [
  `    | ${ocamlString(constructor)} ->`,
  ...reading.map(({ label, name, optional, reader }) => `        let* ${label} = ${optional ? 'optional' : 'required'} ${reader} ${name} fields in`),
  `        Ok (${constructor} { ${fields.map(({ label }) => label).join('; ')}; extra = extra ${names(fields)} fields })`,
]);
const encoder = variants.flatMap(({ constructor, fields }) => [
  `  | ${constructor} value ->`,
  `      \`Assoc (List.filter_map Fun.id [Some (${tagName}, \`String ${ocamlString(constructor)});`,
  ...fields.map(({ label, name, optional, writer }) => optional
    ? `        Option.map (fun field -> (${name}, ${writer} field)) value.${label};`
    : `        Some (${name}, ${writer} value.${label});`),
  `      ] @ extra ${names(fields)} value.extra)`,
]);
const impl = [...types, ...helpers, 'let of_json = function', '  | `Assoc fields ->',
  `      let* tag = required string ${tagName} fields in`, '      (match tag with', ...branches,
  `    | _ -> malformed ${tagName})`, '  | _ -> malformed ""', 'let to_json = function', ...encoder];
const api = [...types, 'val of_json : Yojson.Safe.t -> (t, fault) result', 'val to_json : t -> Yojson.Safe.t'];
const header = '(* Generated from Selector.json and its component branches. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n';
for (const [extension, lines] of [['ml', impl], ['mli', api]]) {
  writeOrCheck(root, resolve(root, `packages/ocaml/sdk/lib/selector.${extension}`),
    `${header}\n${lines.join('\n')}\n`, process.argv.includes('--check'));
}
