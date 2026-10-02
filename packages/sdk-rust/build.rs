//! Generates, from specs/src, what this SDK's clients hold of the protocol:
//!
//! - `types.rs`: the body of every request and response the API declares but
//!   the ones a service only passes through (`PASSED_THROUGH`), the schemas
//!   of the job protocol's channels, and the reads a job's admission makes,
//!   with every schema they reach (semiont-codegen);
//! - `operations.rs`: the bus registry's operations, which reply and which
//!   failure answer each request, and which of them report inference limits;
//! - `channels.rs`: the channels every client hears and the channels a
//!   resource's scope carries, from the registry's `audience`; and a type per
//!   channel naming its payload's type, with each operation's request tied to
//!   its result and its failure;
//! - `error_codes.rs`: the codes a client reports and what maps onto them
//!   (errors/codes.json);
//! - `oauth_clients.rs`: the ids a client signs in under at an issuer, and
//!   the scope it asks for (session/oauth.json);
//! - `sign_in.rs`: an entry of the store `semiont login` keeps
//!   (sign-in-store/SignIn.json);
//! - `timing.rs`: the deadlines, retry budgets and stream cadences a client
//!   keeps (client/timing.json);
//! - `cache_refresh.rs`: what each event on the bus, and the reopening of a
//!   dropped stream, does to a client's cache (client/refresh.json).

use semiont_codegen::bundle::{Bundle, draft7_definitions, read_json};
use semiont_codegen::types::{Generation, generate, pascal};
use serde_json::Value;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

/// The schemas generated beside the API's bodies and the channels' payloads:
/// the job the queue holds, the parameters a generation job is created with,
/// an event of the record as the stream carries it, the log settings every
/// public crate's logging takes, and the document a launcher publishes of the
/// knowledge bases it manages.
const BESIDE: [&str; 7] = [
    "Job",
    "GenerationJobParams",
    "StoredEventResponse",
    "EnrichedResourceEvent",
    "LogLevel",
    "LogFormat",
    "DiscoveryDocument",
];

/// A body that is not JSON: an upload is a multipart form, whose fields
/// `semiont::transport::PutBinaryRequest` carries.
const PASSED_THROUGH: [&str; 1] = ["ResourceUpload"];

/// Every component schema a request or response body of `document`'s paths names.
fn api_bodies(document: &Value) -> Vec<String> {
    fn refs(node: &Value, into: &mut Vec<String>) {
        match node {
            Value::Object(object) => {
                if let Some(name) = object
                    .get("$ref")
                    .and_then(Value::as_str)
                    .and_then(|r| r.strip_prefix("#/components/schemas/"))
                {
                    into.push(name.to_owned());
                }
                object.values().for_each(|v| refs(v, into));
            }
            Value::Array(items) => items.iter().for_each(|v| refs(v, into)),
            _ => {}
        }
    }
    let mut bodies = Vec::new();
    for item in document["paths"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.values())
    {
        for operation in item.as_object().into_iter().flat_map(|o| o.values()) {
            refs(&operation["requestBody"], &mut bodies);
            for response in operation["responses"]
                .as_object()
                .into_iter()
                .flat_map(|r| r.values())
            {
                let response = match response["$ref"]
                    .as_str()
                    .and_then(|r| r.strip_prefix("#/components/responses/"))
                {
                    Some(name) => &document["components"]["responses"][name],
                    None => response,
                };
                refs(&response["content"], &mut bodies);
            }
        }
    }
    bodies
}

