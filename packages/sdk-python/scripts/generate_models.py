"""Generate `semiont/types.py`, the protocol's shapes, from the bundled OpenAPI spec.

    uv run python scripts/generate_models.py            write it
    uv run python scripts/generate_models.py --check    compare, and fail on a difference

The classes are written by `datamodel-code-generator`, the ecosystem's own
generator, pinned in this package's lockfile. What it cannot be told by a flag
is done here, before and after it runs.

Before, on a copy of the spec:

- **A kind of id is this SDK's own type.** Wherever the spec refers to one of
  the kinds `specs/src/identifiers/kinds.json` names, the generator is handed
  the type `semiont.identifiers` holds for it, so a field that carries an id is
  of its kind and of no other.
- **A schema that extends another and restates one of its properties is written
  out whole.** As a subclass it would narrow a field its base declares, which a
  type checker refuses.
- **Two properties that would be given one Python name are refused**, here,
  where the generator would rename one of them without saying so.
- **Text stays text, whatever format the spec says it has.** A time or a URI
  read into a type of its own is written back in another spelling than it came
  in, and a client hands on what it was sent. Only `binary` is not text.

After, on what it wrote:

- **Every class says it is frozen**, on its own line, where both type checkers
  read it, and the rest of its configuration is said there with it.
- **What the spec leaves open is JSON, not `Any`.**
- **`__all__` names what the spec names.**
"""

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Never

from pydantic import JsonValue, TypeAdapter

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]
SPEC = ROOT / "specs/openapi.json"
KINDS = ROOT / "specs/src/identifiers/kinds.json"
OUT = PACKAGE / "src/semiont/types.py"

SCHEMA_REF = "#/components/schemas/"

# The formats the spec gives a string. A format this does not name is refused:
# whether its text is kept as it came is a decision, made here.
KEPT_AS_TEXT = frozenset({"date-time", "uri"})
BYTES = "binary"
BANNER = (
    "# Generated from specs/openapi.json, the bundled spec; do not edit.\n"
    "# Regenerate: uv run python scripts/generate_models.py (in packages/sdk-python)\n"
)

type JsonObject = dict[str, JsonValue]

_JSON = TypeAdapter[JsonValue](JsonValue)


def refuse(message: str) -> Never:
    """Say why the models cannot be generated, and stop."""
    sys.exit(f"✗ {message}")


def read(path: Path) -> JsonObject:
    """The JSON object a file holds."""
    if not path.exists():
        refuse(f"{path.relative_to(ROOT)} does not exist. Bundle the spec first: npm run generate:openapi --workspace=@semiont/core")
    value = _JSON.validate_json(path.read_bytes())
    if not isinstance(value, dict):
        refuse(f"{path.relative_to(ROOT)} is not a JSON object")
    return value


def member(node: JsonObject, key: str, where: str) -> JsonObject:
    """`node[key]`, which is an object."""
    value = node.get(key)
    if not isinstance(value, dict):
        refuse(f"{where} has no object named {key}")
    return value


def kind_of(node: JsonValue, kinds: frozenset[str]) -> str | None:
    """The kind of id `node` refers to, when it is exactly a reference to one."""
    if not isinstance(node, dict):
        return None
    ref = node.get("$ref")
    if isinstance(ref, str) and ref.startswith(SCHEMA_REF) and ref.removeprefix(SCHEMA_REF) in kinds:
        return ref.removeprefix(SCHEMA_REF)
    return None


def with_kinds(node: JsonValue, kinds: frozenset[str]) -> JsonValue:
    """`node`, with each reference to a kind of id replaced by this SDK's type for it."""
    if isinstance(node, list):
        return [with_kinds(item, kinds) for item in node]
    if not isinstance(node, dict):
        return node

    kind = kind_of(node, kinds)
    rest: JsonObject = {key: value for key, value in node.items() if key != "$ref"}
    if kind is None:
        # `{ nullable, allOf: [<a kind>] }` is how OpenAPI 3.0 says "a kind, or null".
        wrapped = node.get("allOf")
        if isinstance(wrapped, list) and len(wrapped) == 1:
            kind = kind_of(wrapped[0], kinds)
            rest = {key: value for key, value in node.items() if key != "allOf"}
    if kind is None:
        return {key: with_kinds(value, kinds) for key, value in node.items()}
    return {**rest, "type": "string", "customTypePath": f"semiont.identifiers.{kind}"}


def names_a_kind(node: JsonValue, kinds: frozenset[str]) -> bool:
    """Whether a reference to a kind of id is anywhere in `node`."""
    if isinstance(node, list):
        return any(names_a_kind(item, kinds) for item in node)
    if isinstance(node, dict):
        return kind_of(node, kinds) is not None or any(names_a_kind(value, kinds) for value in node.values())
    return False


def properties_of(schema: JsonObject) -> JsonObject:
    """A schema's own properties, or none."""
    properties = schema.get("properties")
    return properties if isinstance(properties, dict) else {}


