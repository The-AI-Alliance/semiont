//! Rust types from component schemas (JSON Schema draft 7, as
//! `draft7_definitions` writes them): a struct per object, an enum per string
//! enumeration, an untagged enum per `oneOf` or `anyOf`, an alias per named
//! string, a field per property, optional where the schema does not require
//! it. It knows the shapes the spec's schemas use and refuses any other, so a
//! schema that grows a new shape fails the build rather than generating
//! something wrong.
//!
//! A union is untagged, and the first member that decodes is the one meant.
//! Its members are told apart by what they are — text, a list, an object — or,
//! between objects, by a single-valued discriminant each carries (`status`,
//! `kind`, `code`) or by one being the empty object. What the schema says that a type cannot — a pattern, a length, a
//! bound — is the validators' to hold at the boundary, before a value is
//! decoded.

use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// What one generation writes.
pub struct Generation<'a> {
    /// The schemas generated, and every schema they reach unless `elsewhere` is set.
    pub roots: &'a [&'a str],
    /// With a path, only the roots are generated, and every other schema they
    /// reach is named as `<path>::<Name>`: the crate that owns it.
    pub elsewhere: Option<&'a str>,
}

const EMPTY_OBJECT: &str = "EmptyObject";
/// The key the `stated` helper is written under: no schema is named so.
const STATED: &str = "fn stated";

/// The Rust source of a generation's types, from `definitions` (the
/// `definitions` object of `draft7_definitions`' output).
pub fn generate(definitions: &Value, generation: &Generation<'_>) -> String {
    let mut types = Types {
        definitions,
        generation,
        written: BTreeMap::new(),
    };
    for root in generation.roots {
        types.named(root);
    }
    let mut out =
        String::from("// Generated from the component schemas in specs/src; do not edit.\n");
    for code in types.written.values() {
        out.push_str(code);
    }
    out
}

struct Types<'a> {
    definitions: &'a Value,
    generation: &'a Generation<'a>,
    /// Every type written, by name, so a schema reached twice is written once.
    written: BTreeMap<String, String>,
}