fn main() {
    let crate_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let specs = crate_dir.join("../../specs/src");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    println!("cargo:rerun-if-changed={}", specs.display());

    let registry = read_json(&specs.join("bus/registry.json"));
    let channels = registry["channels"]
        .as_array()
        .expect("the bus registry lists channels");
    // Every channel's payload: the schema it names, or, of an event of the
    // record, the schema of the event's own payload.
    let mut roots: Vec<String> = channels
        .iter()
        .filter_map(|c| {
            c["schema"]
                .as_str()
                .or(c["payload"].as_str())
                .map(str::to_owned)
        })
        .collect();
    let document = Bundle::of(&specs.join("openapi.json"));
    roots.extend(
        api_bodies(&document)
            .into_iter()
            .filter(|body| !PASSED_THROUGH.contains(&body.as_str())),
    );
    roots.extend(BESIDE.iter().map(|s| (*s).to_owned()));
    roots.sort();
    roots.dedup();
    let roots: Vec<&str> = roots.iter().map(String::as_str).collect();

    let definitions = draft7_definitions(&document);
    fs::write(
        out.join("types.rs"),
        generate(
            &definitions["definitions"],
            &Generation {
                roots: &roots,
                elsewhere: None,
            },
        ),
    )
    .expect("cannot write types.rs");

    let mut operations = String::from(
        "// Generated from specs/src/bus/registry.json; do not edit.\npub const OPERATIONS: &[Operation] = &[\n",
    );
    for op in registry["operations"]
        .as_array()
        .expect("the bus registry lists operations")
    {
        let field = |key: &str| {
            op[key]
                .as_str()
                .unwrap_or_else(|| panic!("a registry operation has no {key}: {op}"))
                .to_owned()
        };
        let _ = writeln!(
            operations,
            "    Operation {{ request: {:?}, result: {:?}, failure: {:?} }},",
            field("request"),
            field("result"),
            field("failure")
        );
    }
    operations.push_str("];\n");
    // One operation per service that holds inference credentials, each named
    // `<flow>:limits-requested`: a new key holder's joins by being registered.
    operations.push_str(
        "/// The operations that report the limits of the models a service holds credentials for.\npub const LIMITS_OPERATIONS: &[&str] = &[\n",
    );
    for op in list(&registry["operations"], "operations") {
        let request = text(op, "request", "a registry operation");
        if request.ends_with(":limits-requested") {
            let _ = writeln!(operations, "    {request:?},");
        }
    }
    operations.push_str("];\n");
    fs::write(out.join("operations.rs"), operations).expect("cannot write operations.rs");

    fs::write(
        out.join("channels.rs"),
        channels_of(&registry) + &typed_channels(&registry, &definitions["definitions"]),
    )
    .expect("cannot write channels.rs");
    fs::write(
        out.join("error_codes.rs"),
        error_codes(&read_json(&specs.join("errors/codes.json"))),
    )
    .expect("cannot write error_codes.rs");
    fs::write(
        out.join("sign_in.rs"),
        generate(
            &serde_json::json!({ "SignIn": read_json(&specs.join("sign-in-store/SignIn.json")) }),
            &Generation {
                roots: &["SignIn"],
                elsewhere: None,
            },
        ),
    )
    .expect("cannot write sign_in.rs");
    fs::write(
        out.join("oauth_clients.rs"),
        oauth_clients(&read_json(&specs.join("session/oauth.json"))),
    )
    .expect("cannot write oauth_clients.rs");
    fs::write(
        out.join("timing.rs"),
        timing(&read_json(&specs.join("client/timing.json"))),
    )
    .expect("cannot write timing.rs");
    fs::write(
        out.join("cache_refresh.rs"),
        cache_refresh(&read_json(&specs.join("client/refresh.json"))),
    )
    .expect("cannot write cache_refresh.rs");
}