def written_whole(name: str, schema: JsonObject, schemas: JsonObject) -> JsonObject:
    """`schema`, or what it and the schemas it extends say together.

    Only a schema that restates a property of one it extends is written whole.
    """
    members = schema.get("allOf")
    if not isinstance(members, list):
        return schema

    bases: list[JsonObject] = []
    own: list[JsonObject] = []
    for part in members:
        if not isinstance(part, dict):
            refuse(f"{name}: a member of its allOf is not a schema")
        ref = part.get("$ref")
        if isinstance(ref, str) and ref.startswith(SCHEMA_REF):
            bases.append(member(schemas, ref.removeprefix(SCHEMA_REF), f"{name}'s allOf"))
        else:
            own.append(part)

    inherited = {key for base in bases for key in properties_of(base)}
    if not any(key in inherited for part in own for key in properties_of(part)):
        return schema
    if any("allOf" in base for base in bases):
        refuse(f"{name} restates a property of a schema that itself extends another; write that case when the spec has one")

    properties: JsonObject = {}
    required: list[JsonValue] = []
    whole: JsonObject = {"type": "object"}
    for part in [*bases, *own]:
        properties.update(properties_of(part))
        stated = part.get("required")
        if isinstance(stated, list):
            required.extend(key for key in stated if key not in required)
        if "additionalProperties" in part:
            whole["additionalProperties"] = part["additionalProperties"]
    whole["properties"] = properties
    if required:
        whole["required"] = required
    if "description" in schema:
        whole["description"] = schema["description"]
    return whole


def as_text(name: str, node: JsonValue) -> JsonValue:
    """`node`, with every formatted string but bytes left as plain text."""
    if isinstance(node, list):
        return [as_text(name, item) for item in node]
    if not isinstance(node, dict):
        return node
    stated = node.get("format")
    if node.get("type") != "string" or not isinstance(stated, str) or stated == BYTES:
        return {key: as_text(name, value) for key, value in node.items()}
    if stated not in KEPT_AS_TEXT:
        refuse(f"{name}: a string of format {stated!r}, which this script does not know; say in it whether such text is kept as it came")
    return {key: as_text(name, value) for key, value in node.items() if key != "format"}


def python_name(wire: str) -> str:
    """The Python name the generator gives a property: what marks it (`@`, `_`) dropped, then snake_case."""
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", wire.lstrip("@_")).replace("-", "_").lower()


def hold_names(name: str, node: JsonValue) -> None:
    """Refuse an object two of whose properties would be given one Python name."""
    if isinstance(node, list):
        for item in node:
            hold_names(name, item)
        return
    if not isinstance(node, dict):
        return
    seen: dict[str, str] = {}
    for wire in properties_of(node):
        python = python_name(wire)
        if python in seen:
            refuse(f"{name}: the properties {seen[python]!r} and {wire!r} would both be the Python field {python!r}")
        seen[python] = wire
    for value in node.values():
        hold_names(name, value)


def prepared(spec: JsonObject, kinds: frozenset[str]) -> JsonObject:
    """The spec as the generator is given it."""
    schemas = member(member(spec, "components", "the spec"), "schemas", "the spec's components")
    for kind in kinds:
        if kind not in schemas:
            refuse(f"the spec has no schema named {kind}, which kinds.json names")

    whole: JsonObject = {}
    for name, schema in schemas.items():
        if name in kinds:
            continue
        if not isinstance(schema, dict):
            refuse(f"{name} is not a schema")
        whole[name] = as_text(name, with_kinds(written_whole(name, schema, schemas), kinds))
        hold_names(name, whole[name])
    if names_a_kind(whole, kinds):
        refuse("a reference to a kind of id survived: the generator would write it as text")

    return {**spec, "components": {**member(spec, "components", "the spec"), "schemas": whole}}


def generated(spec: JsonObject) -> str:
    """What `datamodel-code-generator` writes for `spec`."""
    with tempfile.TemporaryDirectory() as scratch:
        given = Path(scratch) / "openapi.json"
        written = Path(scratch) / "types.py"
        given.write_bytes(_JSON.dump_json(spec))
        subprocess.run(
            [
                sys.executable,
                "-m",
                "datamodel_code_generator",
                "--input",
                str(given),
                "--input-file-type",
                "openapi",
                "--openapi-scopes",
                "schemas",
                "--output",
                str(written),
                "--output-model-type",
                "pydantic_v2.BaseModel",
                "--target-python-version",
                "3.12",
                "--base-class",
                "semiont.model.WireModel",
                "--use-type-alias",
                "--use-annotated",
                "--field-constraints",
                "--use-standard-collections",
                "--use-union-operator",
                "--enum-field-as-literal",
                "all",
                "--use-schema-description",
                # What the spec says may be null may be null, whether or not it must be there.
                "--strict-nullable",
                "--snake-case-field",
                "--remove-special-field-name-prefix",
                "--disable-timestamp",
                "--custom-file-header",
                BANNER,
                "--formatters",
                "ruff-format",
            ],
            check=True,
        )
        return written.read_text(encoding="utf-8")


