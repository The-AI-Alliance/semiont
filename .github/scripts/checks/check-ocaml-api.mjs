/** Cheap source freshness gate; native CI also compares actual compiler exports. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = 'packages/ocaml/sdk';
const read = (file) => readFileSync(join(root, file));
const recipe = JSON.parse(read('public-api.inputs.json'));
const inventory = JSON.parse(read('public-api.json'));
const files = new Set(recipe.files);
function collect(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) collect(file);
    else if (entry.isFile()) files.add(file);
    else throw new Error(`unexpected OCaml API input: ${file}`);
  }
}
for (const directory of recipe.directories) collect(directory);
const actual = Object.fromEntries([...files].sort().map((file) =>
  [file, createHash('sha256').update(read(file)).digest('hex')]));
if (JSON.stringify(actual) !== JSON.stringify(inventory.inputs)) {
  throw new Error('OCaml public API inventory is stale: build the library and run python3 api.py --write inside the OCaml container');
}
console.log(`PASS OCaml API inventory freshness: ${files.size} source inputs`);