impl Types<'_> {
    fn schema(&self, name: &str) -> &Value {
        self.definitions
            .get(name)
            .unwrap_or_else(|| panic!("the spec declares no schema {name}"))
    }

    /// The type a component schema names: written here, or named where it lives.
    fn named(&mut self, name: &str) -> String {
        let owned = self.generation.elsewhere.is_none() || self.generation.roots.contains(&name);
        if !owned {
            return format!(
                "{}::{name}",
                self.generation.elsewhere.expect("checked above")
            );
        }
        if !self.written.contains_key(name) {
            let schema = self.schema(name).clone();
            self.written.insert(name.to_owned(), String::new());
            let code = self.declaration(name, &schema);
            self.written.insert(name.to_owned(), code);
        }
        name.to_owned()
    }

    /// The name of the type of `owner`'s property `property`, when its schema
    /// is written in place: the two names together, and `Value` after them
    /// for as long as a component schema already has that name.
    fn inline_name(&self, owner: &str, property: &str) -> String {
        let mut name = format!("{owner}{}", pascal(property));
        while self.definitions.get(&name).is_some() {
            name.push_str("Value");
        }
        name
    }

    fn inline(&mut self, name: &str, schema: &Value) -> String {
        let code = self.declaration(name, schema);
        self.written.insert(name.to_owned(), code);
        name.to_owned()
    }

    fn empty_object(&mut self) -> String {
        self.written.entry(EMPTY_OBJECT.to_owned()).or_insert_with(|| {
            "/// An object with no properties.\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize, serde::Serialize)]\n#[serde(deny_unknown_fields)]\npub struct EmptyObject {}\n\n".to_owned()
        });
        EMPTY_OBJECT.to_owned()
    }

    /// Whether a schema is a string, following `$ref`s and unions of strings.
    fn is_string(&self, schema: &Value) -> bool {
        if let Some(name) = reference(schema) {
            return self.is_string(self.schema(name));
        }
        if let Some(members) = union(schema) {
            return members.iter().all(|m| self.is_string(m));
        }
        schema["type"] == "string" && schema.get("enum").is_none() && schema.get("const").is_none()
    }

    /// The Rust type of a value `owner`'s property `property` holds.
    fn type_of(&mut self, owner: &str, property: &str, schema: &Value) -> String {
        if let Some(name) = reference(schema) {
            return self.named(name);
        }
        if schema.as_object().is_some_and(|o| o.is_empty()) {
            return "serde_json::Value".to_owned();
        }
        if let Some(inner) = without_null(schema) {
            return self.type_of(owner, property, &inner);
        }
        // An `allOf` of one schema is that schema: the form a `$ref` takes
        // when something is said beside it.
        if let Some([only]) = schema["allOf"].as_array().map(Vec::as_slice)
            && reference(only).is_some()
            && schema
                .as_object()
                .is_some_and(|o| o.keys().all(|k| k == "allOf" || k == "description"))
        {
            return self.type_of(owner, property, only);
        }
        if schema.get("allOf").is_some() {
            return self.inline(&self.inline_name(owner, property), schema);
        }
        if let Some(members) = union(schema) {
            if members.iter().all(|m| self.is_string(m)) {
                return "String".to_owned();
            }
            return self.inline(&self.inline_name(owner, property), schema);
        }
        match schema["type"].as_str() {
            Some("string") if schema.get("enum").is_some() || schema.get("const").is_some() => {
                self.inline(&self.inline_name(owner, property), schema)
            }
            Some("string") => "String".to_owned(),
            Some("boolean") => "bool".to_owned(),
            Some("number") => "f64".to_owned(),
            Some("integer") => {
                let minimum = schema["minimum"].as_i64();
                let maximum = schema["maximum"].as_i64();
                match (minimum, maximum) {
                    (Some(min), Some(max)) if min >= 0 && max <= i64::from(u16::MAX) => "u16",
                    (Some(min), _) if min >= 0 => "u64",
                    _ => "i64",
                }
                .to_owned()
            }
            Some("array") => {
                let item = self.type_of(owner, &format!("{property}Item"), &schema["items"]);
                format!("Vec<{item}>")
            }
            Some("object") => {
                let properties = schema["properties"].as_object().filter(|p| !p.is_empty());
                match (properties, &schema["additionalProperties"]) {
                    (Some(_), _) => self.inline(&self.inline_name(owner, property), schema),
                    (None, Value::Bool(false)) if schema["maxProperties"] == 0 => {
                        self.empty_object()
                    }
                    (None, Value::Bool(false)) => {
                        self.inline(&self.inline_name(owner, property), schema)
                    }
                    (None, Value::Null | Value::Bool(true)) if schema["maxProperties"] == 0 => {
                        self.empty_object()
                    }
                    (None, Value::Null | Value::Bool(true)) => {
                        "serde_json::Map<String, serde_json::Value>".to_owned()
                    }
                    (None, values) => {
                        let value = self.type_of(owner, &format!("{property}Value"), values);
                        format!("std::collections::BTreeMap<String, {value}>")
                    }
                }
            }
            _ => panic!("{owner}.{property}: a schema shape the generator does not know: {schema}"),
        }
    }

    fn declaration(&mut self, name: &str, schema: &Value) -> String {
        let mut code = String::new();
        doc(&mut code, "", schema);
        if let Some(members) = union(schema) {
            return self.union_declaration(name, members, code);
        }
        let merged;
        let schema = match schema["allOf"].as_array() {
            Some(members) => {
                merged = self.merged(name, members);
                &merged
            }
            None => schema,
        };
        let constant = schema.get("const").map(|value| vec![value.clone()]);
        if let Some(values) = schema["enum"].as_array().or(constant.as_ref()) {
            if schema["type"] != "string" {
                panic!("{name}: only string enumerations are generated");
            }
            code.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Deserialize, serde::Serialize)]\n");
            let _ = writeln!(code, "pub enum {name} {{");
            let mut taken: Vec<String> = Vec::new();
            for value in values {
                let value = value
                    .as_str()
                    .unwrap_or_else(|| panic!("{name}: an enum value is not a string"));
                // A `+` is part of what a value says (`text/x-c++` is not
                // `text/x-c`), so it is spelled rather than dropped.
                let variant = pascal(&value.replace('+', " plus "));
                if taken.contains(&variant) {
                    panic!("{name}: two enum values would both be the variant {variant}");
                }
                let _ = writeln!(code, "    #[serde(rename = \"{value}\")]\n    {variant},");
                taken.push(variant);
            }
            code.push_str("}\n\n");
            return code;
        }
        if self.is_string(schema) {
            let _ = writeln!(code, "pub type {name} = String;\n");
            return code;
        }
        if schema["type"] != "object" {
            panic!("{name}: a schema shape the generator does not know: {schema}");
        }
        let empty = serde_json::Map::new();
        let properties = schema["properties"].as_object().unwrap_or(&empty);
        let required: Vec<&str> = schema["required"]
            .as_array()
            .map(|r| r.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut fields = std::collections::BTreeSet::new();
        for property in properties.keys() {
            if !fields.insert(snake(property)) {
                panic!(
                    "{name}: two properties are named {} in Rust",
                    snake(property)
                );
            }
        }
        let open = match &schema["additionalProperties"] {
            Value::Bool(true) => true,
            Value::Bool(false) | Value::Null => false,
            other => panic!(
                "{name}: properties beside additionalProperties {other}, which the generator does not know"
            ),
        };
        code.push_str("#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]\n");
        if schema["additionalProperties"] == false {
            code.push_str("#[serde(deny_unknown_fields)]\n");
        }
        let _ = writeln!(code, "pub struct {name} {{");
        for (property, property_schema) in properties {
            let rust_type = self.type_of(name, property, property_schema);
            doc(&mut code, "    ", property_schema);
            let field = snake(property);
            if field.trim_start_matches("r#") != property.as_str() {
                let _ = writeln!(code, "    #[serde(rename = \"{property}\")]");
            }
            let nullable = without_null(property_schema).is_some();
            if required.contains(&property.as_str()) && nullable {
                let _ = writeln!(code, "    pub {field}: Option<{rust_type}>,");
            } else if required.contains(&property.as_str()) {
                let _ = writeln!(code, "    pub {field}: {rust_type},");
            } else if nullable {
                // Absent, null and a value are three things: the outer option
                // is whether it was stated, the inner whether it was null.
                let _ = writeln!(
                    code,
                    "    #[serde(default, deserialize_with = \"stated\", skip_serializing_if = \"Option::is_none\")]\n    pub {field}: Option<Option<{rust_type}>>,"
                );
                self.written.entry(STATED.to_owned()).or_insert_with(|| {
                    "/// A property that was stated, whatever it stated: null is `Some(None)`.\nfn stated<'de, T: serde::Deserialize<'de>, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {\n    serde::Deserialize::deserialize(deserializer).map(Some)\n}\n\n".to_owned()
                });
            } else {
                let _ = writeln!(
                    code,
                    "    #[serde(default, skip_serializing_if = \"Option::is_none\")]\n    pub {field}: Option<{rust_type}>,"
                );
            }
        }
        if open {
            code.push_str("    /// Every property the schema does not name, as it came.\n    #[serde(flatten)]\n    pub rest: serde_json::Map<String, serde_json::Value>,\n");
        }
        code.push_str("}\n\n");
        code
    }

    /// An `allOf`'s members as one object: the properties of each, a later
    /// member's refining an earlier's, and every member's requirements.
    fn merged(&self, name: &str, members: &[Value]) -> Value {
        let mut properties = serde_json::Map::new();
        let mut required: Vec<Value> = Vec::new();
        let mut closed = false;
        for member in members {
            let member = match reference(member) {
                Some(target) => self.schema(target).clone(),
                None => member.clone(),
            };
            if member["type"] != "object" {
                panic!("{name}: an allOf member that is not an object: {member}");
            }
            if let Some(own) = member["properties"].as_object() {
                properties.extend(own.clone());
            }
            if let Some(own) = member["required"].as_array() {
                required.extend(
                    own.iter()
                        .filter(|r| !required.contains(r))
                        .cloned()
                        .collect::<Vec<_>>(),
                );
            }
            closed |= member["additionalProperties"] == false;
        }
        let mut object =
            serde_json::json!({ "type": "object", "properties": properties, "required": required });
        if closed {
            object["additionalProperties"] = Value::Bool(false);
        }
        object
    }

    fn union_declaration(&mut self, name: &str, members: &[Value], mut code: String) -> String {
        let referenced: Vec<Option<&str>> = members.iter().map(reference).collect();
        let prefix = common_prefix(referenced.iter().flatten().copied());
        let mut variants = Vec::new();
        for member in members {
            let (variant, rust_type) = match reference(member) {
                Some(target) => {
                    let rust_type = self.named(target);
                    let short = target.strip_prefix(prefix.as_str()).unwrap_or(target);
                    (short.to_owned(), rust_type)
                }
                None if member["type"] == "object" && member["maxProperties"] == 0 => {
                    ("Empty".to_owned(), self.empty_object())
                }
                None if self.is_string(member) => ("Text".to_owned(), "String".to_owned()),
                None if member["type"] == "array" => {
                    let item = self.type_of(name, "Item", &member["items"]);
                    ("List".to_owned(), format!("Vec<{item}>"))
                }
                None if member["type"] == "object" => {
                    // An inline member is named by the one value its
                    // discriminant takes, when it has one.
                    let variant = discriminant(member).map_or("Object".to_owned(), pascal);
                    let rust_type = self.type_of(name, &variant, member);
                    (variant, rust_type)
                }
                None => panic!("{name}: a union member the generator does not know: {member}"),
            };
            if variants.iter().any(|(taken, _)| *taken == variant) {
                panic!("{name}: two union members would both be the variant {variant}");
            }
            variants.push((variant, rust_type));
        }
        code.push_str("#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]\n#[serde(untagged)]\n");
        let _ = writeln!(code, "pub enum {name} {{");
        for (variant, rust_type) in variants {
            let _ = writeln!(code, "    {variant}({rust_type}),");
        }
        code.push_str("}\n\n");
        code
    }
}