/// The refresh table as its queries, its triggers and each trigger's rows.
/// The table's own generator (scripts/spec/generate-cache-refresh.mjs) is
/// where it is held to account; this refuses only what it cannot render.
fn cache_refresh(table: &Value) -> String {
    let mut code = String::from("// Generated from specs/src/client/refresh.json; do not edit.\n");
    let queries: Vec<&str> = list(&table["queries"], "queries")
        .iter()
        .map(|query| text(query, "name", "a query"))
        .collect();
    code.push_str("/// The live queries a client's cache answers.\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub enum CacheQuery {\n");
    for query in list(&table["queries"], "queries") {
        let name = text(query, "name", "a query");
        let _ = writeln!(
            code,
            "    /// {}\n    {},",
            text(query, "docs", name),
            pascal(name)
        );
    }
    code.push_str("}\n\nimpl CacheQuery {\n    /// Every query, in the table's order.\n    pub const ALL: &'static [CacheQuery] = &[\n");
    for name in &queries {
        let _ = writeln!(code, "        CacheQuery::{},", pascal(name));
    }
    code.push_str("    ];\n\n    /// The query's name, as the table and every SDK spell it.\n    pub const fn name(self) -> &'static str {\n        match self {\n");
    for name in &queries {
        let _ = writeln!(
            code,
            "            CacheQuery::{} => {name:?},",
            pascal(name)
        );
    }
    code.push_str("        }\n    }\n}\n\n");

    // A trigger per distinct `on`, in the table's order, with its rows.
    let mut triggers: Vec<(&str, Vec<&Value>)> = Vec::new();
    for row in list(&table["refresh"], "refresh") {
        let on = text(row, "on", "a refresh row");
        match triggers.iter_mut().find(|(named, _)| *named == on) {
            Some((_, rows)) => rows.push(row),
            None => triggers.push((on, vec![row])),
        }
    }
    code.push_str("/// What refreshes a cache: the events of a channel, or `Reopened`, the stream open again after a drop.\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub enum RefreshTrigger {\n");
    for (on, rows) in &triggers {
        let docs: Vec<&str> = rows.iter().map(|row| text(row, "docs", on)).collect();
        let _ = writeln!(code, "    /// {}\n    {},", docs.join(" "), pascal(on));
    }
    code.push_str("}\n\nimpl RefreshTrigger {\n    /// Every trigger, in the table's order.\n    pub const ALL: &'static [RefreshTrigger] = &[\n");
    for (on, _) in &triggers {
        let _ = writeln!(code, "        RefreshTrigger::{},", pascal(on));
    }
    code.push_str("    ];\n\n    /// The channel whose events are this trigger; none of `Reopened`, which is the stream's own.\n    pub const fn channel(self) -> Option<&'static str> {\n        match self {\n");
    for (on, _) in &triggers {
        if *on == "reopened" {
            let _ = writeln!(code, "            RefreshTrigger::{} => None,", pascal(on));
        } else {
            let _ = writeln!(
                code,
                "            RefreshTrigger::{} => Some({on:?}),",
                pascal(on)
            );
        }
    }
    code.push_str("        }\n    }\n\n    /// What this trigger does: one row, or two for a channel whose events come two ways.\n    pub const fn rows(self) -> &'static [CacheRefresh] {\n        match self {\n");
    let listed = |row: &Value, key: &str, on: &str| -> String {
        let named: Vec<String> = match &row[key] {
            Value::Null => Vec::new(),
            stated => list(stated, key)
                .iter()
                .map(|query| {
                    let name = query
                        .as_str()
                        .unwrap_or_else(|| panic!("{on}: a {key} entry is not a query's name"));
                    if !queries.contains(&name) {
                        panic!("{on} {key} {name}, which is no query of the table");
                    }
                    // What this SDK can do without asking: an event carries
                    // an annotation's new value, and says an annotation is
                    // gone. A row that says more needs code that reads it.
                    let able = match key {
                        "writes" => matches!(name, "annotations" | "annotation"),
                        "removes" => name == "annotation",
                        _ => true,
                    };
                    if !able {
                        panic!("{on} {key} {name}, which no event this SDK reads says how to");
                    }
                    format!("CacheQuery::{}", pascal(name))
                })
                .collect(),
        };
        format!("&[{}]", named.join(", "))
    };
    for (on, rows) in &triggers {
        let rendered: Vec<String> = rows
            .iter()
            .map(|row| {
                let when = match row["when"].as_str() {
                    None => "None".to_owned(),
                    Some(when @ ("enriched" | "unenriched")) => {
                        format!("Some(RefreshWhen::{})", pascal(when))
                    }
                    Some(other) => panic!("{on}: `when` is {other}, which is neither kind of event"),
                };
                let reach = match row["reach"].as_str() {
                    None | Some("subject") => "Subject",
                    Some("held") => "Held",
                    Some(other) => panic!("{on}: `reach` is {other}, which is neither"),
                };
                format!(
                    "CacheRefresh {{ when: {when}, reach: Reach::{reach}, refetches: {}, writes: {}, removes: {} }}",
                    listed(row, "refetches", on),
                    listed(row, "writes", on),
                    listed(row, "removes", on)
                )
            })
            .collect();
        let _ = writeln!(
            code,
            "            RefreshTrigger::{} => &[{}],",
            pascal(on),
            rendered.join(", ")
        );
    }
    code.push_str("        }\n    }\n}\n");
    code
}

