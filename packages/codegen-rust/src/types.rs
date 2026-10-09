//! Rust types from component schemas (JSON Schema draft 7, as
//! `draft7_definitions` writes them): a struct per object, an enum per string
//! enumeration, an untagged enum per `oneOf` or `anyOf`, an alias per named
//! string, a type of its own per kind of id, a field per property, optional
//! where the schema does not require it. It knows the shapes the spec's schemas use and refuses any other, so a
//! schema that grows a new shape fails the build rather than generating
//! something wrong.
//!
//! A union is written untagged. One whose schema names the property its
//! members are told apart by (`status`, `jobType`, `motivation`), each member
//! stating its own one value of it, is decoded as the member that value
//! names, and a value that is wrong is refused for what is wrong with it. Any
//! other is decoded as the first member that fits: its members are told apart
//! by what they are — text, a list, an object — or, between objects, by one
//! being the empty object or by being closed with no required property in
//! common. A member's one value of such a property is its own to state:
//! `new` sets it and takes the rest. What the schema says that a type cannot — a pattern, a length, a
//! bound — is the validators' to hold at the boundary, before a value is
//! decoded. A kind of id is the exception: its pattern is written as the
//! check its only constructor makes, and decoding goes through that
//! constructor, so a value of the type has always passed its rule.

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
    /// The schemas that are kinds of id (specs/src/identifiers/kinds.json).
    /// Each is a type of its own and not an alias, and a value of it is made
    /// only by a constructor that holds it to the schema's pattern.
    pub identifiers: &'a [&'a str],
}