/// A schema that also admits null (`type: [T, "null"]` or a union with a
/// `null` member, draft 7's forms of OpenAPI's `nullable`), as the schema
/// without it.
fn without_null(schema: &Value) -> Option<Value> {
    if let Some(members) = union(schema) {
        let others: Vec<&Value> = members.iter().filter(|m| m["type"] != "null").collect();
        return match others.as_slice() {
            _ if others.len() == members.len() => None,
            [only] => Some((*only).clone()),
            _ => Some(serde_json::json!({ "anyOf": others })),
        };
    }
    let types = schema["type"].as_array()?;
    let others: Vec<&Value> = types.iter().filter(|t| *t != "null").collect();
    if others.len() != 1 || others.len() == types.len() {
        panic!("a schema of several types the generator does not know: {schema}");
    }
    let mut inner = schema.clone();
    inner["type"] = others[0].clone();
    Some(inner)
}

/// The single value an object's discriminating property takes: the first of
/// its properties that admits exactly one string.
fn discriminant(object: &Value) -> Option<&str> {
    object["properties"]
        .as_object()?
        .values()
        .find_map(|property| {
            match (
                property["enum"].as_array().map(Vec::as_slice),
                &property["const"],
            ) {
                (Some([only]), _) => only.as_str(),
                (None, Value::String(only)) => Some(only.as_str()),
                _ => None,
            }
        })
}