fn text<'a>(value: &'a Value, key: &str, of: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{of} has no {key}: {value}"))
}

fn list<'a>(value: &'a Value, of: &str) -> &'a Vec<Value> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{of} is not a list: {value}"))
}

/// The registry's `audience`: `everyone`, with every operation's reply
/// channels, is what a client with no narrower list of its own subscribes to;
/// `scoped` is what taking a resource's scope adds.
fn channels_of(registry: &Value) -> String {
    let names = |audience: &str| -> Vec<String> {
        list(&registry["audience"][audience], audience)
            .iter()
            .map(|c| {
                c.as_str()
                    .unwrap_or_else(|| panic!("audience.{audience} names a non-string: {c}"))
                    .to_owned()
            })
            .collect()
    };
    let mut bridged: Vec<String> = Vec::new();
    for op in list(&registry["operations"], "operations") {
        for reply in ["result", "failure"] {
            bridged.push(text(op, reply, "a registry operation").to_owned());
        }
    }
    bridged.extend(names("everyone"));
    let scoped = names("scoped");
    if let Some(both) = scoped.iter().find(|c| bridged.contains(c)) {
        panic!("{both} is delivered both globally and per scope: a client would be given it twice");
    }
    let mut code = String::from("// Generated from specs/src/bus/registry.json; do not edit.\n");
    let mut constant = |docs: &str, name: &str, channels: &[String]| {
        let _ = writeln!(code, "/// {docs}\npub const {name}: &[&str] = &[");
        for channel in channels {
            let _ = writeln!(code, "    {channel:?},");
        }
        code.push_str("];\n");
    };
    constant(
        "The channels a client hears globally unless it names a narrower list: every operation's result and failure, and the events sent to every client.",
        "BRIDGED_CHANNELS",
        &bridged,
    );
    constant(
        "The channels a resource's scope carries: what holding a resource adds to a client's stream.",
        "RESOURCE_SCOPED_CHANNELS",
        &scoped,
    );
    code
}

/// The properties a schema declares whose names begin with `_`: the stamps a
/// gateway puts on a payload that this payload's type reads.
fn stamps(definitions: &Value, schema: &Value) -> Vec<String> {
    let schema = match schema["$ref"]
        .as_str()
        .and_then(|r| r.strip_prefix("#/definitions/"))
    {
        Some(name) => &definitions[name],
        None => schema,
    };
    let mut declared: Vec<String> = schema["properties"]
        .as_object()
        .into_iter()
        .flat_map(|properties| properties.keys())
        .filter(|name| name.starts_with('_'))
        .cloned()
        .collect();
    for key in ["allOf", "oneOf", "anyOf"] {
        for member in schema[key].as_array().into_iter().flatten() {
            declared.extend(stamps(definitions, member));
        }
    }
    declared.sort();
    declared.dedup();
    declared
}

/// A type per channel, named for it (`job:create` is `JobCreate`), whose
/// `Channel::Payload` is the type the registry's `shape` gives its payload;
/// and for each operation, its request tied to its result and its failure.
fn typed_channels(registry: &Value, definitions: &Value) -> String {
    let mut code = String::new();
    let mut markers: Vec<String> = Vec::new();
    for channel in list(&registry["channels"], "channels") {
        let name = text(channel, "channel", "a registry channel");
        let marker = pascal(name);
        if markers.contains(&marker) {
            panic!("two channels would both be the type {marker}");
        }
        markers.push(marker.clone());
        let schema = || format!("crate::types::{}", text(channel, "schema", name));
        let (payload, declared) = match text(channel, "shape", name) {
            "schema" => (
                schema(),
                stamps(definitions, &definitions[text(channel, "schema", name)]),
            ),
            "envelope" => (format!("Response<{}>", schema()), Vec::new()),
            "storedEvent" if channel["enriched"] == true => {
                ("crate::types::EnrichedResourceEvent".to_owned(), Vec::new())
            }
            "storedEvent" => ("crate::types::StoredEventResponse".to_owned(), Vec::new()),
            "void" | "empty" => ("Empty".to_owned(), Vec::new()),
            other => panic!("{name} has the shape {other}, which has no Rust type"),
        };
        let _ = writeln!(
            code,
            "/// `{name}`\npub struct {marker};\nimpl Channel for {marker} {{\n    const NAME: &'static str = {name:?};\n    const STAMPS: &'static [&'static str] = &{declared:?};\n    type Payload = {payload};\n}}"
        );
        if channel["shape"] == "storedEvent" {
            let _ = writeln!(
                code,
                "impl Recorded for {marker} {{\n    type Event = crate::types::{};\n    fn event(stored: &Self::Payload) -> Result<Self::Event, serde_json::Error> {{\n        serde_json::from_value(serde_json::Value::Object(stored.payload.clone()))\n    }}\n}}",
                text(channel, "payload", name)
            );
        }
    }
    for op in list(&registry["operations"], "operations") {
        let marker = |key: &str| {
            let marker = pascal(text(op, key, "a registry operation"));
            if !markers.contains(&marker) {
                panic!("an operation's {key} is not a channel of the registry: {op}");
            }
            marker
        };
        let _ = writeln!(
            code,
            "impl Request for {} {{\n    type Result = {};\n    type Failure = {};\n}}",
            marker("request"),
            marker("result"),
            marker("failure")
        );
    }
    code
}

