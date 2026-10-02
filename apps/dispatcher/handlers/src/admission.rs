//! Admitting a job (JOBS.md § `job:create`): the checks, in order, the first
//! that fails being the refusal; the resource the job is recorded under; the
//! two vocabulary reads; and the record admitted.

use semiont::types::{
    CommandErrorCode, JobCreateCommand, JobId, JobMetadata, JobParams, JobPending,
    JobPendingStatus, JobType, ResourceId, TagSchema,
};
use serde_json::{Map, Value};
use std::future::Future;

/// A `job:create` refused: its message, and a code when the reason has one.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub message: String,
    pub code: Option<CommandErrorCode>,
}

impl Refusal {
    pub fn new(message: impl Into<String>) -> Refusal {
        Refusal {
            message: message.into(),
            code: None,
        }
    }
}

/// The knowledge base's vocabulary, read afresh for each job that needs it:
/// the Archivist answers both reads over the bus. A read that fails is the
/// refusal, with its code.
pub trait Vocabulary: Send + Sync + 'static {
    fn entity_types(&self) -> impl Future<Output = Result<Vec<String>, Refusal>> + Send;
    fn tag_schemas(&self) -> impl Future<Output = Result<Vec<TagSchema>, Refusal>> + Send;
}

/// A job type as the wire names it.
pub fn wire_name(job_type: JobType) -> String {
    serde_json::to_value(job_type)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .expect("a JobType names itself")
}

/// Now, as the record writes times: ISO 8601, milliseconds, UTC.
pub fn now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The focus rule: the resource a generation's gathered context is about.
fn focused_resource(params: &Map<String, Value>) -> Option<ResourceId> {
    let focus = &params.get("context")?["focus"];
    let id = match focus["kind"].as_str()? {
        "resource" => &focus["resource"]["@id"],
        "annotation" => &focus["sourceResource"]["@id"],
        _ => return None,
    };
    id.as_str().and_then(|id| ResourceId::new(id).ok())
}

/// The job `command` asks for, or why it is refused.
pub async fn admit(
    command: JobCreateCommand,
    reads: &impl Vocabulary,
) -> Result<JobPending, Refusal> {
    let JobCreateCommand {
        _user_id: user_id,
        job_type,
        resource_id,
        params,
    } = command;
    let Some(user_id) = user_id else {
        return Err(Refusal::new(
            "_userId is required (injected by bus gateway)",
        ));
    };
    if params.contains_key("resourceId") {
        return Err(Refusal::new(
            "job:create must omit params.resourceId — the job's resource is its resourceId, or a generation's context focus",
        ));
    }

    let resource = if job_type == JobType::Generation {
        if resource_id.is_some() {
            return Err(Refusal::new(
                "generation job:create must omit resourceId — the context's focus is authoritative",
            ));
        }
        if params.contains_key("referenceId") {
            return Err(Refusal::new(
                "generation job:create must omit params.referenceId — the context's focus is authoritative",
            ));
        }
        let context_is_object = params.get("context").is_some_and(Value::is_object);
        if text(params.get("title")).is_none()
            || text(params.get("storageUri")).is_none()
            || !context_is_object
        {
            return Err(Refusal::new(
                "generation params do not satisfy GenerationJobParams (title, storageUri, and context are required)",
            ));
        }
        focused_resource(&params).ok_or_else(|| {
            Refusal::new(
                "generation context has no usable focus — pass a GatheredContext produced by gather.resource(...) or gather.annotation(...)",
            )
        })?
    } else {
        resource_id.ok_or_else(|| {
            Refusal::new(format!(
                "{} job:create requires resourceId",
                wire_name(job_type)
            ))
        })?
    };

    let mut params = params;
    if matches!(job_type, JobType::ReferenceAnnotation | JobType::Generation)
        && let Some(Value::Array(requested)) = params.get("entityTypes")
        && !requested.is_empty()
    {
        let registered = reads.entity_types().await?;
        let unknown: Vec<String> = requested
            .iter()
            .filter(|t| {
                !t.as_str()
                    .is_some_and(|name| registered.iter().any(|r| r == name))
            })
            .map(|t| {
                t.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| t.to_string())
            })
            .collect();
        if !unknown.is_empty() {
            return Err(Refusal::new(format!(
                "Entity type not registered: {}",
                unknown.join(", ")
            )));
        }
    }
    if job_type == JobType::ReferenceAnnotation
        && params
            .get("entityTypes")
            .is_some_and(|t| !t.is_array() && !t.is_null())
    {
        return Err(Refusal::new(
            "reference-annotation params.entityTypes is not an array",
        ));
    }
    if job_type == JobType::TagAnnotation {
        let schemas = reads.tag_schemas().await?;
        let Some(schema_id) = text(params.get("schemaId")).map(str::to_owned) else {
            return Err(Refusal::new("tag-annotation requires schemaId"));
        };
        let Some(schema) = schemas.into_iter().find(|s| s.id == schema_id) else {
            return Err(Refusal::new(format!(
                "Tag schema not registered: {schema_id}"
            )));
        };
        params.insert(
            "schema".to_owned(),
            serde_json::to_value(schema).expect("a TagSchema serializes"),
        );
        params.remove("schemaId");
    }

    Ok(JobPending {
        status: JobPendingStatus::Pending,
        metadata: JobMetadata {
            id: JobId::new(format!("job-{}", uuid::Uuid::new_v4().simple()))
                .expect("`job-` and 32 hex digits is a JobId"),
            r#type: job_type,
            user_id,
            created: now(),
            retry_count: 0,
            max_retries: if job_type == JobType::Generation {
                0
            } else {
                1
            },
            completed_units: None,
            unit_cursors: None,
        },
        params: JobParams {
            resource_id: resource,
            rest: params,
        },
    })
}
