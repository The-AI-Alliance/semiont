//! Admission below the bus (docs/protocol/JOBS.md § `job:create`,
//! § `job:queued`): what the dispatcher itself makes of a job description,
//! whatever a gateway refused before it. A job's parameters are its
//! motivation's and no others; the job is held with them as they came, and
//! with what the dispatcher adds; and its announcement carries the
//! description without what was added and without the job's input.

use semiont::job_filter::job_matches_filter;
use semiont::types::{JobFilter, JobParams, JobPending, TagSchema};
use semiont_dispatcher_handlers::admission::{Refusal, Vocabulary, admit, announcement};
use serde_json::{Value, json};

/// A knowledge base that registers two entity types and one tag schema.
struct Registered;

fn irac() -> TagSchema {
    serde_json::from_value(json!({
        "id": "irac", "name": "IRAC", "description": "Issue, rule, application, conclusion",
        "domain": "legal",
        "tags": [{ "name": "Issue", "description": "The question", "examples": ["Whether"] }],
    }))
    .expect("a tag schema")
}

impl Vocabulary for Registered {
    async fn entity_types(&self) -> Result<Vec<String>, Refusal> {
        Ok(vec!["Person".to_owned(), "Place".to_owned()])
    }

    async fn tag_schemas(&self) -> Result<Vec<TagSchema>, Refusal> {
        Ok(vec![irac()])
    }
}

const ALICE: &str = "did:web:example.org:users:alice";

fn mark(params: Value) -> Value {
    json!({ "jobType": "mark", "resourceId": "res-1", "params": params, "_userId": ALICE })
}

fn context() -> Value {
    json!({
        "focus": { "kind": "resource", "resource": {
            "@context": "https://schema.org", "@id": "res-focus", "name": "The source",
            "representations": [{ "mediaType": "text/plain" }],
        } },
        "graph": { "nodes": [], "edges": [] },
        "metadata": {},
    })
}

fn yielding(more: Value) -> Value {
    let mut params =
        json!({ "title": "Ouranos", "storageUri": "file://ouranos.md", "context": context() });
    for (name, value) in more.as_object().expect("an object") {
        params[name] = value.clone();
    }
    json!({ "jobType": "yield", "params": params, "_userId": ALICE })
}

async fn admitted(payload: Value) -> JobPending {
    admit(payload, &Registered)
        .await
        .expect("the job is admitted")
}

async fn refused(payload: Value) -> String {
    admit(payload, &Registered)
        .await
        .expect_err("the job is refused")
        .message
}

/// The parameters a job is held with that are not a property of its own:
/// the ones its `job:create` gave it.
fn as_sent(job: &JobPending) -> Value {
    Value::Object(job.params.rest.clone())
}

fn announced(job: &JobPending) -> Value {
    serde_json::to_value(announcement(&job.metadata, &job.params).expect("an announcement"))
        .expect("an announcement serializes")
}

