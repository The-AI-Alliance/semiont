import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ocamlString } from '../lib/ocaml-source.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const specs = resolve(root, 'protocol/specs/src');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const index = read(resolve(specs, 'openapi.json')).components.schemas;
const schemas = Object.entries(index).map(([name, { $ref }]) => {
  const file = resolve(specs, $ref);
  return { name, file, schema: read(file) };
});
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const componentModule = (name) => {
  const value = snake(name);
  return value[0].toUpperCase() + value.slice(1);
};
const keywords = new Set('and as assert begin class constraint do done downto effect else end exception external false for fun function functor if in include inherit initializer land lazy let lor lsl lsr lxor match method mod module mutable new nonrec object of open or private rec sig struct then to true try type val virtual when while with'.split(' '));
const fieldName = (name) => {
  const label = snake(name).replace(/[^a-z0-9_]/g, '_');
  return keywords.has(label) || label === 'extra' ? `${label}_` : /^[a-z]/.test(label) ? label : `field${label}`;
};
function objectShape(schema, file, seen = new Set([file])) {
  if (schema.$ref !== undefined) {
    const target = resolve(dirname(file), schema.$ref);
    if (seen.has(target)) throw new Error(`Recursive object composition in ${file}`);
    return objectShape(read(target), target, new Set([...seen, target]));
  }
  const own = schema.type === 'object' ? schema : undefined;
  if (schema.allOf === undefined) return own;
  const parts = schema.allOf.map((part) => objectShape(part, file, seen));
  if (parts.some((part) => part === undefined)) return undefined;
  const properties = new Map();
  const required = new Set();
  for (const part of own === undefined ? parts : [own, ...parts]) {
    for (const [name, field] of Object.entries(part.properties ?? {})) {
      properties.set(name, properties.has(name) ? {} : field);
    }
    for (const name of part.required ?? []) required.add(name);
  }
  return { properties: Object.fromEntries(properties), required: [...required] };
}

const records = schemas.flatMap(({ name, file, schema }) => {
  const object = objectShape(schema, file);
  return object && Object.keys(object.properties ?? {}).length > 0
    ? [{ name, file, schema: object }] : [];
});
const modulesByFile = new Map(records.map(({ file, name }) => [file, componentModule(name)]));
const unions = schemas.filter(({ schema }) => schema.discriminator && schema.oneOf);
for (const { name, file, schema } of unions) {
  if (!schema.oneOf.every(({ $ref }) => $ref && modulesByFile.has(resolve(dirname(file), $ref)))) {
    throw new Error(`${name} contains an unsupported discriminator branch`);
  }
}

const helpers = [
  'let object_fields = function `Assoc fields -> fields | _ -> assert false',
  'let string = function',
  '  | `Stringlit literal -> (match Yojson.Safe.from_string literal with `String text -> text | _ -> assert false)',
  '  | _ -> assert false',
  'let bool = function `Bool value -> value | _ -> assert false',
  'let required read name fields = read (List.assoc name fields)',
  'let optional read name fields =',
  '  match List.assoc_opt name fields with',
  '  | None -> Types.Absent | Some `Null -> Types.Null | Some value -> Types.Present (read value)',
  'let identity value = value',
  'let extra names = List.filter (fun (name, _) -> not (List.mem name names))',
];
const selected = (field) => {
  if (field.nullable === true) return ['Yojson.Raw.t', 'identity'];
  if (field.type === 'string') return ['string', 'string'];
  if (field.type === 'boolean') return ['bool', 'bool'];
  // Retain raw literals for exact numbers, and for nested and composed values.
  return ['Yojson.Raw.t', 'identity'];
};
const entries = records.map(({ name, schema }) => {
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties).map(([name, field]) => {
    const [type, read] = selected(field);
    const optional = !required.has(name);
    return { name, label: fieldName(name), read, optional, type: optional ? `${type} Types.presence` : type };
  });
  if (new Set(fields.map(({ label }) => label)).size !== fields.length) throw new Error(`${name} has colliding OCaml field names`);
  const mod = componentModule(name);
  const type = `  type t = { ${fields.map(({ label, type }) => `${label} : ${type}`).join('; ')}; extra : (string * Yojson.Raw.t) list }`;
  const declaration = `  val of_model : [ \`${name} ] Models.t -> t`;
  const view = [
    '  let project fields =',
    '    {',
    ...fields.map(({ label, optional, read, name }) => `      ${label} = ${optional ? 'optional' : 'required'} ${read} ${ocamlString(name)} fields;`),
    `      extra = extra [${fields.map(({ name }) => ocamlString(name)).join('; ')}] fields;`,
    '    }',
    '  let of_model model = project (object_fields (Models.json model))',
  ];
  return {
    api: [`module ${mod} : sig`, type, declaration, 'end'],
    impl: [`module ${mod} = struct`, type, ...view, 'end'],
  };
});
for (const { name, file, schema } of unions) {
  const { propertyName, mapping } = schema.discriminator;
  const variants = Object.entries(mapping).map(([tag, ref]) => {
    const constructor = tag.replace(/[^a-zA-Z0-9]+(.)/g, (_, next) => next.toUpperCase());
    const capital = constructor[0].toUpperCase() + constructor.slice(1);
    const branch = modulesByFile.get(resolve(dirname(file), ref));
    if (!branch || !/^[A-Z]\w*$/.test(capital)) throw new Error(`Unsupported ${name} variant ${tag}`);
    return { tag, capital, branch };
  });
  if (new Set(variants.map(({ capital }) => capital)).size !== variants.length) throw new Error(`${name} has colliding constructors`);
  const mod = componentModule(name);
  const type = `  type t = ${variants.map(({ capital, branch }) => `${capital} of ${branch}.t`).join(' | ')}`;
  entries.push({
    api: [`module ${mod} : sig`, type, `  val of_model : [ \`${name} ] Models.t -> t option`, 'end'],
    impl: [`module ${mod} = struct`, type,
      '  let of_model model =',
      '    let fields = object_fields (Models.json model) in',
      `    match List.assoc_opt ${ocamlString(propertyName)} fields with`,
      '    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with',
      ...variants.map(({ tag, capital, branch }) => `      | ${ocamlString(tag)} -> Some (${capital} (${branch}.project fields))`),
      '      | _ -> None)',
      '    | _ -> None', 'end'],
  });
}
const header = '(* Generated from OpenAPI object components and discriminator mappings. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n';
for (const [extension, lines] of [
  ['ml', [...helpers, ...entries.flatMap(({ impl }) => impl)]],
  ['mli', entries.flatMap(({ api }) => api)],
]) {
  writeOrCheck(root, resolve(root, `packages/ocaml/sdk/lib/records.${extension}`),
    `${header}\n${lines.join('\n')}\n`, process.argv.includes('--check'));
}
