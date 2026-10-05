//! The client's surface against specs/src/client/surface.json: every method
//! the table lists is called as each of its cases states, and what the call
//! did first is held to the row. A row with no call here fails, and so does a
//! call here with no row: the table and this SDK list the same methods.
//!
//! What a method does first is one of: a request of a bus operation, a frame
//! sent over the wire, a frame published on the client's own bus, a call of
//! the content transport, a call of the gateway, or reading a channel of the
//! client's own bus.

use bytes::Bytes;
use semiont::client::SemiontClient;
use semiont::namespaces::{CreateFromTokenOptions, MarkAssistOptions, ResourceFilters};
use semiont::testing::as_id;
use semiont::testing::{
    ContentCall, FaultyTransport, InMemoryContent, StubGateway, TestClientOptions,
    create_test_client,
};
use semiont::transport::{Envelope, Frame, PutBinaryRequest};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::Duration;

/// The SDK this runner is, as the table's `absent` names it.
const SDK: &str = "rust";

fn table() -> Value {
    serde_json::from_str(include_str!("../specs/client/surface.json"))
        .expect("the surface table is JSON")
}

/// `value` with each `{"$fixture": name}` replaced by the table's fixture.
fn resolved(value: &Value, fixtures: &Value) -> Value {
    match value {
        Value::Object(object) => match object.get("$fixture").and_then(Value::as_str) {
            Some(name) if object.len() == 1 => fixtures
                .get(name)
                .unwrap_or_else(|| panic!("the table has no fixture {name}"))
                .clone(),
            _ => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (key.clone(), resolved(value, fixtures)))
                    .collect(),
            ),
        },
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| resolved(item, fixtures)).collect())
        }
        other => other.clone(),
    }
}

/// `value` with every number as the number it is, however it was written:
/// `200` and `200.0` are one JSON number, and a field the schema calls a
/// number is written either way.
fn numbers(value: &Value) -> Value {
    match value {
        Value::Number(number) => number.as_f64().map_or_else(|| value.clone(), |n| json!(n)),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), numbers(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(numbers).collect()),
        other => other.clone(),
    }
}

/// Hold `sent` to what the case states.
#[track_caller]
fn same(sent: &Value, stated: &Value, why: &str) {
    assert_eq!(numbers(sent), numbers(stated), "{why}");
}

fn object(value: &Value) -> Map<String, Value> {
    value
        .as_object()
        .cloned()
        .unwrap_or_else(|| panic!("an object was expected, not {value}"))
}

struct World {
    client: Arc<SemiontClient>,
    transport: FaultyTransport,
    content: InMemoryContent,
    gateway: StubGateway,
}

fn world() -> World {
    let transport = FaultyTransport::new(vec![]);
    let content = InMemoryContent::new();
    let gateway = StubGateway::new();
    let client = create_test_client(TestClientOptions {
        transport: Some(transport.clone()),
        content: Some(content.clone()),
        gateway: Some(Arc::new(gateway.clone())),
        ..TestClientOptions::default()
    })
    .client;
    World {
        client,
        transport,
        content,
        gateway,
    }
}

/// An argument of a case, by the name the table gives it.
struct Args(Map<String, Value>);

impl Args {
    fn text(&self, name: &str) -> String {
        self.0
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("the case states no {name}"))
            .to_owned()
    }

    fn optional_text(&self, name: &str) -> Option<String> {
        self.0.get(name).and_then(Value::as_str).map(str::to_owned)
    }

    /// An argument as the type the method takes.
    fn typed<T: DeserializeOwned>(&self, name: &str) -> T {
        let value = self
            .0
            .get(name)
            .unwrap_or_else(|| panic!("the case states no {name}"));
        serde_json::from_value(value.clone()).unwrap_or_else(|error| {
            panic!("the case's {name} is not what the method takes: {error}")
        })
    }

    fn options(&self) -> Map<String, Value> {
        self.0.get("options").map(object).unwrap_or_default()
    }

    /// The filters a list or a search is given. A filter this SDK has no
    /// field for fails the case rather than going unsent.
    fn filters(&self) -> ResourceFilters {
        let mut filters = ResourceFilters::default();
        for (name, stated) in self.0.get("filters").map(object).unwrap_or_default() {
            match name.as_str() {
                "limit" => filters.limit = stated.as_i64(),
                "archived" => filters.archived = stated.as_bool(),
                "entityType" => filters.entity_type = stated.as_str().map(str::to_owned),
                other => panic!("the case filters by {other}, which ResourceFilters has not"),
            }
        }
        filters
    }
}