const EMPTY_OBJECT: &str = "EmptyObject";
/// The key the `stated` helper is written under: no schema is named so.
const STATED: &str = "fn stated";
/// What a constructor of a kind of id refuses with.
const INVALID_IDENTIFIER: &str = "InvalidIdentifier";

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
        schema["type"] == "string" && schema.get("enum").is_none()
    }

    /// The Rust type of a value `owner`'s property `property` holds.
    fn type_of(&mut self, owner: &str, property: &str, schema: &Value) -> String {
        if let Some(name) = reference(schema) {
            return self.named(name);
        }
        if schema.as_object().is_some_and(|o| o.is_empty()) {
            return "serde_json::Value".to_owned();
        }
        refuse_const(&format!("{owner}.{property}"), schema);
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
            for member in members {
                refuse_const(&format!("{owner}.{property}"), member);
            }
            if members.iter().all(|m| self.is_string(m)) {
                return "String".to_owned();
            }
            return self.inline(&self.inline_name(owner, property), schema);
        }
        match schema["type"].as_str() {
            Some("string") if schema.get("enum").is_some() => {
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
            let told_apart = schema["discriminator"]["propertyName"]
                .as_str()
                .and_then(|property| Some((property, self.tags(property, members)?)));
            return self.union_declaration(name, members, told_apart, code);
        }
        let merged;
        let schema = match schema["allOf"].as_array() {
            Some(members) => {
                merged = self.merged(name, members);
                &merged
            }
            None => schema,
        };
        refuse_const(name, schema);
        if let Some(values) = schema["enum"].as_array() {
            if schema["type"] != "string" {
                panic!("{name}: only string enumerations are generated");
            }
            code.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Deserialize, serde::Serialize)]\n");
            let _ = writeln!(code, "pub enum {name} {{");
            let mut taken: Vec<String> = Vec::new();
            let mut spellings = String::new();
            for value in values {
                let value = value
                    .as_str()
                    .unwrap_or_else(|| panic!("{name}: an enum value is not a string"));
                let variant = variant_of(value);
                if taken.contains(&variant) {
                    panic!("{name}: two enum values would both be the variant {variant}");
                }
                let _ = writeln!(code, "    #[serde(rename = \"{value}\")]\n    {variant},");
                let _ = writeln!(spellings, "            {name}::{variant} => {value:?},");
                taken.push(variant);
            }
            code.push_str("}\n\n");
            let _ = writeln!(
                code,
                "impl {name} {{\n    /// The value as the wire spells it.\n    pub const fn as_str(&self) -> &'static str {{\n        match self {{\n{spellings}        }}\n    }}\n}}\n"
            );
            return code;
        }
        if self.generation.identifiers.contains(&name) {
            return self.identifier(name, schema, code);
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
        // What `new` is given, and what it sets: each required field from its
        // parameter, each optional one to nothing.
        let mut parameters: Vec<String> = Vec::new();
        let mut set: Vec<String> = Vec::new();
        let mut optional = 0;
        let mut single_valued = 0;
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
                parameters.push(format!("{field}: Option<{rust_type}>"));
                set.push(format!("{field},"));
            } else if required.contains(&property.as_str())
                && let Some(only) = only_value(property_schema)
            {
                // A property that admits one value says which member of a
                // union this is. It is the type's to state, not its maker's.
                single_valued += 1;
                let _ = writeln!(code, "    pub {field}: {rust_type},");
                set.push(format!("{field}: {rust_type}::{},", variant_of(only)));
            } else if required.contains(&property.as_str()) && rust_type == "String" {
                let _ = writeln!(code, "    pub {field}: {rust_type},");
                parameters.push(format!("{field}: impl Into<String>"));
                set.push(format!("{field}: {field}.into(),"));
            } else if required.contains(&property.as_str()) {
                let _ = writeln!(code, "    pub {field}: {rust_type},");
                parameters.push(format!("{field}: {rust_type}"));
                set.push(format!("{field},"));
            } else if nullable {
                optional += 1;
                set.push(format!("{field}: None,"));
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
                optional += 1;
                set.push(format!("{field}: None,"));
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
        // A struct that must state some properties and may leave others out
        // is made from the ones it must state, and so is one with a property
        // that admits a single value, which `new` states for it. One whose
        // every property is the caller's to give says everything by name when
        // it is written out, and one that is all optional has nothing to be
        // made from: neither has a constructor.
        if (!parameters.is_empty() && optional > 0) || single_valued > 0 {
            if open {
                set.push("rest: serde_json::Map::new(),".to_owned());
            }
            if parameters.is_empty() {
                let _ = writeln!(
                    code,
                    "impl Default for {name} {{\n    fn default() -> Self {{\n        Self::new()\n    }}\n}}\n"
                );
            }
            let _ = writeln!(
                code,
                "impl {name} {{\n    /// The `{name}` that states {} and nothing else.",
                if parameters.is_empty() {
                    "what it must"
                } else {
                    "these"
                }
            );
            if parameters.len() > 7 {
                code.push_str("    #[allow(clippy::too_many_arguments)]\n");
            }
            let _ = writeln!(
                code,
                "    pub fn new({}) -> Self {{\n        Self {{",
                parameters.join(", ")
            );
            for field in &set {
                let _ = writeln!(code, "            {field}");
            }
            code.push_str("        }\n    }\n}\n\n");
        }
        code
    }

    /// A kind of id: a string no code can make but through `new`, which
    /// holds it to the schema's pattern. Decoding goes through `new` too, so
    /// an id a peer sent is held to the same rule as one a caller made. It
    /// reads as the text it is (`Deref`), and nothing turns text into it but
    /// the constructor.
    fn identifier(&mut self, name: &str, schema: &Value, mut code: String) -> String {
        if self.definitions.get(INVALID_IDENTIFIER).is_some() {
            panic!("{INVALID_IDENTIFIER} is a schema's name, and the generator's own");
        }
        if schema["type"] != "string" {
            panic!("{name}: a kind of id that is not a string: {schema}");
        }
        let pattern = schema["pattern"]
            .as_str()
            .unwrap_or_else(|| panic!("{name}: a kind of id states no pattern"));
        let check = Rule::of(pattern)
            .unwrap_or_else(|| {
                panic!("{name}: a pattern the generator cannot write as a check: {pattern}")
            })
            .check();
        self.written.entry(INVALID_IDENTIFIER.to_owned()).or_insert_with(|| {
            "/// A string that is not an id of the kind it was to be.\n#[derive(Debug, Clone, PartialEq, Eq)]\npub struct InvalidIdentifier {\n    /// The kind it was to be.\n    pub kind: &'static str,\n    /// The rule of that kind, as the spec writes it.\n    pub pattern: &'static str,\n    pub value: String,\n}\n\nimpl std::fmt::Display for InvalidIdentifier {\n    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n        write!(f, \"{:?} is not a {}: it does not match {}\", self.value, self.kind, self.pattern)\n    }\n}\n\nimpl std::error::Error for InvalidIdentifier {}\n\n".to_owned()
        });
        code.push_str("#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Deserialize, serde::Serialize)]\n#[serde(try_from = \"String\", into = \"String\")]\n");
        let _ = writeln!(code, "pub struct {name}(String);\n");
        let _ = writeln!(
            code,
            "impl {name} {{\n    /// The rule a value is held to, as the spec writes it.\n    pub const PATTERN: &'static str = {pattern:?};\n\n    /// `value` as a `{name}`, or that it is not one.\n    pub fn new(value: impl Into<String>) -> Result<{name}, InvalidIdentifier> {{\n        let value = value.into();\n        if {name}::admits(&value) {{\n            Ok({name}(value))\n        }} else {{\n            Err(InvalidIdentifier {{\n                kind: {name:?},\n                pattern: {name}::PATTERN,\n                value,\n            }})\n        }}\n    }}\n\n    /// Whether `value` passes the rule.\n    pub fn admits(value: &str) -> bool {{\n{check}    }}\n\n    pub fn as_str(&self) -> &str {{\n        &self.0\n    }}\n}}\n"
        );
        let _ = writeln!(
            code,
            "impl std::fmt::Display for {name} {{\n    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {{\n        f.write_str(&self.0)\n    }}\n}}\n\nimpl std::ops::Deref for {name} {{\n    type Target = str;\n\n    fn deref(&self) -> &str {{\n        &self.0\n    }}\n}}\n\nimpl AsRef<str> for {name} {{\n    fn as_ref(&self) -> &str {{\n        &self.0\n    }}\n}}\n\nimpl std::str::FromStr for {name} {{\n    type Err = InvalidIdentifier;\n\n    fn from_str(value: &str) -> Result<{name}, InvalidIdentifier> {{\n        {name}::new(value)\n    }}\n}}\n\nimpl TryFrom<String> for {name} {{\n    type Error = InvalidIdentifier;\n\n    fn try_from(value: String) -> Result<{name}, InvalidIdentifier> {{\n        {name}::new(value)\n    }}\n}}\n\nimpl From<{name}> for String {{\n    fn from(id: {name}) -> String {{\n        id.0\n    }}\n}}\n\nimpl PartialEq<str> for {name} {{\n    fn eq(&self, other: &str) -> bool {{\n        self.0 == other\n    }}\n}}\n\nimpl PartialEq<&str> for {name} {{\n    fn eq(&self, other: &&str) -> bool {{\n        self.0 == *other\n    }}\n}}\n"
        );
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

    /// The value of `property` each member of a union states, when every
    /// member is an object that must state it, each admits one value, and no
    /// two admit the same: the property then says which member a value is.
    fn tags(&self, property: &str, members: &[Value]) -> Option<Vec<String>> {
        let mut tags: Vec<String> = Vec::new();
        for member in members {
            let member = match reference(member) {
                Some(target) => self.schema(target),
                None => member,
            };
            let required = member["required"]
                .as_array()
                .is_some_and(|required| required.iter().any(|r| r == property));
            let tag = only_value(&member["properties"][property]).filter(|_| required)?;
            if tags.iter().any(|taken| taken == tag) {
                return None;
            }
            tags.push(tag.to_owned());
        }
        Some(tags)
    }

    fn union_declaration(
        &mut self,
        name: &str,
        members: &[Value],
        told_apart: Option<(&str, Vec<String>)>,
        mut code: String,
    ) -> String {
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
        let _ = writeln!(
            code,
            "#[derive(Debug, Clone, PartialEq, {}serde::Serialize)]\n#[serde(untagged)]",
            if told_apart.is_some() {
                ""
            } else {
                "serde::Deserialize, "
            }
        );
        let _ = writeln!(code, "pub enum {name} {{");
        for (variant, rust_type) in &variants {
            let _ = writeln!(code, "    {variant}({rust_type}),");
        }
        code.push_str("}\n\n");
        // Told apart by a property, a value is decoded as the one member its
        // property names, and what is wrong with it is said of that member.
        // Decoded as the first member that fits, it could only be said to
        // fit none.
        if let Some((property, tags)) = &told_apart {
            let _ = writeln!(
                code,
                "impl<'de> serde::Deserialize<'de> for {name} {{\n    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {{\n        let value = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;\n        let member = match value.get({property:?}).and_then(serde_json::Value::as_str) {{"
            );
            for (tag, (variant, _)) in tags.iter().zip(&variants) {
                let _ = writeln!(
                    code,
                    "            Some({tag:?}) => serde_json::from_value(value).map({name}::{variant}),"
                );
            }
            let _ = writeln!(
                code,
                "            _ => {{\n                return Err(serde::de::Error::custom({:?}));\n            }}\n        }};\n        member.map_err(serde::de::Error::custom)\n    }}\n}}\n",
                format!(
                    "a {name} states a `{property}` that is one of {}",
                    tags.iter()
                        .map(|tag| format!("`{tag}`"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            );
        }
        // A member that is a schema of its own is the union it belongs to,
        // wherever the union is wanted. A member that is text or a list is
        // not: nothing says which union a `String` was meant for.
        for (member, (variant, rust_type)) in members.iter().zip(&variants) {
            if reference(member).is_some() && !self.is_string(member) {
                let _ = writeln!(
                    code,
                    "impl From<{rust_type}> for {name} {{\n    fn from(member: {rust_type}) -> Self {{\n        {name}::{variant}(member)\n    }}\n}}\n"
                );
            }
        }
        code
    }
}

/// A kind of id's pattern, as the check that holds a value to it. The
/// patterns it knows are the ones the kinds use: anchored at both ends, text
/// every value begins with, and then one set of characters a stated number
/// of times. Anything else is `None`, and the build fails rather than link a
/// regular-expression engine into every client for four rules.
struct Rule {
    prefix: String,
    /// The characters admitted after the prefix, as a predicate over `c`.
    admitted: String,
    least: usize,
    most: Option<usize>,
}

impl Rule {
    fn of(pattern: &str) -> Option<Rule> {
        let body = pattern.strip_prefix('^')?.strip_suffix('$')?;
        let set_at = body.find(['[', '\\'])?;
        let (prefix, rest) = body.split_at(set_at);
        if prefix.contains(['.', '|', '?', '*', '+', '(', ')', '{', '}', '^', '$', ']']) {
            return None;
        }
        let (admitted, times) = match rest.strip_prefix("\\S") {
            Some(times) => ("!c.is_whitespace()".to_owned(), times),
            None => {
                let (set, times) = rest.strip_prefix('[')?.split_once(']')?;
                (Rule::set(set)?, times)
            }
        };
        let (least, most) = match times {
            "+" => (1, None),
            "*" => (0, None),
            _ => {
                let bounds = times.strip_prefix('{')?.strip_suffix('}')?;
                match bounds.split_once(',') {
                    Some((least, "")) => (least.parse().ok()?, None),
                    Some((least, most)) => (least.parse().ok()?, Some(most.parse().ok()?)),
                    None => (bounds.parse().ok()?, Some(bounds.parse().ok()?)),
                }
            }
        };
        Some(Rule {
            prefix: prefix.to_owned(),
            admitted,
            least,
            most,
        })
    }

    /// A character set (`A-Za-z0-9_-`) as a `matches!` over `c`: ranges and
    /// single characters, a `-` at either end being itself.
    fn set(set: &str) -> Option<String> {
        if set.is_empty() || set.starts_with('^') || set.contains(['\\', '[', '\'']) {
            return None;
        }
        let characters: Vec<char> = set.chars().collect();
        let mut arms = Vec::new();
        let mut at = 0;
        while at < characters.len() {
            if at + 2 < characters.len() && characters[at + 1] == '-' {
                arms.push(format!("'{}'..='{}'", characters[at], characters[at + 2]));
                at += 3;
            } else {
                arms.push(format!("'{}'", characters[at]));
                at += 1;
            }
        }
        Some(format!("matches!(c, {})", arms.join(" | ")))
    }

    /// The body of `fn admits(value: &str) -> bool`.
    fn check(&self) -> String {
        let mut code = String::new();
        if !self.prefix.is_empty() {
            let _ = writeln!(
                code,
                "        let Some(value) = value.strip_prefix({:?}) else {{\n            return false;\n        }};",
                self.prefix
            );
        }
        let counted = match (self.least, self.most) {
            (0, None) => None,
            (least, None) => Some(format!("value.chars().count() >= {least}")),
            (least, Some(most)) => Some(format!(
                "({least}..={most}).contains(&value.chars().count())"
            )),
        };
        let all = format!("value.chars().all(|c| {})", self.admitted);
        match counted {
            Some(counted) => {
                let _ = writeln!(code, "        {counted}\n            && {all}");
            }
            None => {
                let _ = writeln!(code, "        {all}");
            }
        }
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
        .find_map(only_value)
}

/// `const` is JSON Schema's and not OpenAPI 3.0's, the dialect the spec is
/// written in. A schema that admits one value states it as an `enum` of one,
/// and one that states it as a `const` would be read here as admitting any.
fn refuse_const(what: &str, schema: &Value) {
    if schema.get("const").is_some() {
        panic!("{what}: `const` is not OpenAPI 3.0: state the one value as an `enum` of one");
    }
}

/// The one string a schema admits, when it admits exactly one.
fn only_value(schema: &Value) -> Option<&str> {
    match schema["enum"].as_array().map(Vec::as_slice) {
        Some([only]) => only.as_str(),
        _ => None,
    }
}

/// The variant an enum value is. A `+` is part of what a value says
/// (`text/x-c++` is not `text/x-c`), so it is spelled rather than dropped.
fn variant_of(value: &str) -> String {
    pascal(&value.replace('+', " plus "))
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
            | "yield"
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
                identifiers: &[],
            },
        )
    }

    fn identifier(pattern: &str) -> String {
        generate(
            &json!({ "ThingId": { "type": "string", "description": "A thing's id.", "pattern": pattern } }),
            &Generation {
                roots: &["ThingId"],
                elsewhere: None,
                identifiers: &["ThingId"],
            },
        )
    }

    #[test]
    fn a_kind_of_id_is_a_type_of_its_own_that_decodes_through_its_constructor() {
        let code = identifier("^[A-Za-z0-9_-]{1,128}$");
        assert!(!code.contains("pub type ThingId"), "{code}");
        assert!(
            code.contains("/// A thing's id.\n#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Deserialize, serde::Serialize)]\n#[serde(try_from = \"String\", into = \"String\")]\npub struct ThingId(String);"),
            "{code}"
        );
        assert!(
            code.contains(
                "pub fn new(value: impl Into<String>) -> Result<ThingId, InvalidIdentifier>"
            ),
            "{code}"
        );
        assert!(code.contains("pub struct InvalidIdentifier"), "{code}");
        // Read as the text it is, wherever text is wanted.
        assert!(
            code.contains("impl std::ops::Deref for ThingId {\n    type Target = str;"),
            "{code}"
        );
    }

    #[test]
    fn a_kind_of_ids_rule_is_written_as_its_check() {
        let name = identifier("^[A-Za-z0-9_-]{1,128}$");
        assert!(
            name.contains("(1..=128).contains(&value.chars().count())\n            && value.chars().all(|c| matches!(c, 'A'..='Z' | 'a'..='z' | '0'..='9' | '_' | '-'))"),
            "{name}"
        );
        assert!(
            name.contains("pub const PATTERN: &'static str = \"^[A-Za-z0-9_-]{1,128}$\";"),
            "{name}"
        );
        let did = identifier("^did:\\S+$");
        assert!(
            did.contains("let Some(value) = value.strip_prefix(\"did:\") else {\n            return false;\n        };\n        value.chars().count() >= 1\n            && value.chars().all(|c| !c.is_whitespace())"),
            "{did}"
        );
    }

    #[test]
    #[should_panic(expected = "ThingId: a pattern the generator cannot write as a check")]
    fn a_kind_of_id_whose_rule_cannot_be_written_as_a_check_is_refused() {
        identifier("^e-[^:]+:[^:]+:.+$");
    }

    #[test]
    #[should_panic(expected = "ThingId: a kind of id states no pattern")]
    fn a_kind_of_id_with_no_rule_is_refused() {
        generate(
            &json!({ "ThingId": { "type": "string" } }),
            &Generation {
                roots: &["ThingId"],
                elsewhere: None,
                identifiers: &["ThingId"],
            },
        );
    }

    #[test]
    fn a_property_that_refers_to_a_kind_of_id_is_of_its_type() {
        let code = generate(
            &json!({
                "ThingId": { "type": "string", "pattern": "^[a-z]+$" },
                "Holder": { "type": "object", "required": ["thing"], "properties": {
                    "thing": { "$ref": "#/definitions/ThingId" },
                    "others": { "type": "array", "items": { "$ref": "#/definitions/ThingId" } },
                    "maybe": { "anyOf": [{ "$ref": "#/definitions/ThingId" }, { "type": "null" }] }
                } }
            }),
            &Generation {
                roots: &["Holder"],
                elsewhere: None,
                identifiers: &["ThingId"],
            },
        );
        assert!(code.contains("    pub thing: ThingId,"), "{code}");
        assert!(
            code.contains("    pub others: Option<Vec<ThingId>>,"),
            "{code}"
        );
        assert!(
            code.contains("    pub maybe: Option<Option<ThingId>>,"),
            "{code}"
        );
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
    fn an_enum_says_each_value_as_the_wire_spells_it() {
        let code = generated(
            json!({ "Tone": { "type": "string", "enum": ["scholarly", "text/x-c++"] } }),
            "Tone",
        );
        assert!(
            code.contains(
                "impl Tone {\n    /// The value as the wire spells it.\n    pub const fn as_str(&self) -> &'static str {\n        match self {\n            Tone::Scholarly => \"scholarly\",\n            Tone::TextXCPlusPlus => \"text/x-c++\",\n        }\n    }\n}"
            ),
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

    #[test]
    fn a_struct_with_required_and_optional_properties_is_made_from_the_required_ones() {
        let code = generated(
            json!({ "Ask": { "type": "object", "required": ["title", "cursor"], "additionalProperties": true, "properties": {
                "title": { "type": "string" },
                "note": { "type": "string" },
                "cursor": { "type": ["string", "null"] },
                "page": { "type": ["string", "null"] }
            } } }),
            "Ask",
        );
        assert!(
            code.contains(concat!(
                "impl Ask {\n",
                "    /// The `Ask` that states these and nothing else.\n",
                "    pub fn new(title: impl Into<String>, cursor: Option<String>) -> Self {\n",
                "        Self {\n",
                "            title: title.into(),\n",
                "            note: None,\n",
                "            cursor,\n",
                "            page: None,\n",
                "            rest: serde_json::Map::new(),\n",
                "        }\n",
                "    }\n",
                "}\n",
            )),
            "{code}"
        );
    }

    #[test]
    fn a_struct_that_is_all_required_or_all_optional_has_no_constructor() {
        // Written out, the first says everything it holds by name. The second
        // has no required part to take, and what it is with nothing stated is
        // for whoever knows what nothing means there to say.
        let code = generated(
            json!({
                "Whole": { "type": "object", "required": ["title"], "properties": { "title": { "type": "string" } } },
                "Options": { "type": "object", "properties": { "note": { "type": "string" } } }
            }),
            "Whole",
        ) + &generated(
            json!({ "Options": { "type": "object", "properties": { "note": { "type": "string" } } } }),
            "Options",
        );
        assert!(code.contains("pub struct Whole {"), "{code}");
        assert!(code.contains("pub struct Options {"), "{code}");
        assert!(!code.contains("pub fn new("), "{code}");
    }

    #[test]
    fn a_property_that_admits_one_value_is_stated_by_the_constructor_and_not_asked_for() {
        let code = generated(
            json!({
                "Tagging": { "type": "object", "required": ["motivation", "schemaId"], "additionalProperties": false, "properties": {
                    "motivation": { "type": "string", "enum": ["tagging"] },
                    "schemaId": { "type": "string" },
                    "language": { "type": "string" }
                } }
            }),
            "Tagging",
        );
        assert!(
            code.contains(concat!(
                "    pub fn new(schema_id: impl Into<String>) -> Self {\n",
                "        Self {\n",
                "            motivation: TaggingMotivation::Tagging,\n",
                "            schema_id: schema_id.into(),\n",
                "            language: None,\n",
                "        }\n",
                "    }\n",
            )),
            "{code}"
        );
        assert!(!code.contains("impl Default for Tagging"), "{code}");
    }

    #[test]
    fn a_struct_whose_one_required_property_admits_one_value_is_made_from_nothing() {
        let code = generated(
            json!({ "Yielding": { "type": "object", "required": ["jobType"], "additionalProperties": false, "properties": {
                "jobType": { "enum": ["yield"], "type": "string" }
            } } }),
            "Yielding",
        );
        assert!(
            code.contains(concat!(
                "impl Default for Yielding {\n",
                "    fn default() -> Self {\n",
                "        Self::new()\n",
                "    }\n",
                "}\n",
                "\n",
                "impl Yielding {\n",
                "    /// The `Yielding` that states what it must and nothing else.\n",
                "    pub fn new() -> Self {\n",
                "        Self {\n",
                "            job_type: YieldingJobType::Yield,\n",
                "        }\n",
                "    }\n",
                "}\n",
            )),
            "{code}"
        );
    }

    #[test]
    #[should_panic(expected = "Yielding.jobType: `const` is not OpenAPI 3.0")]
    fn a_value_stated_as_a_const_is_refused() {
        generated(
            json!({ "Yielding": { "type": "object", "required": ["jobType"], "additionalProperties": false, "properties": {
                "jobType": { "const": "yield", "type": "string" }
            } } }),
            "Yielding",
        );
    }

    #[test]
    #[should_panic(expected = "Thing.kind: `const` is not OpenAPI 3.0")]
    fn a_value_stated_as_a_const_in_a_union_of_strings_is_refused() {
        generated(
            json!({ "Thing": { "type": "object", "properties": {
                "kind": { "oneOf": [{ "type": "string", "const": "a" }, { "type": "string", "const": "b" }] }
            } } }),
            "Thing",
        );
    }

    #[test]
    fn a_member_that_is_a_schema_of_its_own_is_its_union_wherever_the_union_is_wanted() {
        let code = generated(
            json!({
                "Named": { "type": "string" },
                "Target": { "type": "object", "properties": { "source": { "type": "string" } }, "required": ["source"] },
                "Holder": { "oneOf": [
                    { "$ref": "#/definitions/Target" },
                    { "$ref": "#/definitions/Named" },
                    { "type": "array", "items": { "$ref": "#/definitions/Target" } }
                ] }
            }),
            "Holder",
        );
        assert!(
            code.contains("impl From<Target> for Holder {\n    fn from(member: Target) -> Self {\n        Holder::Target(member)\n    }\n}"),
            "{code}"
        );
        assert_eq!(code.matches("impl From<").count(), 1, "{code}");
    }

    #[test]
    fn a_union_told_apart_by_a_property_is_decoded_as_the_member_the_property_names() {
        let member = |tag: &str| json!({ "type": "object", "required": ["jobType"], "additionalProperties": false, "properties": { "jobType": { "type": "string", "enum": [tag] } } });
        let code = generated(
            json!({
                "MarkCreate": member("mark"),
                "YieldCreate": member("yield"),
                "Create": {
                    "oneOf": [{ "$ref": "#/definitions/MarkCreate" }, { "$ref": "#/definitions/YieldCreate" }],
                    "discriminator": { "propertyName": "jobType" }
                }
            }),
            "Create",
        );
        assert!(
            code.contains("#[derive(Debug, Clone, PartialEq, serde::Serialize)]\n#[serde(untagged)]\npub enum Create {\n    MarkCreate(MarkCreate),\n    YieldCreate(YieldCreate),\n}"),
            "{code}"
        );
        assert!(
            code.contains(concat!(
                "        let member = match value.get(\"jobType\").and_then(serde_json::Value::as_str) {\n",
                "            Some(\"mark\") => serde_json::from_value(value).map(Create::MarkCreate),\n",
                "            Some(\"yield\") => serde_json::from_value(value).map(Create::YieldCreate),\n",
                "            _ => {\n",
                "                return Err(serde::de::Error::custom(\"a Create states a `jobType` that is one of `mark`, `yield`\"));\n",
            )),
            "{code}"
        );
    }

    #[test]
    fn a_union_whose_members_do_not_each_state_one_value_of_the_property_is_decoded_as_the_first_that_fits()
     {
        // The second member may leave the property out, so the property does
        // not say which member a value is.
        let code = generated(
            json!({
                "Extracted": { "type": "object", "required": ["kind"], "properties": { "kind": { "type": "string", "enum": ["extracted"] } } },
                "Absent": { "type": "object", "properties": { "kind": { "type": "string", "enum": ["absent"] } } },
                "Answer": {
                    "oneOf": [{ "$ref": "#/definitions/Extracted" }, { "$ref": "#/definitions/Absent" }],
                    "discriminator": { "propertyName": "kind" }
                }
            }),
            "Answer",
        );
        assert!(
            code.contains("#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]\n#[serde(untagged)]\npub enum Answer {"),
            "{code}"
        );
        assert!(
            !code.contains("impl<'de> serde::Deserialize<'de> for Answer"),
            "{code}"
        );
    }

    #[test]
    fn a_property_named_by_a_keyword_is_a_raw_field() {
        let code = generated(
            json!({ "Workers": { "type": "object", "properties": {
                "yield": { "type": "string" },
                "type": { "type": "string" }
            } } }),
            "Workers",
        );
        assert!(code.contains("    pub r#yield: Option<String>,"), "{code}");
        assert!(code.contains("    pub r#type: Option<String>,"), "{code}");
        assert!(!code.contains("rename"), "{code}");
    }

    #[test]
    fn a_constructor_of_more_than_seven_says_so_to_the_linter() {
        let names = ["a", "b", "c", "d", "e", "f", "g", "h"];
        let mut properties = serde_json::Map::new();
        for name in names {
            properties.insert(name.to_owned(), json!({ "type": "string" }));
        }
        properties.insert("note".to_owned(), json!({ "type": "string" }));
        let code = generated(
            json!({ "Many": { "type": "object", "required": names, "properties": properties } }),
            "Many",
        );
        assert!(
            code.contains(
                "    #[allow(clippy::too_many_arguments)]\n    pub fn new(a: impl Into<String>,"
            ),
            "{code}"
        );
    }
}