/// A code's variant: its last dot-separated part, in PascalCase.
fn variant(code: &str) -> String {
    pascal(code.rsplit('.').next().unwrap_or(code))
}

/// One vocabulary of errors/codes.json as an enum whose `as_str` is the code.
fn code_enum(code: &mut String, name: &str, vocabulary: &Value) -> Vec<(String, Value)> {
    let entries: Vec<(String, Value)> = list(&vocabulary["codes"], name)
        .iter()
        .map(|entry| (text(entry, "code", name).to_owned(), entry.clone()))
        .collect();
    let _ = writeln!(
        code,
        "/// {}\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub enum {name} {{",
        text(vocabulary, "docs", name)
    );
    for (value, entry) in &entries {
        let _ = writeln!(
            code,
            "    /// {}\n    {},",
            text(entry, "docs", value),
            variant(value)
        );
    }
    let _ = writeln!(
        code,
        "}}\n\nimpl {name} {{\n    /// The code as every SDK reports it.\n    pub const fn as_str(self) -> &'static str {{\n        match self {{"
    );
    for (value, _) in &entries {
        let _ = writeln!(code, "            {name}::{} => {value:?},", variant(value));
    }
    code.push_str("        }\n    }\n}\n\n");
    entries
}

fn error_codes(table: &Value) -> String {
    let mut code = String::from("// Generated from specs/src/errors/codes.json; do not edit.\n");

    let bus = code_enum(&mut code, "BusRequestErrorCode", &table["busRequest"]);
    let unrecognized = text(&table["busRequest"], "unrecognizedFailure", "busRequest");
    if !bus.iter().any(|(value, _)| value == unrecognized) {
        panic!(
            "busRequest.unrecognizedFailure names {unrecognized}, which is not one of its codes"
        );
    }
    code.push_str(
        "impl BusRequestErrorCode {\n    /// The code a failure's own code (`CommandError.code`) becomes; one it states none of, or one this vocabulary does not name, is the table's `unrecognizedFailure`.\n    pub fn of_wire(code: Option<&str>) -> BusRequestErrorCode {\n        match code {\n",
    );
    for (value, entry) in &bus {
        if let Some(wire) = entry["wire"].as_str() {
            let _ = writeln!(
                code,
                "            Some({wire:?}) => BusRequestErrorCode::{},",
                variant(value)
            );
        }
    }
    let _ = writeln!(
        code,
        "            _ => BusRequestErrorCode::{},\n        }}\n    }}\n",
        variant(unrecognized)
    );
    code.push_str(
        "    /// The wire code a peer stated, when this code restates one: what a service answers its own caller with. A failure only this side knows states none.\n    pub const fn wire(self) -> Option<crate::types::CommandErrorCode> {\n        match self {\n",
    );
    for (value, entry) in &bus {
        if let Some(wire) = entry["wire"].as_str() {
            let _ = writeln!(
                code,
                "            BusRequestErrorCode::{} => Some(crate::types::CommandErrorCode::{}),",
                variant(value),
                pascal(wire)
            );
        }
    }
    code.push_str("            _ => None,\n        }\n    }\n}\n\n");

    let transport = code_enum(&mut code, "TransportErrorCode", &table["transport"]);
    let unclassified = text(&table["transport"], "unclassified", "transport");
    if !transport.iter().any(|(value, _)| value == unclassified) {
        panic!("transport.unclassified names {unclassified}, which is not one of its codes");
    }
    code.push_str(
        "impl TransportErrorCode {\n    /// The code an HTTP status becomes.\n    pub const fn of_status(status: u16) -> TransportErrorCode {\n        match status {\n",
    );
    for (value, entry) in &transport {
        if let Some(status) = entry["status"].as_u64() {
            let _ = writeln!(
                code,
                "            {status} => TransportErrorCode::{},",
                variant(value)
            );
        }
    }
    let mut from: Vec<(u64, &String)> = transport
        .iter()
        .filter_map(|(value, entry)| entry["statusFrom"].as_u64().map(|status| (status, value)))
        .collect();
    from.sort_by_key(|(status, _)| std::cmp::Reverse(*status));
    for (status, value) in from {
        let _ = writeln!(
            code,
            "            {status}.. => TransportErrorCode::{},",
            variant(value)
        );
    }
    let _ = writeln!(
        code,
        "            _ => TransportErrorCode::{},\n        }}\n    }}\n}}\n",
        variant(unclassified)
    );

    code_enum(&mut code, "JobErrorCode", &table["job"]);
    code_enum(&mut code, "SessionErrorCode", &table["session"]);
    code_enum(&mut code, "SignInErrorCode", &table["signIn"]);
    code_enum(
        &mut code,
        "IdentityUnverifiableReason",
        &table["kbIdentity"],
    );
    code
}