/// Every method this SDK's client has, as the table names them.
const METHODS: &[(&str, &[&str])] = &[
    (
        "frame",
        &["addEntityType", "addEntityTypes", "addTagSchema"],
    ),
    (
        "browse",
        &[
            "resource",
            "resources",
            "annotations",
            "annotation",
            "entityTypes",
            "tagSchemas",
            "agents",
            "events",
            "resourceContent",
            "resourceGraph",
            "resourceAnchoredText",
            "resourceRepresentation",
            "resourceRepresentationStream",
            "resourceEvents",
            "annotationHistory",
            "files",
            "kb",
            "click",
            "openResource",
            "resourceViewed",
        ],
    ),
    (
        "mark",
        &[
            "annotation",
            "delete",
            "archive",
            "unarchive",
            "updateEntityTypes",
            "assist",
            "request",
            "requestAssist",
            "submit",
            "cancelPending",
            "dismissProgress",
            "reportDeleteError",
        ],
    ),
    ("bind", &["body", "initiate", "reportBodyError"]),
    ("gather", &["annotation", "resource", "referencedBy"]),
    ("match", &["search", "requestSearch", "resources"]),
    (
        "yield",
        &[
            "resource",
            "fromContext",
            "cloneToken",
            "fromToken",
            "createFromToken",
            "clone",
        ],
    ),
    (
        "beckon",
        &[
            "attention",
            "click",
            "openResource",
            "sparkleAll",
            "hover",
            "sparkle",
        ],
    ),
    (
        "job",
        &[
            "queued",
            "progress",
            "complete",
            "fail",
            "status",
            "pollUntilComplete",
            "cancelByType",
            "cancel",
            "cancelRequest",
        ],
    ),
    ("auth", &["me", "mediaToken", "protectedResourceMetadata"]),
    ("system", &["healthCheck", "status"]),
];