fn reference(schema: &Value) -> Option<&str> {
    schema["$ref"].as_str().map(|r| {
        r.strip_prefix("#/definitions/")
            .unwrap_or_else(|| panic!("$ref {r} is not a component schema"))
    })
}

fn union(schema: &Value) -> Option<&[Value]> {
    schema["oneOf"]
        .as_array()
        .or_else(|| schema["anyOf"].as_array())
        .map(Vec::as_slice)
}

/// The longest prefix every name shares that ends where a word ends, and leaves
/// each name a word of its own: `JobPending`, `JobRunning` share `Job`.
fn common_prefix<'a>(names: impl Iterator<Item = &'a str>) -> String {
    let names: Vec<&str> = names.collect();
    let Some(first) = names.first() else {
        return String::new();
    };
    if names.len() < 2 {
        return String::new();
    }
    let mut prefix = String::new();
    for (index, c) in first.char_indices() {
        let candidate = &first[..index];
        if c.is_ascii_uppercase()
            && !candidate.is_empty()
            && names.iter().all(|n| {
                n.starts_with(candidate)
                    && n[candidate.len()..].starts_with(|c: char| c.is_ascii_uppercase())
            })
        {
            prefix = candidate.to_owned();
        }
    }
    prefix
}

/// A schema's description as doc comments, indented.
fn doc(code: &mut String, indent: &str, schema: &Value) {
    if let Some(description) = schema["description"].as_str() {
        for line in description.lines() {
            let _ = writeln!(code, "{indent}/// {line}");
        }
    }
}