/// Each client's id as `<NAME>_CLIENT_ID`, and the scope a sign-in asks for.
fn oauth_clients(table: &Value) -> String {
    let mut code = String::from("// Generated from specs/src/session/oauth.json; do not edit.\n");
    for client in list(&table["clients"], "clients") {
        let _ = writeln!(
            code,
            "/// {}\npub const {}_CLIENT_ID: &str = {:?};",
            text(client, "docs", "a client"),
            text(client, "name", "a client").to_ascii_uppercase(),
            text(client, "id", "a client")
        );
    }
    let scope = &table["scope"];
    let _ = writeln!(
        code,
        "/// {}\npub const SIGN_IN_SCOPE: &str = {:?};",
        text(scope, "docs", "scope"),
        text(scope, "value", "scope")
    );
    code
}

/// `busRequestTimeoutMs` as `BUS_REQUEST_TIMEOUT_MS`.
fn screaming(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
        }
        out.push(c.to_ascii_uppercase());
    }
    out
}

/// Each entry by the kind its name's ending states: `Ms` a duration, `Retry`
/// a budget, `Count` a whole number.
fn timing(table: &Value) -> String {
    let mut code = String::from("// Generated from specs/src/client/timing.json; do not edit.\n");
    for entry in list(&table["timing"], "timing") {
        let name = text(entry, "name", "a timing entry");
        let value = &entry["value"];
        let whole = |key: Option<&str>| -> u64 {
            let stated = match key {
                Some(key) => &value[key],
                None => value,
            };
            stated
                .as_u64()
                .unwrap_or_else(|| panic!("{name} is not a whole number: {entry}"))
        };
        let _ = writeln!(code, "/// {}", text(entry, "docs", name));
        if let Some(stem) = name.strip_suffix("Ms") {
            let _ = writeln!(
                code,
                "pub const {}: std::time::Duration = std::time::Duration::from_millis({});",
                screaming(stem),
                whole(None)
            );
        } else if name.ends_with("Retry") {
            let _ = writeln!(
                code,
                "pub const {}: crate::retry::RetryPolicy = crate::retry::RetryPolicy {{ attempts: {}, initial_delay: std::time::Duration::from_millis({}), max_delay: std::time::Duration::from_millis({}) }};",
                screaming(name),
                whole(Some("attempts")),
                whole(Some("initialDelayMs")),
                whole(Some("maxDelayMs"))
            );
        } else if name.ends_with("Count") {
            let _ = writeln!(
                code,
                "pub const {}: usize = {};",
                screaming(name),
                whole(None)
            );
        } else {
            panic!("{name} ends in none of Ms, Retry and Count, so its kind is not stated");
        }
    }
    code
}