/// Start `namespace.method` as the case states it. A call that is awaited is
/// driven on its own task, and what it resolves with is not this test's to
/// judge: the case holds what it did, not what it was answered.
fn call(world: &World, namespace: &str, method: &str, args: Args) {
    let client = world.client.clone();
    macro_rules! go {
        ($call:expr) => {{
            tokio::spawn(async move {
                let _ = $call.await;
            });
        }};
    }
    match (namespace, method) {
        ("frame", "addEntityType") => {
            let entity_type = args.text("type");
            go!(client.frame.add_entity_type(&entity_type))
        }
        ("frame", "addEntityTypes") => {
            let entity_types: Vec<String> = args.typed("types");
            go!(client.frame.add_entity_types(&entity_types))
        }
        ("frame", "addTagSchema") => go!(client.frame.add_tag_schema(args.typed("schema"))),

        ("browse", "resource") => go!(client
            .browse
            .resource(&as_id(&args.text("resourceId")))
            .fresh()),
        ("browse", "resources") => go!(client.browse.resources(args.filters()).fresh()),
        ("browse", "annotations") => {
            go!(client
                .browse
                .annotations(&as_id(&args.text("resourceId")))
                .fresh())
        }
        ("browse", "annotation") => go!(client
            .browse
            .annotation(
                &as_id(&args.text("resourceId")),
                &as_id(&args.text("annotationId"))
            )
            .fresh()),
        ("browse", "entityTypes") => go!(client.browse.entity_types().fresh()),
        ("browse", "tagSchemas") => go!(client.browse.tag_schemas().fresh()),
        ("browse", "agents") => go!(client.browse.agents().fresh()),
        ("browse", "events") => go!(client
            .browse
            .events(&as_id(&args.text("resourceId")))
            .fresh()),
        ("browse", "resourceContent") => {
            let resource_id = args.text("resourceId");
            go!(client.browse.resource_content(&as_id(&resource_id)))
        }
        ("browse", "resourceGraph") => {
            let resource_id = args.text("resourceId");
            go!(client.browse.resource_graph(&as_id(&resource_id)))
        }
        ("browse", "resourceAnchoredText") => {
            let resource_id = args.text("resourceId");
            go!(client.browse.resource_anchored_text(&as_id(&resource_id)))
        }
        ("browse", "resourceRepresentation") => {
            let resource_id = args.text("resourceId");
            go!(client.browse.resource_representation(&as_id(&resource_id)))
        }
        ("browse", "resourceRepresentationStream") => {
            let resource_id = args.text("resourceId");
            tokio::spawn(async move {
                let _ = client
                    .browse
                    .resource_representation_stream(&as_id(&resource_id))
                    .await
                    .map(|_| ());
            });
        }
        ("browse", "resourceEvents") => {
            let resource_id = args.text("resourceId");
            go!(client.browse.resource_events(&as_id(&resource_id)))
        }
        ("browse", "annotationHistory") => {
            let (resource_id, annotation_id) = (args.text("resourceId"), args.text("annotationId"));
            go!(client
                .browse
                .annotation_history(&as_id(&resource_id), &as_id(&annotation_id)))
        }
        ("browse", "files") => {
            let path = args.optional_text("dirPath");
            let sort = args.0.get("sort").map(|_| args.typed("sort"));
            go!(client.browse.files(path.as_deref(), sort))
        }
        ("browse", "kb") => go!(client.browse.kb()),
        ("browse", "click") => client.browse.click(&as_id(&args.text("annotationId"))),
        ("browse", "openResource") => client
            .browse
            .open_resource(&as_id(&args.text("resourceId"))),
        ("browse", "resourceViewed") => client
            .browse
            .resource_viewed(&as_id(&args.text("resourceId"))),

        ("mark", "annotation") => go!(client.mark.annotation(args.typed("input"))),
        ("mark", "delete") => {
            let (resource_id, annotation_id) = (args.text("resourceId"), args.text("annotationId"));
            go!(client
                .mark
                .delete(&as_id(&resource_id), &as_id(&annotation_id)))
        }
        ("mark", "archive") => {
            let resource_id = args.text("resourceId");
            go!(client.mark.archive(&as_id(&resource_id)))
        }
        ("mark", "unarchive") => {
            let resource_id = args.text("resourceId");
            go!(client.mark.unarchive(&as_id(&resource_id)))
        }
        ("mark", "updateEntityTypes") => {
            let resource_id = args.text("resourceId");
            go!(client.mark.update_entity_types(
                &as_id(&resource_id),
                args.typed("current"),
                args.typed("updated")
            ))
        }
        ("mark", "assist") => {
            let options: MarkAssistOptions = args.typed("options");
            go!(client
                .mark
                .assist(
                    &as_id(&args.text("resourceId")),
                    args.typed("motivation"),
                    options
                )
                .into_future())
        }
        ("mark", "request") => client.mark.request(
            &as_id(&args.text("source")),
            args.typed("selector"),
            args.typed("motivation"),
        ),
        ("mark", "requestAssist") => client
            .mark
            .request_assist(args.typed("motivation"), args.typed("options")),
        ("mark", "submit") => client.mark.submit(args.typed("input")),
        ("mark", "cancelPending") => client.mark.cancel_pending(),
        ("mark", "dismissProgress") => client.mark.dismiss_progress(),
        ("mark", "reportDeleteError") => client.mark.report_delete_error(args.typed("input")),

        ("bind", "body") => {
            let (resource_id, annotation_id) = (args.text("resourceId"), args.text("annotationId"));
            go!(client.bind.body(
                &as_id(&resource_id),
                &as_id(&annotation_id),
                args.typed("operations")
            ))
        }
        ("bind", "initiate") => client.bind.initiate(args.typed("input")),
        ("bind", "reportBodyError") => client.bind.report_body_error(args.typed("input")),

        ("gather", "annotation") => {
            let window = args.options().get("contextWindow").and_then(Value::as_i64);
            go!(client
                .gather
                .annotation(
                    &as_id(&args.text("resourceId")),
                    &as_id(&args.text("annotationId")),
                    window
                )
                .into_future())
        }
        ("gather", "resource") => {
            let resource_id = args.text("resourceId");
            // What the case does not state is what the SDK sends unasked.
            let mut options = object(
                &serde_json::to_value(semiont::types::GatherResourceRequestOptions::default())
                    .expect("the options serialize"),
            );
            options.extend(args.options());
            let options = serde_json::from_value(Value::Object(options)).expect("gather options");
            go!(client.gather.resource(&as_id(&resource_id), options))
        }
        ("gather", "referencedBy") => {
            go!(client
                .gather
                .referenced_by(&as_id(&args.text("resourceId")))
                .fresh())
        }

        ("match", "search") => {
            let mut request = json!({
                "resourceId": args.text("resourceId"),
                "referenceId": args.text("referenceId"),
                "context": args.0["context"],
            });
            object_of(&mut request).extend(args.options());
            let request = serde_json::from_value(request).expect("a search request");
            go!(client.match_.search(request).into_future())
        }
        ("match", "requestSearch") => client
            .match_
            .request_search(args.typed("input"), &args.text("correlationId")),
        ("match", "resources") => go!(client
            .match_
            .resources(&args.text("search"), args.filters())
            .fresh()),

        ("yield", "resource") => {
            let data = object(&args.0["data"]);
            let stated = |name: &str| {
                data.get(name)
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| panic!("the upload states no {name}"))
                    .to_owned()
            };
            let upload = client.yield_.resource(PutBinaryRequest {
                name: stated("name"),
                bytes: Bytes::from(stated("content")),
                format: stated("format"),
                storage_uri: stated("storageUri"),
                entity_types: Vec::new(),
                language: None,
                source_annotation_id: None,
                source_resource_id: None,
                generation_prompt: None,
                generator: None,
                job_id: None,
                is_draft: None,
                clone_token: None,
                archive_original: None,
            });
            go!(upload.into_future())
        }
        ("yield", "fromContext") => {
            // The stall deadline is the caller's own and has an argument of
            // its own; the rest are the job's parameters.
            let mut params = args.options();
            let stall = params
                .remove("stallDeadlineMs")
                .and_then(|ms| ms.as_u64())
                .map(Duration::from_millis);
            params.insert("context".to_owned(), args.0["context"].clone());
            let params = serde_json::from_value(Value::Object(params)).expect("generation params");
            go!(client.yield_.from_context(params, stall).into_future())
        }
        ("yield", "cloneToken") => {
            let resource_id = args.text("resourceId");
            go!(client.yield_.clone_token(&as_id(&resource_id)))
        }
        ("yield", "fromToken") => {
            let token = args.text("token");
            go!(client.yield_.from_token(&token))
        }
        ("yield", "createFromToken") => {
            let options = Args(args.options());
            let options = CreateFromTokenOptions {
                token: options.text("token"),
                name: options.text("name"),
                content: options.text("content"),
                archive_original: None,
            };
            go!(client.yield_.create_from_token(options))
        }
        ("yield", "clone") => client.yield_.clone(),

        ("beckon", "attention") => {
            let (resource_id, annotation_id) = (args.text("resourceId"), args.text("annotationId"));
            go!(client
                .beckon
                .attention(&as_id(&resource_id), &as_id(&annotation_id)))
        }
        ("beckon", "click") => {
            let annotation_id = args.text("annotationId");
            go!(client.beckon.click(&as_id(&annotation_id)))
        }
        ("beckon", "openResource") => {
            let resource_id = args.text("resourceId");
            go!(client.beckon.open_resource(&as_id(&resource_id)))
        }
        ("beckon", "sparkleAll") => {
            let annotation_id = args.text("annotationId");
            go!(client.beckon.sparkle_all(&as_id(&annotation_id)))
        }
        ("beckon", "hover") => client.beckon.hover(
            args.optional_text("annotationId")
                .map(|id| as_id(&id))
                .as_ref(),
        ),
        ("beckon", "sparkle") => client.beckon.sparkle(&as_id(&args.text("annotationId"))),

        ("job", "status") => {
            let job_id = args.text("jobId");
            go!(client.job.status(&as_id(&job_id)))
        }
        ("job", "pollUntilComplete") => {
            let job_id = args.text("jobId");
            go!(client.job.poll_until_complete(
                &as_id(&job_id),
                Duration::from_millis(10),
                Duration::from_millis(50),
                |_| {}
            ))
        }
        ("job", "cancelByType") => go!(client.job.cancel_by_type(args.typed("jobType"))),
        ("job", "cancel") => {
            let job_id = args.text("jobId");
            go!(client.job.cancel(&as_id(&job_id)))
        }
        ("job", "cancelRequest") => client.job.cancel_request(args.typed("jobType")),

        ("auth", "me") => go!(async move {
            match &client.auth {
                Some(auth) => auth.me().await.map(|_| ()),
                None => panic!("a client with a gateway has auth"),
            }
        }),
        ("auth", "mediaToken") => {
            let resource_id = args.text("resourceId");
            go!(async move {
                match &client.auth {
                    Some(auth) => auth.media_token(&as_id(&resource_id)).await.map(|_| ()),
                    None => panic!("a client with a gateway has auth"),
                }
            })
        }
        ("auth", "protectedResourceMetadata") => go!(async move {
            match &client.auth {
                Some(auth) => auth.protected_resource_metadata().await.map(|_| ()),
                None => panic!("a client with a gateway has auth"),
            }
        }),
        ("system", "healthCheck") => go!(async move {
            match &client.system {
                Some(system) => system.health_check().await.map(|_| ()),
                None => panic!("a client with a gateway has system"),
            }
        }),
        ("system", "status") => go!(async move {
            match &client.system {
                Some(system) => system.status().await.map(|_| ()),
                None => panic!("a client with a gateway has system"),
            }
        }),
        _ => panic!("this SDK's surface test has no call for {namespace}.{method}"),
    }
}