/// `in-process` and `subjectClaim` as `InProcess` and `SubjectClaim`.
pub fn pascal(word: &str) -> String {
    let mut out = String::new();
    let mut upper = true;
    for c in word.chars() {
        if c.is_ascii_alphanumeric() {
            if upper {
                out.push(c.to_ascii_uppercase());
            } else {
                out.push(c);
            }
            upper = false;
        } else {
            upper = true;
        }
    }
    out
}

/// `subjectClaim` as `subject_claim`; a Rust keyword raw.
pub fn snake(word: &str) -> String {
    let mut out = String::new();
    // JSON-LD's keywords (`@id`, `@type`) are named without their `@`.
    for c in word.trim_start_matches('@').chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if matches!(
        out.as_str(),
        "type"
            | "ref"
            | "match"
            | "use"
            | "mod"
            | "move"
            | "self"
            | "crate"
            | "struct"
            | "enum"
            | "fn"
    ) {
        format!("r#{out}")
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn generated(definitions: Value, root: &str) -> String {
        generate(
            &definitions,
            &Generation {
                roots: &[root],
                elsewhere: None,
            },
        )
    }

    #[test]
    fn a_union_names_each_member_by_what_it_is() {
        let code = generated(
            json!({
                "Target": { "type": "object", "properties": { "source": { "type": "string" } }, "required": ["source"] },
                "Holder": { "type": "object", "required": ["target"], "properties": { "target": { "oneOf": [
                    { "type": "string" },
                    { "$ref": "#/definitions/Target" },
                    { "type": "array", "items": { "$ref": "#/definitions/Target" } },
                    { "type": "object", "additionalProperties": true }
                ] } } }
            }),
            "Holder",
        );
        assert!(code.contains("pub enum HolderTarget {\n    Text(String),\n    Target(Target),\n    List(Vec<Target>),\n    Object(serde_json::Map<String, serde_json::Value>),\n}"), "{code}");
    }

    #[test]
    fn inline_members_are_named_by_their_discriminants() {
        let code = generated(
            json!({ "Focus": { "oneOf": [
                { "type": "object", "required": ["kind"], "properties": { "kind": { "type": "string", "enum": ["annotation"] } } },
                { "type": "object", "required": ["kind"], "properties": { "kind": { "type": "string", "enum": ["resource"] } } }
            ] } }),
            "Focus",
        );
        assert!(code.contains("pub enum Focus {\n    Annotation(FocusAnnotation),\n    Resource(FocusResource),\n}"), "{code}");
    }

    #[test]
    fn a_plus_in_an_enum_value_is_spelled_in_its_variant() {
        let code = generated(
            json!({ "Media": { "type": "string", "enum": ["text/x-c", "text/x-c++", "image/svg+xml"] } }),
            "Media",
        );
        assert!(
            code.contains("#[serde(rename = \"text/x-c\")]\n    TextXC,"),
            "{code}"
        );
        assert!(
            code.contains("#[serde(rename = \"text/x-c++\")]\n    TextXCPlusPlus,"),
            "{code}"
        );
        assert!(
            code.contains("#[serde(rename = \"image/svg+xml\")]\n    ImageSvgPlusXml,"),
            "{code}"
        );
    }

    #[test]
    #[should_panic(expected = "two enum values would both be the variant TextPlain")]
    fn two_enum_values_one_variant_would_name_are_refused() {
        generated(
            json!({ "Media": { "type": "string", "enum": ["text/plain", "text-plain"] } }),
            "Media",
        );
    }

    #[test]
    #[should_panic(expected = "two union members would both be the variant Text")]
    fn two_members_nothing_tells_apart_are_refused() {
        generated(
            json!({ "Twice": { "oneOf": [
                { "type": "string" },
                { "type": "string", "description": "another" },
                { "type": "array", "items": { "type": "string" } }
            ] } }),
            "Twice",
        );
    }

    #[test]
    fn a_named_string_is_an_alias() {
        let code = generated(
            json!({ "MediaType": { "type": "string", "description": "A MIME type." } }),
            "MediaType",
        );
        assert!(
            code.contains("/// A MIME type.\npub type MediaType = String;"),
            "{code}"
        );
    }

    #[test]
    fn an_optional_nullable_property_keeps_absent_and_null_apart() {
        let code = generated(
            json!({ "Page": { "type": "object", "properties": { "cursor": { "type": ["string", "null"] } } } }),
            "Page",
        );
        assert!(code.contains("deserialize_with = \"stated\""), "{code}");
        assert!(
            code.contains("pub cursor: Option<Option<String>>,"),
            "{code}"
        );
        assert!(code.contains("fn stated<"), "{code}");
    }

    #[test]
    fn a_nullable_reference_is_the_referenced_type_and_not_a_copy_of_it() {
        let code = generated(
            json!({
                "Resource": { "type": "object", "properties": { "name": { "type": "string" } } },
                "Answer": { "type": "object", "required": ["resource"], "properties": { "resource": { "anyOf": [
                    { "type": "null" },
                    { "allOf": [{ "$ref": "#/definitions/Resource" }], "description": "The resource, if any." }
                ] } } }
            }),
            "Answer",
        );
        assert!(code.contains("pub resource: Option<Resource>,"), "{code}");
        assert!(!code.contains("AnswerResource"), "{code}");
    }

    #[test]
    fn a_type_written_in_place_takes_a_name_no_schema_has() {
        let code = generated(
            json!({
                "NoteBody": { "type": "object", "properties": { "value": { "type": "string" } } },
                "Note": { "type": "object", "properties": { "body": { "oneOf": [
                    { "$ref": "#/definitions/NoteBody" },
                    { "type": "array", "items": { "$ref": "#/definitions/NoteBody" } }
                ] } } }
            }),
            "Note",
        );
        assert!(code.contains("pub struct NoteBody {"), "{code}");
        assert!(
            code.contains(
                "pub enum NoteBodyValue {\n    NoteBody(NoteBody),\n    List(Vec<NoteBody>),\n}"
            ),
            "{code}"
        );
        assert!(code.contains("pub body: Option<NoteBodyValue>,"), "{code}");
    }
}