CLASS = re.compile(r"^class (\w+)\((.+)\):$", re.MULTILINE)
ALIAS = re.compile(r"^type (\w+) = ", re.MULTILINE)
CONFIG = re.compile(r"^    model_config = ConfigDict\(\n((?:        .+\n)+)    \)\n", re.MULTILINE)


def with_class_keywords(source: str) -> str:
    """Each class's configuration on its own line, as class keywords, `frozen=True` first.

    Immutable in a way both checkers see: a checker reads `frozen` from the
    class's own line, and refuses a class that leaves it out. The rest of a
    class's configuration goes beside it, since the two cannot be said in two
    places.
    """
    written: list[str] = []
    for block in re.split(r"(?m)^(?=class \w+\()", source):
        header = CLASS.match(block)
        if header is None:
            written.append(block)
            continue
        keywords = ["frozen=True"]

        def taken(found: re.Match[str], keywords: list[str] = keywords) -> str:
            keywords.extend(line.strip().rstrip(",") for line in found.group(1).splitlines())
            return ""

        body = CONFIG.sub(taken, block[header.end() :], count=1)
        if "model_config" in body:
            refuse(f"{header.group(1)} states its configuration in a way this script does not read")
        # A class whose configuration was all it said still needs a body.
        own = body.split("\n\n\n", 1)[0]
        if not any(line.startswith("    ") for line in own.splitlines()):
            body = "\n    pass\n" + body
        written.append(f"class {header.group(1)}({header.group(2)}, {', '.join(keywords)}):{body}")
    return "".join(written)


def finished(source: str, named: frozenset[str]) -> str:
    """The generator's output, with what a flag could not ask for."""
    # The id types say how they are decoded; nothing here is taken on an `isinstance` alone.
    source = re.sub(r"    model_config = ConfigDict\(\n        arbitrary_types_allowed=True,\n    \)\n", "", source)
    source = source.replace("        arbitrary_types_allowed=True,\n", "")
    if "arbitrary_types_allowed" in source:
        refuse("the generator still allows arbitrary types somewhere; read what it wrote")

    source = with_class_keywords(source)
    source, config_imports = re.subn(r"^(from pydantic import .*)\bConfigDict, ", r"\1", source, count=1, flags=re.MULTILINE)
    if config_imports != 1 or "ConfigDict" in source:
        refuse("ConfigDict is still named after every class's configuration became its keywords; read what was written")

    # What the spec leaves open is JSON. `Any` would turn checking off.
    source = re.sub(r"\bAny\b", "JsonValue", source)
    source, typing_imports = re.subn(r"^from typing import (.*)\bJsonValue, (.*)$", r"from typing import \1\2", source, flags=re.MULTILINE)
    source, pydantic_imports = re.subn(r"^from pydantic import ", "from pydantic import JsonValue, ", source, count=1, flags=re.MULTILINE)
    if typing_imports != 1 or pydantic_imports != 1:
        refuse("the generator's imports are not as this script expects; read what it wrote")

    # What the spec names, and every class a caller builds one of its shapes from.
    classes = CLASS.findall(source)
    exported = sorted({name for name, _ in classes} | {name for name in ALIAS.findall(source) if name in named})
    everything = "__all__ = [\n" + "".join(f'    "{name}",\n' for name in exported) + "]\n"
    head, separator, body = source.partition("\n\n\n")
    if separator == "":
        refuse("the generator's output has no break after its imports; read what it wrote")
    source = f"{head}\n\n{everything}\n\n{body}"

    formatted = subprocess.run(
        [sys.executable, "-m", "ruff", "format", "--stdin-filename", str(OUT), "-"],
        input=source,
        capture_output=True,
        text=True,
        check=True,
    )
    return formatted.stdout


def main() -> int:
    """Write `semiont/types.py`, or with `--check` say whether it is what the spec generates."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="compare without writing")
    check: bool = parser.parse_args().check

    stated = read(KINDS).get("kinds")
    if not isinstance(stated, list):
        refuse("kinds.json lists no kinds")
    kinds = frozenset(kind["schema"] for kind in stated if isinstance(kind, dict) and isinstance(kind["schema"], str))

    spec = read(SPEC)
    named = frozenset(member(member(spec, "components", "the spec"), "schemas", "the spec's components"))
    source = finished(generated(prepared(spec, kinds)), named)

    name = OUT.relative_to(ROOT)
    current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
    if current == source:
        print(f"ok    {name}")
        return 0
    print(f"{'DRIFT' if current else 'new  '} {name}")
    if check:
        return 1
    OUT.write_text(source, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