fn object_of(value: &mut Value) -> &mut Map<String, Value> {
    value.as_object_mut().expect("an object")
}

/// What `published` gives, when it gives it within a second: a signal that
/// was never published is a failure, not a wait.
async fn within_a_second<T>(why: &str, published: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(1), published)
        .await
        .unwrap_or_else(|_| panic!("{why}: nothing was published"))
}

/// Wait, a second at most, for `seen` to give something.
async fn eventually<T>(what: &str, mut seen: impl FnMut() -> Option<T>) -> T {
    for _ in 0..200 {
        if let Some(found) = seen() {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("{what} did not happen");
}

/// The content transport's name for a call, and what the call was given.
fn content_call(call: &ContentCall) -> (&'static str, Value) {
    match call {
        ContentCall::GetBinary(id) => ("getBinary", json!({ "resourceId": id })),
        ContentCall::GetBinaryStream(id) => ("getBinaryStream", json!({ "resourceId": id })),
        ContentCall::GetResourceGraph(id) => ("getResourceGraph", json!({ "resourceId": id })),
        ContentCall::PutBinary(request) => {
            let mut given = json!({
                "name": request.name,
                "content": String::from_utf8_lossy(&request.bytes),
                "format": request.format,
                "storageUri": request.storage_uri,
            });
            if let Some(token) = &request.clone_token {
                object_of(&mut given).insert("cloneToken".to_owned(), json!(token));
            }
            ("putBinary", given)
        }
    }
}

/// The gateway double's record of a call, as the table names and states it.
fn gateway_call(call: &str) -> (&'static str, Value) {
    let (operation, of) = match call.split_once(' ') {
        Some((operation, resource_id)) => (operation, json!({ "resourceId": resource_id })),
        None => (call, json!({})),
    };
    let named = match operation {
        "get_current_user" => "getCurrentUser",
        "get_media_token" => "getMediaToken",
        "get_protected_resource_metadata" => "getProtectedResourceMetadata",
        "health_check" => "healthCheck",
        "get_status" => "getStatus",
        other => panic!("the gateway double recorded {other}, which the table does not name"),
    };
    (named, of)
}

/// One step of a case: what was done, and what it was given.
async fn held_to(world: &World, at: usize, via: &Map<String, Value>, sends: &Value, why: &str) {
    let (kind, named) = via
        .iter()
        .find(|(kind, _)| kind.as_str() != "sends")
        .map(|(kind, named)| (kind.as_str(), named.as_str().expect("a name")))
        .expect("a step says what it goes through");
    match kind {
        "request" | "emit" => {
            let frame: Frame = eventually(&format!("{why}: a frame on {named}"), || {
                world.transport.emitted().get(at).cloned()
            })
            .await;
            assert_eq!(frame.channel, named, "{why}");
            same(
                &Value::Object(frame.payload),
                sends,
                &format!("{why}: what was sent"),
            );
            assert_eq!(frame.scope, None, "{why}: it is sent globally");
            assert_eq!(
                frame.correlation_id.is_some(),
                kind == "request",
                "{why}: a request carries a key of the client's making, and a frame nobody answers carries none"
            );
        }
        "content" => {
            let call = eventually(&format!("{why}: a call of the content transport"), || {
                world.content.calls().first().cloned()
            })
            .await;
            let (operation, given) = content_call(&call);
            assert_eq!(operation, named, "{why}");
            same(&given, sends, &format!("{why}: what it was given"));
        }
        "gateway" => {
            let call = eventually(&format!("{why}: a call of the gateway"), || {
                world.gateway.calls().first().cloned()
            })
            .await;
            let (operation, given) = gateway_call(&call);
            assert_eq!(operation, named, "{why}");
            same(&given, sends, &format!("{why}: what it was given"));
        }
        other => panic!("{why}: a step through {other} is not one this runner holds"),
    }
}

#[tokio::test]
async fn every_method_does_what_its_row_says() {
    let table = table();
    let fixtures = &table["fixtures"];
    let mut listed: Vec<(String, String)> = Vec::new();

    for namespace in table["namespaces"].as_array().expect("namespaces") {
        let name = namespace["namespace"].as_str().expect("a namespace's name");
        for row in namespace["methods"].as_array().expect("methods") {
            let method = row["method"].as_str().expect("a method's name");
            if row["absent"].get(SDK).is_some() {
                continue;
            }
            listed.push((name.to_owned(), method.to_owned()));
            let via = object(&row["via"]);
            let (kind, channel) = via
                .iter()
                .next()
                .map(|(kind, named)| (kind.as_str(), named.as_str().expect("a name")))
                .expect("a row says what it goes through");
            let cases = row["cases"].as_array().expect("cases");
            assert!(!cases.is_empty(), "{name}.{method} has no case");

            for case in cases {
                let why = format!(
                    "{name}.{method} ({})",
                    case["why"].as_str().unwrap_or("as stated")
                );
                let world = world();
                let args = Args(object(&resolved(&case["args"], fixtures)));
                let sends = resolved(&case["sends"], fixtures);
                if let Some(answer) = case.get("answers") {
                    world.transport.queue_reply(
                        channel,
                        [(!answer.is_null()).then(|| resolved(answer, fixtures))],
                    );
                }

                match kind {
                    "local" => {
                        let mut published = world.client.bus().frames(channel);
                        call(&world, name, method, args);
                        let frame = within_a_second(&why, published.next())
                            .await
                            .unwrap_or_else(|| panic!("{why}: the client's bus ended"))
                            .expect("not lagged");
                        same(
                            &Value::Object(frame.payload),
                            &sends,
                            &format!("{why}: what was published"),
                        );
                        assert_eq!(
                            frame.correlation_id.as_deref(),
                            case["correlationId"].as_str(),
                            "{why}: the key on its envelope"
                        );
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        assert!(
                            world.transport.emitted().is_empty(),
                            "{why}: a signal never reaches the wire"
                        );
                    }
                    "observes" => {
                        let payload = object(&sends);
                        macro_rules! heard {
                            ($events:expr) => {{
                                let mut events = $events;
                                world
                                    .client
                                    .bus()
                                    .emit(channel, payload, Envelope::default());
                                let event = within_a_second(&why, events.next())
                                    .await
                                    .unwrap_or_else(|| panic!("{why}: the client's bus ended"))
                                    .expect("it decodes");
                                serde_json::to_value(event.payload).expect("the event serializes")
                            }};
                        }
                        let heard = match (name, method) {
                            ("job", "queued") => heard!(world.client.job.queued()),
                            ("job", "progress") => heard!(world.client.job.progress()),
                            ("job", "complete") => heard!(world.client.job.complete()),
                            ("job", "fail") => heard!(world.client.job.fail()),
                            _ => panic!("this SDK's surface test has no call for {name}.{method}"),
                        };
                        same(&heard, &sends, &format!("{why}: what was heard"));
                    }
                    _ => {
                        call(&world, name, method, args);
                        held_to(&world, 0, &via, &sends, &why).await;
                        for (index, step) in
                            case["then"].as_array().into_iter().flatten().enumerate()
                        {
                            let step = object(step);
                            let sends = resolved(&step["sends"], fixtures);
                            held_to(&world, index + 1, &step, &sends, &why).await;
                        }
                    }
                }
            }
        }
    }

    let mut called: Vec<(String, String)> = METHODS
        .iter()
        .flat_map(|(namespace, methods)| {
            methods
                .iter()
                .map(|method| ((*namespace).to_owned(), (*method).to_owned()))
        })
        .collect();
    listed.sort();
    called.sort();
    assert_eq!(
        called, listed,
        "the methods this SDK has, and the table's rows for it"
    );
}
