//! Admitting a job (JOBS.md § `job:create`): the checks, in order, the first
//! that fails being the refusal; the resource the job is recorded under; the
//! two vocabulary reads; the record admitted; and what an announcement of it
//! carries.
//!
//! A job description is its `jobType` and its parameters. What the dispatcher
//! holds (`JobParams`) is those parameters as they came, and beside them what
//! it adds, each a property of its own: the resource the job is about, and
//! for a tagging job the schema its `schemaId` names, so that whoever holds
//! the job needs no registry. An announcement carries the description alone,
//! without the job's input.

use semiont::types::{
    CommandErrorCode, GatheredContextFocus, GenerationJobParams, JobCreateCommand, JobId,
    JobMetadata, JobParams, JobPending, JobPendingStatus, JobQueuedEvent, JobType, MarkJobParams,
    MarkJobQueuedEvent, TagSchema, YieldJobQueuedEvent,
};
use serde::Deserialize;
use serde::de::value::MapDeserializer;
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

/// Now, as the record writes times: ISO 8601, milliseconds, UTC.
pub fn now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Refuses entity types the knowledge base does not register, naming each.
async fn registered(requested: &[String], reads: &impl Vocabulary) -> Result<(), Refusal> {
    let registered = reads.entity_types().await?;
    let unknown: Vec<&str> = requested
        .iter()
        .filter(|name| !registered.contains(name))
        .map(String::as_str)
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(Refusal::new(format!(
            "Entity type not registered: {}",
            unknown.join(", ")
        )))
    }
}

/// Refuses the parameters a `yield` job was given that it does not take: the
/// ones its type does not name. Its schema is open, so the gateway admits
/// them; a `mark` job's is closed, and one of those never arrives.
fn taken(given: &Map<String, Value>, params: &GenerationJobParams) -> Result<(), Refusal> {
    let named = serde_json::to_value(params).expect("a yield job's parameters serialize");
    let unknown: Vec<&str> = given
        .keys()
        .filter(|name| named.get(name.as_str()).is_none())
        .map(String::as_str)
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(Refusal::new(format!(
            "a yield job takes no parameter {}",
            unknown.join(", ")
        )))
    }
}

/// The job a `job:create` asks for, or why it is refused.
pub async fn admit(mut payload: Value, reads: &impl Vocabulary) -> Result<JobPending, Refusal> {
    let unreadable = |why: &dyn std::fmt::Display| {
        Refusal::new(format!(
            "a job:create that is not a JobCreateCommand: {why}"
        ))
    };
    let command = JobCreateCommand::deserialize(&payload).map_err(|error| unreadable(&error))?;
    // Held as they came: what a claim hands over is what was asked for, whole.
    let Some(Value::Object(params)) = payload.get_mut("params").map(Value::take) else {
        return Err(unreadable(&"its params are not an object"));
    };
    let (user_id, job_type, resource_id) = match &command {
        JobCreateCommand::MarkJobCreateCommand(mark) => {
            (&mark._user_id, JobType::Mark, &mark.resource_id)
        }
        // The focus rule: the resource a gathered context is about.
        JobCreateCommand::YieldJobCreateCommand(yielding) => (
            &yielding._user_id,
            JobType::Yield,
            match &yielding.params.context.focus {
                GatheredContextFocus::Resource(focus) => &focus.resource.id,
                GatheredContextFocus::Annotation(focus) => &focus.source_resource.id,
            },
        ),
    };
    let (Some(user_id), resource_id) = (user_id.clone(), resource_id.clone()) else {
        return Err(Refusal::new(
            "_userId is required (injected by bus gateway)",
        ));
    };

    // The schema a tagging job's `schemaId` names; no other job has one.
    let schema = match &command {
        JobCreateCommand::MarkJobCreateCommand(mark) => match &mark.params {
            MarkJobParams::LinkingJobParams(linking) => {
                registered(&linking.entity_types, reads).await?;
                None
            }
            MarkJobParams::TaggingJobParams(tagging) => {
                let schemas = reads.tag_schemas().await?;
                let Some(schema) = schemas.into_iter().find(|s| s.id == tagging.schema_id) else {
                    return Err(Refusal::new(format!(
                        "Tag schema not registered: {}",
                        tagging.schema_id
                    )));
                };
                Some(schema)
            }
            MarkJobParams::HighlightingJobParams(_)
            | MarkJobParams::CommentingJobParams(_)
            | MarkJobParams::AssessingJobParams(_) => None,
        },
        JobCreateCommand::YieldJobCreateCommand(yielding) => {
            taken(&params, &yielding.params)?;
            if let Some(requested) = yielding.params.entity_types.as_deref()
                && !requested.is_empty()
            {
                registered(requested, reads).await?;
            }
            None
        }
    };

    Ok(JobPending {
        status: JobPendingStatus::Pending,
        metadata: JobMetadata {
            id: JobId::new(format!("job-{}", uuid::Uuid::new_v4().simple()))
                .expect("`job-` and 32 hex digits is a JobId"),
            r#type: job_type,
            user_id,
            created: now(),
            retry_count: 0,
            max_retries: match job_type {
                JobType::Mark => 1,
                JobType::Yield => 0,
            },
            completed_units: None,
            unit_cursors: None,
        },
        params: JobParams {
            resource_id,
            schema,
            rest: params,
        },
    })
}

/// The parameters a job was created with, as `T` reads them: what the
/// caller sent, without whatever `T` does not name.
fn stated<'a, T: Deserialize<'a>>(params: &'a JobParams) -> Result<T, serde_json::Error> {
    T::deserialize(MapDeserializer::new(
        params
            .rest
            .iter()
            .map(|(name, value)| (name.as_str(), value)),
    ))
}

/// What an announcement of a job carries (JOBS.md § `job:queued`): its
/// description less its input. A `mark` job's parameters are announced whole;
/// a `yield` job's are the ones its request names, which its context is not.
/// It is also what a claim's filters are matched against.
pub fn announcement(
    metadata: &JobMetadata,
    params: &JobParams,
) -> Result<JobQueuedEvent, serde_json::Error> {
    let (job_id, resource_id, user_id) = (
        metadata.id.clone(),
        params.resource_id.clone(),
        metadata.user_id.clone(),
    );
    Ok(match metadata.r#type {
        JobType::Mark => {
            MarkJobQueuedEvent::new(job_id, resource_id, user_id, stated(params)?).into()
        }
        JobType::Yield => {
            YieldJobQueuedEvent::new(job_id, resource_id, user_id, stated(params)?).into()
        }
    })
}
