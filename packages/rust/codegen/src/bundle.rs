//! Bundling specs/src into whole documents: every file `$ref` followed,
//! each file the root document lists under `components` named by its
//! component and the rest inlined, as the published bundles are, and the
//! component schemas as JSON Schema draft 7.

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub fn read_json(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()))
}

pub fn write_json(path: &Path, value: &Value) {
    fs::write(
        path,
        serde_json::to_vec(value).expect("a JSON value serializes"),
    )
    .unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
}

/// One OpenAPI document with every file `$ref` resolved.
pub struct Bundle {
    /// Each file the document names as a component → (kind, name).
    named: BTreeMap<PathBuf, (String, String)>,
    /// The components, resolved, as they will be written.
    components: BTreeMap<String, Map<String, Value>>,
}

impl Bundle {
    pub fn of(root_file: &Path) -> Value {
        let root_file = root_file
            .canonicalize()
            .unwrap_or_else(|e| panic!("{}: {e}", root_file.display()));
        let root = read_json(&root_file);
        let base = root_file
            .parent()
            .expect("a file has a directory")
            .to_path_buf();
        let mut bundle = Bundle {
            named: BTreeMap::new(),
            components: BTreeMap::new(),
        };

        let declared = root
            .get("components")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (kind, entries) in &declared {
            let Some(entries) = entries.as_object() else {
                continue;
            };
            for (name, entry) in entries {
                if let Some(file) = entry.get("$ref").and_then(Value::as_str) {
                    bundle.name(&base.join(file), kind, name);
                }
            }
        }
        let mut document = root.clone();
        for (kind, entries) in &declared {
            let Some(entries) = entries.as_object() else {
                continue;
            };
            for (name, entry) in entries {
                let resolved = match entry.get("$ref").and_then(Value::as_str) {
                    Some(file) => bundle.load(&base.join(file)),
                    None => {
                        let mut inline = entry.clone();
                        bundle.resolve(&mut inline, &base);
                        inline
                    }
                };
                bundle
                    .components
                    .entry(kind.clone())
                    .or_default()
                    .insert(name.clone(), resolved);
            }
        }
        if let Some(object) = document.as_object_mut() {
            object.remove("components");
            for (key, value) in object.iter_mut() {
                if key != "components" {
                    bundle.resolve(value, &base);
                }
            }
        }
        let components: Map<String, Value> = bundle
            .components
            .into_iter()
            .map(|(kind, entries)| (kind, Value::Object(entries)))
            .collect();
        document["components"] = Value::Object(components);
        document
    }

    fn name(&mut self, file: &Path, kind: &str, name: &str) {
        let file = file
            .canonicalize()
            .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        if let Some((k, n)) = self.named.get(&file)
            && (k.as_str(), n.as_str()) != (kind, name)
        {
            panic!("{} is named both {k}/{n} and {kind}/{name}", file.display());
        }
        self.named.insert(file, (kind.to_owned(), name.to_owned()));
    }

    /// A file's contents, with every `$ref` in it resolved relative to it.
    fn load(&mut self, file: &Path) -> Value {
        let file = file
            .canonicalize()
            .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        let mut value = read_json(&file);
        let base = file.parent().expect("a file has a directory").to_path_buf();
        self.resolve(&mut value, &base);
        value
    }

    fn resolve(&mut self, node: &mut Value, base: &Path) {
        match node {
            Value::Array(items) => items.iter_mut().for_each(|item| self.resolve(item, base)),
            Value::Object(object) => {
                if let Some(reference) = object
                    .get("$ref")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                {
                    let (file, pointer) = reference
                        .split_once('#')
                        .unwrap_or((reference.as_str(), ""));
                    if file.is_empty() {
                        panic!(
                            "an internal $ref {reference} in a file under {}: specs/src refers by file",
                            base.display()
                        );
                    }
                    if !pointer.is_empty() {
                        panic!(
                            "$ref {reference} under {} points into a file: specs/src refers to whole files",
                            base.display()
                        );
                    }
                    let target = base.join(file).canonicalize().unwrap_or_else(|e| {
                        panic!("$ref {reference} under {}: {e}", base.display())
                    });
                    let named = self.named.get(&target).cloned().or_else(|| {
                        let kind = target.parent()?.file_name()?.to_str()?.to_owned();
                        let name = target.file_stem()?.to_str()?.to_owned();
                        (kind == "schemas" || kind == "responses").then_some((kind, name))
                    });
                    match named {
                        Some((kind, name)) => {
                            if !self.named.contains_key(&target) {
                                self.name(&target, &kind, &name);
                                let resolved = self.load(&target);
                                self.components
                                    .entry(kind.clone())
                                    .or_default()
                                    .insert(name.clone(), resolved);
                            }
                            *node = json!({ "$ref": format!("#/components/{kind}/{name}") });
                        }
                        None => *node = self.load(&target),
                    }
                    return;
                }
                object
                    .values_mut()
                    .for_each(|value| self.resolve(value, base));
            }
            _ => {}
        }
    }
}

/// The document's component schemas as JSON Schema draft 7, under
/// `definitions`: `nullable` beside a `type` adds `null` to it; beside
/// anything else it becomes `anyOf: [{type: null}, <the rest>]`.
pub fn draft7_definitions(document: &Value) -> Value {
    let mut schemas = document["components"]["schemas"].clone();
    fn convert(node: &mut Value) {
        match node {
            Value::Array(items) => items.iter_mut().for_each(convert),
            Value::Object(object) => {
                if let Some(Value::String(reference)) = object.get_mut("$ref")
                    && let Some(name) = reference.strip_prefix("#/components/schemas/")
                {
                    *reference = format!("#/definitions/{name}");
                }
                if object.get("nullable") == Some(&Value::Bool(true)) {
                    object.remove("nullable");
                    match object.get("type").cloned() {
                        Some(Value::String(kind)) => {
                            object.insert("type".into(), json!([kind, "null"]));
                        }
                        _ => {
                            let inner = Value::Object(std::mem::take(object));
                            object.insert("anyOf".into(), json!([{ "type": "null" }, inner]));
                        }
                    }
                }
                object.values_mut().for_each(convert);
            }
            _ => {}
        }
    }
    convert(&mut schemas);
    json!({ "$schema": "http://json-schema.org/draft-07/schema#", "definitions": schemas })
}