#[tokio::test]
async fn a_mark_job_is_held_with_its_parameters_as_they_came_and_its_resource() {
    let params = json!({ "motivation": "assessing", "tone": "critical", "density": 3 });
    let job = admitted(mark(params.clone())).await;
    assert_eq!(job.metadata.r#type.as_str(), "mark");
    assert_eq!(job.metadata.max_retries, 1);
    assert_eq!(job.params.resource_id, "res-1");
    assert_eq!(as_sent(&job), params);
    assert_eq!(job.params.schema, None);
    assert_eq!(
        announced(&job)["params"],
        json!({ "motivation": "assessing", "tone": "critical", "density": 3.0 })
    );
}

#[tokio::test]
async fn a_parameter_a_mark_job_does_not_take_is_refused_and_says_which() {
    for (params, unknown) in [
        (
            json!({ "motivation": "linking", "entityTypes": ["Person"], "instructions": "x" }),
            "instructions",
        ),
        (
            json!({ "motivation": "highlighting", "tone": "scholarly" }),
            "tone",
        ),
    ] {
        let message = refused(mark(params)).await;
        assert!(
            message.starts_with("a job:create that is not a JobCreateCommand: ")
                && message.contains(&format!("unknown field `{unknown}`")),
            "{message}"
        );
    }
}

#[tokio::test]
async fn a_mark_job_that_lacks_what_its_motivation_needs_or_states_none_is_refused() {
    for (params, why) in [
        (
            json!({ "motivation": "tagging", "categories": ["Issue"] }),
            "missing field `schemaId`",
        ),
        (
            json!({ "motivation": "linking" }),
            "missing field `entityTypes`",
        ),
        (json!({}), "a MarkJobParams states a `motivation`"),
        (
            json!({ "motivation": "bookmarking" }),
            "a MarkJobParams states a `motivation`",
        ),
    ] {
        let message = refused(mark(params)).await;
        assert!(message.contains(why), "{message}");
    }
}

#[tokio::test]
async fn a_tagging_job_is_held_with_its_schema_beside_its_schema_id_and_announced_without_it() {
    let params = json!({ "motivation": "tagging", "schemaId": "irac", "categories": ["Issue"] });
    let job = admitted(mark(params.clone())).await;
    assert_eq!(job.params.resource_id, "res-1");
    assert_eq!(job.params.schema, Some(irac()));
    // What the caller sent is held as it came, its `schemaId` with it.
    assert_eq!(as_sent(&job), params);

    let announced = announced(&job);
    assert_eq!(announced["params"], params);
    assert_eq!(announced["resourceId"], "res-1");
    assert_eq!(announced["jobType"], "mark");

    assert_eq!(
        refused(mark(
            json!({ "motivation": "tagging", "schemaId": "nope", "categories": ["Issue"] })
        ))
        .await,
        "Tag schema not registered: nope"
    );
}

/// What the dispatcher adds to a job it holds is its own to state: a caller
/// that states one of them, whatever the job, is refused. The names are the
/// generated type's, so one the spec adds is asked here too.
#[tokio::test]
async fn a_caller_states_nothing_the_dispatcher_adds_to_the_job_it_holds() {
    let held = JobParams {
        schema: Some(irac()),
        ..JobParams::new("res-caller".parse().expect("a resource id"))
    };
    let Value::Object(added) = serde_json::to_value(held).expect("held params serialize") else {
        panic!("held params are an object");
    };
    assert_eq!(added.len(), 2, "its resource and its schema: {added:?}");

    for (name, value) in added {
        let mut tagging =
            json!({ "motivation": "tagging", "schemaId": "irac", "categories": ["Issue"] });
        tagging[&name] = value.clone();
        let message = refused(mark(tagging)).await;
        assert!(
            message.contains(&format!("unknown field `{name}`")),
            "{message}"
        );

        let mut stated = serde_json::Map::new();
        stated.insert(name.clone(), value);
        assert_eq!(
            refused(yielding(Value::Object(stated))).await,
            format!("a yield job takes no parameter {name}")
        );
    }
}

#[tokio::test]
async fn a_linking_jobs_entity_types_are_the_knowledge_bases() {
    admitted(mark(
        json!({ "motivation": "linking", "entityTypes": ["Place", "Person"] }),
    ))
    .await;
    assert_eq!(
        refused(mark(
            json!({ "motivation": "linking", "entityTypes": ["Person", "Unicorn", "Dragon"] })
        ))
        .await,
        "Entity type not registered: Unicorn, Dragon"
    );
}

#[tokio::test]
async fn a_yield_job_is_about_its_contexts_focus_and_is_announced_without_its_context() {
    let job = admitted(yielding(
        json!({ "prompt": "in one page", "maxTokens": 800 }),
    ))
    .await;
    assert_eq!(job.metadata.r#type.as_str(), "yield");
    assert_eq!(job.metadata.max_retries, 0);
    assert_eq!(job.params.resource_id, "res-focus");
    assert_eq!(job.params.schema, None);
    assert_eq!(job.params.rest["context"], context());
    assert_eq!(job.params.rest["maxTokens"], 800);

    let announced = announced(&job);
    assert_eq!(
        announced["params"],
        json!({ "title": "Ouranos", "storageUri": "file://ouranos.md", "prompt": "in one page", "maxTokens": 800.0 })
    );
    assert_eq!(announced["resourceId"], "res-focus");
}

#[tokio::test]
async fn a_parameter_a_yield_job_does_not_take_is_refused_by_name() {
    assert_eq!(
        refused(yielding(json!({ "referenceId": "ann-1" }))).await,
        "a yield job takes no parameter referenceId"
    );
    assert_eq!(
        refused(yielding(
            json!({ "resourceId": "res-caller", "schemaId": "irac" })
        ))
        .await,
        "a yield job takes no parameter resourceId, schemaId"
    );
    let beside = {
        let mut payload = yielding(json!({}));
        payload["resourceId"] = json!("res-caller");
        payload
    };
    let message = refused(beside).await;
    assert!(message.contains("unknown field `resourceId`"), "{message}");
    assert_eq!(
        refused(yielding(json!({ "entityTypes": ["Unicorn"] }))).await,
        "Entity type not registered: Unicorn"
    );
}

/// A claim is matched against what is announced, so a job is taken by the
/// filter that names its type and, for a `mark` job, its motivation.
#[tokio::test]
async fn an_announcement_is_what_a_claims_filters_are_matched_against() {
    let filter = |stated: Value| -> JobFilter { serde_json::from_value(stated).expect("a filter") };
    let tagging = filter(json!({ "jobType": "mark", "params": { "motivation": "tagging" } }));
    let linking = filter(json!({ "jobType": "mark", "params": { "motivation": "linking" } }));
    let yields = filter(json!({ "jobType": "yield" }));

    let tag = admitted(mark(
        json!({ "motivation": "tagging", "schemaId": "irac", "categories": ["Issue"] }),
    ))
    .await;
    let tag = announcement(&tag.metadata, &tag.params).expect("an announcement");
    assert!(job_matches_filter(&tagging, &tag));
    assert!(!job_matches_filter(&linking, &tag));
    assert!(!job_matches_filter(&yields, &tag));

    let made = admitted(yielding(json!({}))).await;
    let made = announcement(&made.metadata, &made.params).expect("an announcement");
    assert!(job_matches_filter(&yields, &made));
    assert!(!job_matches_filter(&tagging, &made));
}
