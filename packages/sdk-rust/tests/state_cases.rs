//! The state units against `specs/src/client/state-units.json`.
//!
//! Each case of a unit this SDK has is run as the table states it: its units
//! are built over a scripted transport, driven step by step, and held to what
//! the case says they hold and said. A unit that the names table
//! (`specs/src/client/surface.json`, `stateUnits`) says this SDK lacks has its
//! cases left unrun, as the surface test leaves a row's `absent` SDK: they run
//! once the unit lands and its `absent` goes. What the table may say is held
//! by `scripts/lint/check-state-unit-cases.mjs`; what a case cannot say, the
//! axioms, each unit's own test holds.
//!
//! Every case runs on a runtime of its own, whose clock moves only when the
//! case moves it, and every case that fails is listed: one cannot hide
//! another. Rust calls no method and reads no member by its name, so each
//! method a case invokes and each member it reads has an adapter here, and a
//! census holds the adapters to the table both ways.

use semiont::client::SemiontClient;
use semiont::errors::SemiontError;
use semiont::session::{KbIdentityConflict, SessionEndReason, SessionSignals};
use semiont::state::{
    BeckonStateUnit, GatherStateUnit, HoverDwell, MarkStateUnit, MatchStateUnit, SearchPipeline,
    SearchPipelineOptions, YieldStateUnit,
};
use semiont::state_unit::StateUnit;
use semiont::testing::{
    FaultAction, FaultyTransport, RequestLogEntry, TestClientOptions, create_test_client,
};
use semiont::transport::{Envelope, Frame, Lagged};
use semiont::types::{
    GatherAnnotationOptions, GatherResourceRequestOptions, GenerationJobParams, MarkJobParams,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::str::FromStr;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::UnboundedReceiverStream;

/// The SDK this runner is, as the names table's `absent` names it.
const SDK: &str = "rust";

/// How many turns of the runtime a settle lets pass: enough for what any case
/// sets going to run to its end, as a paused clock lets it.
const SETTLE_TURNS: usize = 200;

static TABLE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../specs/client/state-units.json"))
        .expect("the state-unit table is JSON")
});

static NAMES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../specs/client/surface.json"))
        .expect("the names table is JSON")
});

static TIMING: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../specs/client/timing.json"))
        .expect("the timing table is JSON")
});

/// Let what is ready run, and what that makes ready, without moving the clock.
async fn settle() {
    for _ in 0..SETTLE_TURNS {
        tokio::task::yield_now().await;
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── Reading the table ───────────────────────────────────────────────────

fn text<'a>(value: &'a Value, what: &str) -> Result<&'a str, String> {
    value
        .as_str()
        .ok_or_else(|| format!("{what} is not text: {value}"))
}

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{what} is not an object: {value}"))
}

fn array<'a>(value: &'a Value, what: &str) -> Result<&'a [Value], String> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| format!("{what} is not a list: {value}"))
}

fn field<'a>(members: &'a Map<String, Value>, name: &str) -> Result<&'a Value, String> {
    members
        .get(name)
        .ok_or_else(|| format!("no {name} is stated"))
}

fn strings(value: &Value, what: &str) -> Result<Vec<String>, String> {
    array(value, what)?
        .iter()
        .map(|item| text(item, what).map(str::to_owned))
        .collect()
}

fn index(value: &Value, what: &str) -> Result<usize, String> {
    value
        .as_u64()
        .and_then(|whole| usize::try_from(whole).ok())
        .ok_or_else(|| format!("{what} is not a whole number: {value}"))
}

fn id<T>(given: &Map<String, Value>, name: &str) -> Result<T, String>
where
    T: FromStr,
    T::Err: Display,
{
    text(field(given, name)?, name)?
        .parse()
        .map_err(|not_one: T::Err| format!("{name}: {not_one}"))
}

fn units_this_sdk_has() -> BTreeSet<String> {
    let rows = NAMES
        .get("stateUnits")
        .and_then(Value::as_array)
        .expect("the names table names its state units");
    rows.iter()
        .filter(|row| {
            !row.get("absent")
                .and_then(Value::as_object)
                .is_some_and(|absent| absent.contains_key(SDK))
        })
        .map(|row| {
            row.get("unit")
                .and_then(Value::as_str)
                .expect("a row names its unit")
                .to_owned()
        })
        .collect()
}

fn cases() -> &'static [Value] {
    TABLE
        .get("cases")
        .and_then(Value::as_array)
        .expect("the table states its cases")
}

fn unit_of(case: &Value) -> &str {
    case.get("unit")
        .and_then(Value::as_str)
        .expect("a case names its unit")
}

/// The cases of the units this SDK has.
fn run() -> Vec<&'static Value> {
    let has = units_this_sdk_has();
    cases()
        .iter()
        .filter(|case| has.contains(unit_of(case)))
        .collect()
}

fn fixture(name: &str) -> Result<&'static Value, String> {
    TABLE
        .get("fixtures")
        .and_then(|fixtures| fixtures.get(name))
        .ok_or_else(|| format!("the table has no fixture {name}"))
}

/// `value` with each `{"$fixture": name}` replaced by the table's fixture.
fn resolved(value: &Value) -> Result<Value, String> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(resolved)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(members) => match members.get("$fixture") {
            Some(name) if members.len() == 1 => resolved(fixture(text(name, "a fixture's name")?)?),
            _ => members
                .iter()
                .map(|(key, item)| Ok((key.clone(), resolved(item)?)))
                .collect::<Result<Map<_, _>, String>>()
                .map(Value::Object),
        },
        other => Ok(other.clone()),
    }
}

fn payload(value: &Value) -> Result<Map<String, Value>, String> {
    match resolved(value)? {
        Value::Object(members) => Ok(members),
        other => Err(format!("a payload is an object, not {other}")),
    }
}

/// A duration's base, from the timing table that owns it.
fn timing_ms(name: &str) -> Result<f64, String> {
    TIMING
        .get("timing")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|entry| entry.get("value"))
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{name} is no duration of specs/src/client/timing.json"))
}

/// A duration as the table states it, in milliseconds.
fn duration_ms(value: &Value) -> Result<f64, String> {
    match value {
        Value::Number(ms) => ms
            .as_f64()
            .ok_or_else(|| format!("{ms} is no number of milliseconds")),
        Value::Object(stated) => {
            let base = timing_ms(text(field(stated, "timing")?, "a timing")?)?;
            let times = match stated.get("times") {
                Some(times) => times
                    .as_f64()
                    .ok_or_else(|| format!("times is not a number: {times}"))?,
                None => 1.0,
            };
            let plus = match stated.get("plusMs") {
                Some(plus) => plus
                    .as_f64()
                    .ok_or_else(|| format!("plusMs is not a number: {plus}"))?,
                None => 0.0,
            };
            Ok(base * times + plus)
        }
        other => Err(format!("a duration is milliseconds, or a timing: {other}")),
    }
}

fn duration(value: &Value) -> Result<Duration, String> {
    let ms = duration_ms(value)?;
    Duration::try_from_secs_f64(ms / 1000.0).map_err(|wrong| format!("{ms} ms: {wrong}"))
}

/// A duration a unit is made with, which it takes in whole milliseconds.
fn whole_ms(value: &Value) -> Result<Duration, String> {
    let ms = duration_ms(value)?.round();
    Duration::try_from_secs_f64(ms / 1000.0).map_err(|wrong| format!("{ms} ms: {wrong}"))
}

// ── The search a pipeline searches with ─────────────────────────────────

type Answer = Option<Vec<String>>;

type Asked = Arc<Mutex<Vec<(String, mpsc::UnboundedSender<Answer>)>>>;

/// What a case's search pipeline searches with: it records each query it is
/// asked, and gives each the answers a step gives it.
#[derive(Clone, Default)]
struct Searches {
    asked: Asked,
}

/// The search itself: each query it is asked goes into `asked`, with what
/// answers it.
fn searching(asked: Asked) -> impl Fn(&str) -> UnboundedReceiverStream<Answer> + Send + 'static {
    move |query: &str| {
        let (answers, given) = mpsc::unbounded_channel();
        locked(&asked).push((query.to_owned(), answers));
        UnboundedReceiverStream::new(given)
    }
}

impl Searches {
    /// Answer the `nth` query.
    fn answer(&self, nth: usize, results: Answer) -> Result<(), String> {
        let asked = locked(&self.asked);
        let (_, answers) = asked
            .get(nth)
            .ok_or_else(|| format!("query #{nth} was not asked"))?;
        // One that was abandoned has nobody to give it to.
        let _ = answers.send(results);
        Ok(())
    }

    fn queries(&self) -> Vec<String> {
        locked(&self.asked)
            .iter()
            .map(|(query, _)| query.clone())
            .collect()
    }
}

// ── The units, and how each is made ─────────────────────────────────────

enum Unit {
    Match(MatchStateUnit),
    Beckon(BeckonStateUnit),
    HoverDwell(HoverDwell),
    Gather(GatherStateUnit),
    Search(SearchPipeline<String>),
    Yield(YieldStateUnit),
    Mark(MarkStateUnit),
    SessionSignals(SessionSignals),
}

fn not_a(kind: &str) -> String {
    format!("the unit is no {kind}")
}

impl Unit {
    fn state_unit(&self) -> &dyn StateUnit {
        match self {
            Unit::Match(unit) => unit,
            Unit::Beckon(unit) => unit,
            Unit::HoverDwell(unit) => unit,
            Unit::Gather(unit) => unit,
            Unit::Search(unit) => unit,
            Unit::Yield(unit) => unit,
            Unit::Mark(unit) => unit,
            Unit::SessionSignals(unit) => unit,
        }
    }

    fn dispose(&self) {
        self.state_unit().dispose();
    }

    fn as_beckon(&self) -> Result<&BeckonStateUnit, String> {
        match self {
            Unit::Beckon(unit) => Ok(unit),
            _ => Err(not_a("beckon")),
        }
    }

    fn as_hover_dwell(&self) -> Result<&HoverDwell, String> {
        match self {
            Unit::HoverDwell(unit) => Ok(unit),
            _ => Err(not_a("hoverDwell")),
        }
    }

    fn as_gather(&self) -> Result<&GatherStateUnit, String> {
        match self {
            Unit::Gather(unit) => Ok(unit),
            _ => Err(not_a("gather")),
        }
    }

    fn as_search(&self) -> Result<&SearchPipeline<String>, String> {
        match self {
            Unit::Search(unit) => Ok(unit),
            _ => Err(not_a("search")),
        }
    }

    fn as_yield(&self) -> Result<&YieldStateUnit, String> {
        match self {
            Unit::Yield(unit) => Ok(unit),
            _ => Err(not_a("yield")),
        }
    }

    fn as_mark(&self) -> Result<&MarkStateUnit, String> {
        match self {
            Unit::Mark(unit) => Ok(unit),
            _ => Err(not_a("mark")),
        }
    }

    fn as_session_signals(&self) -> Result<&SessionSignals, String> {
        match self {
            Unit::SessionSignals(unit) => Ok(unit),
            _ => Err(not_a("sessionSignals")),
        }
    }
}

type Make = fn(&Arc<SemiontClient>, &Searches, &Map<String, Value>) -> Result<Unit, String>;

/// How this SDK makes a unit it has, from the client and what the case makes
/// it from.
struct Maker {
    unit: &'static str,
    make: Make,
}

fn search_pipeline(
    searches: &Searches,
    made: &Map<String, Value>,
) -> Result<SearchPipeline<String>, String> {
    // What a case leaves out is the pipeline's own.
    let mut options = SearchPipelineOptions::default();
    if let Some(debounce) = made.get("debounceMs") {
        options.debounce = whole_ms(debounce)?;
    }
    if let Some(query) = made.get("initialQuery") {
        options.initial_query = text(query, "an initial query")?.to_owned();
    }
    Ok(SearchPipeline::new(
        searching(searches.asked.clone()),
        options,
    ))
}

fn makers() -> Vec<Maker> {
    vec![
        Maker {
            unit: "match",
            make: |client, _, _| Ok(Unit::Match(MatchStateUnit::new(client.clone()))),
        },
        Maker {
            unit: "beckon",
            make: |client, _, made| {
                Ok(Unit::Beckon(BeckonStateUnit::new(
                    client.clone(),
                    &id(made, "resourceId")?,
                )))
            },
        },
        Maker {
            unit: "hoverDwell",
            make: |client, _, made| {
                let delay = whole_ms(field(made, "delayMs")?)?;
                let client = client.clone();
                Ok(Unit::HoverDwell(HoverDwell::new(
                    move |annotation_id| client.beckon.hover(annotation_id),
                    delay,
                )))
            },
        },
        Maker {
            unit: "gather",
            make: |client, _, made| {
                Ok(Unit::Gather(GatherStateUnit::new(
                    client.clone(),
                    &id(made, "resourceId")?,
                )))
            },
        },
        Maker {
            unit: "search",
            make: |_, searches, made| search_pipeline(searches, made).map(Unit::Search),
        },
        Maker {
            unit: "yield",
            make: |client, _, made| {
                Ok(Unit::Yield(YieldStateUnit::new(
                    client.clone(),
                    text(field(made, "locale")?, "a locale")?,
                )))
            },
        },
        Maker {
            unit: "mark",
            make: |client, _, made| {
                Ok(Unit::Mark(MarkStateUnit::new(
                    client.clone(),
                    &id(made, "resourceId")?,
                )))
            },
        },
        Maker {
            unit: "sessionSignals",
            make: |_, _, _| Ok(Unit::SessionSignals(SessionSignals::new())),
        },
    ]
}

// ── The methods a case invokes ──────────────────────────────────────────

type Invoke = fn(&Unit, &Map<String, Value>) -> Result<(), String>;

/// A unit's method, as a case calls it: with its arguments by the names of
/// the parameters it takes.
struct Adapter {
    unit: &'static str,
    method: &'static str,
    parameters: &'static [&'static str],
    call: Invoke,
}

/// Every reason a session ends for. The match is the compiler's census: a
/// reason added to the enum does not compile here until it is listed.
fn session_end_reasons() -> [SessionEndReason; 2] {
    let every = [SessionEndReason::Expired, SessionEndReason::Refused];
    for reason in every {
        match reason {
            SessionEndReason::Expired | SessionEndReason::Refused => {}
        }
    }
    every
}

fn session_end_reason(value: &Value) -> Result<SessionEndReason, String> {
    let named = text(value, "a reason")?;
    session_end_reasons()
        .into_iter()
        .find(|reason| reason.as_str() == named)
        .ok_or_else(|| format!("no session ends for the reason {named}"))
}

fn adapters() -> Vec<Adapter> {
    vec![
        Adapter {
            unit: "beckon",
            method: "focus",
            parameters: &["annotationId"],
            call: |unit, args| {
                unit.as_beckon()?.focus(&id(args, "annotationId")?);
                Ok(())
            },
        },
        Adapter {
            unit: "gather",
            method: "gatherAnnotation",
            parameters: &[
                "annotationId",
                "contextWindow",
                "includeSourceContext",
                "includeTargetContext",
            ],
            call: |unit, args| {
                let context_window = args
                    .get("contextWindow")
                    .map(|window| {
                        window
                            .as_u64()
                            .and_then(|window| u16::try_from(window).ok())
                            .ok_or_else(|| format!("contextWindow is not a window: {window}"))
                    })
                    .transpose()?;
                let flag = |name: &str| {
                    args.get(name)
                        .map(|stated| {
                            stated
                                .as_bool()
                                .ok_or_else(|| format!("{name} is not a boolean: {stated}"))
                        })
                        .transpose()
                };
                let options = GatherAnnotationOptions {
                    context_window,
                    include_source_context: flag("includeSourceContext")?,
                    include_target_context: flag("includeTargetContext")?,
                };
                unit.as_gather()?
                    .gather_annotation(&id(args, "annotationId")?, options);
                Ok(())
            },
        },
        Adapter {
            unit: "gather",
            method: "gatherResource",
            parameters: &["resourceId"],
            call: |unit, args| {
                unit.as_gather()?.gather_resource(
                    &id(args, "resourceId")?,
                    GatherResourceRequestOptions::default(),
                );
                Ok(())
            },
        },
        Adapter {
            unit: "hoverDwell",
            method: "enter",
            parameters: &["annotationId"],
            call: |unit, args| {
                unit.as_hover_dwell()?.enter(&id(args, "annotationId")?);
                Ok(())
            },
        },
        Adapter {
            unit: "hoverDwell",
            method: "leave",
            parameters: &[],
            call: |unit, _| {
                unit.as_hover_dwell()?.leave();
                Ok(())
            },
        },
        Adapter {
            unit: "search",
            method: "setQuery",
            parameters: &["value"],
            call: |unit, args| {
                unit.as_search()?
                    .set_query(text(field(args, "value")?, "a query")?);
                Ok(())
            },
        },
        Adapter {
            unit: "sessionSignals",
            method: "notifySessionEnded",
            parameters: &["reason"],
            call: |unit, args| {
                unit.as_session_signals()?
                    .notify_session_ended(session_end_reason(field(args, "reason")?)?);
                Ok(())
            },
        },
        Adapter {
            unit: "sessionSignals",
            method: "notifyPermissionDenied",
            parameters: &["detail"],
            call: |unit, args| {
                let detail = field(args, "detail")?;
                let detail = if detail.is_null() {
                    None
                } else {
                    Some(text(detail, "a detail")?)
                };
                unit.as_session_signals()?.notify_permission_denied(detail);
                Ok(())
            },
        },
        Adapter {
            unit: "sessionSignals",
            method: "notifyKbIdentityConflict",
            parameters: &["conflict"],
            call: |unit, args| {
                let conflict = object(field(args, "conflict")?, "a conflict")?;
                unit.as_session_signals()?
                    .notify_kb_identity_conflict(KbIdentityConflict {
                        expected_did: text(field(conflict, "expectedDid")?, "a DID")?.to_owned(),
                        observed_did: text(field(conflict, "observedDid")?, "a DID")?.to_owned(),
                    });
                Ok(())
            },
        },
        Adapter {
            unit: "sessionSignals",
            method: "acknowledgeSessionEnded",
            parameters: &[],
            call: |unit, _| {
                unit.as_session_signals()?.acknowledge_session_ended();
                Ok(())
            },
        },
        Adapter {
            unit: "sessionSignals",
            method: "acknowledgePermissionDenied",
            parameters: &[],
            call: |unit, _| {
                unit.as_session_signals()?.acknowledge_permission_denied();
                Ok(())
            },
        },
        Adapter {
            unit: "sessionSignals",
            method: "acknowledgeKbIdentityConflict",
            parameters: &[],
            call: |unit, _| {
                unit.as_session_signals()?
                    .acknowledge_kb_identity_conflict();
                Ok(())
            },
        },
        Adapter {
            unit: "yield",
            method: "generate",
            parameters: &["params", "stallDeadlineMs"],
            call: |unit, args| {
                let params: GenerationJobParams =
                    serde_json::from_value(field(args, "params")?.clone())
                        .map_err(|wrong| format!("params: {wrong}"))?;
                let stall_deadline = args.get("stallDeadlineMs").map(duration).transpose()?;
                unit.as_yield()?.generate(params, stall_deadline);
                Ok(())
            },
        },
        Adapter {
            unit: "yield",
            method: "dismissProgress",
            parameters: &[],
            call: |unit, _| {
                unit.as_yield()?.dismiss_progress();
                Ok(())
            },
        },
        Adapter {
            unit: "mark",
            method: "requestDelegate",
            parameters: &["params"],
            call: |unit, args| {
                let params: MarkJobParams = serde_json::from_value(field(args, "params")?.clone())
                    .map_err(|wrong| format!("params: {wrong}"))?;
                unit.as_mark()?.request_delegate(params);
                Ok(())
            },
        },
        Adapter {
            unit: "mark",
            method: "cancelPending",
            parameters: &[],
            call: |unit, _| {
                unit.as_mark()?.cancel_pending();
                Ok(())
            },
        },
        Adapter {
            unit: "mark",
            method: "dismissProgress",
            parameters: &[],
            call: |unit, _| {
                unit.as_mark()?.dismiss_progress();
                Ok(())
            },
        },
    ]
}

fn adapter(unit: &str, method: &str) -> Result<Adapter, String> {
    adapters()
        .into_iter()
        .find(|adapter| adapter.unit == unit && adapter.method == method)
        .ok_or_else(|| format!("no adapter calls {unit}.{method}"))
}

// ── The members a case reads, as the wire writes them ───────────────────

/// What a member holds: a value as the wire writes it, or an error, which a
/// case compares on its code and its message.
enum Reading {
    Value(Value),
    Error { code: String, message: String },
}

impl Reading {
    fn written(&self) -> Value {
        match self {
            Reading::Value(value) => value.clone(),
            Reading::Error { code, message } => json!({ "code": code, "message": message }),
        }
    }
}

/// A member now: what it holds, and whether its readers have ended.
struct Member {
    reading: Reading,
    ended: bool,
}

fn member<T>(
    receiver: watch::Receiver<T>,
    write: impl FnOnce(&T) -> Result<Reading, String>,
) -> Result<Member, String> {
    let ended = receiver.has_changed().is_err();
    let reading = write(&receiver.borrow())?;
    Ok(Member { reading, ended })
}

fn model<T: Serialize>(held: &T) -> Result<Reading, String> {
    serde_json::to_value(held)
        .map(Reading::Value)
        .map_err(|wrong| format!("it holds what the wire cannot write: {wrong}"))
}

fn message_of(error: &SemiontError) -> &str {
    match error {
        SemiontError::Bus(error) => &error.message,
        SemiontError::Transport(error) => &error.message,
        SemiontError::Job(error) => &error.message,
    }
}

fn failure(held: &Option<SemiontError>) -> Result<Reading, String> {
    Ok(match held {
        None => Reading::Value(Value::Null),
        Some(error) => Reading::Error {
            code: error.code().to_owned(),
            message: message_of(error).to_owned(),
        },
    })
}

type Read = fn(&Unit) -> Result<Member, String>;

/// A unit's member, as a case reads it: by its name.
struct Reader {
    unit: &'static str,
    member: &'static str,
    read: Read,
}

fn readers() -> Vec<Reader> {
    vec![
        Reader {
            unit: "beckon",
            member: "hoveredAnnotationId",
            read: |unit| member(unit.as_beckon()?.hovered_annotation_id(), model),
        },
        Reader {
            unit: "gather",
            member: "context",
            read: |unit| member(unit.as_gather()?.context(), model),
        },
        Reader {
            unit: "gather",
            member: "loading",
            read: |unit| member(unit.as_gather()?.loading(), model),
        },
        Reader {
            unit: "gather",
            member: "error",
            read: |unit| member(unit.as_gather()?.error(), failure),
        },
        Reader {
            unit: "gather",
            member: "annotationId",
            read: |unit| member(unit.as_gather()?.annotation_id(), model),
        },
        Reader {
            unit: "gather",
            member: "resourceContext",
            read: |unit| member(unit.as_gather()?.resource_context(), model),
        },
        Reader {
            unit: "gather",
            member: "resourceLoading",
            read: |unit| member(unit.as_gather()?.resource_loading(), model),
        },
        Reader {
            unit: "gather",
            member: "resourceError",
            read: |unit| member(unit.as_gather()?.resource_error(), failure),
        },
        Reader {
            unit: "search",
            member: "query",
            read: |unit| member(unit.as_search()?.query(), model),
        },
        Reader {
            unit: "search",
            member: "state",
            read: |unit| member(unit.as_search()?.state(), model),
        },
        Reader {
            unit: "yield",
            member: "isGenerating",
            read: |unit| member(unit.as_yield()?.is_generating(), model),
        },
        Reader {
            unit: "yield",
            member: "progress",
            read: |unit| member(unit.as_yield()?.progress(), model),
        },
        Reader {
            unit: "yield",
            member: "outcome",
            read: |unit| member(unit.as_yield()?.outcome(), model),
        },
        Reader {
            unit: "yield",
            member: "failure",
            read: |unit| member(unit.as_yield()?.failure(), failure),
        },
        Reader {
            unit: "yield",
            member: "jobId",
            read: |unit| member(unit.as_yield()?.job_id(), model),
        },
        Reader {
            unit: "mark",
            member: "pendingAnnotation",
            read: |unit| member(unit.as_mark()?.pending_annotation(), model),
        },
        Reader {
            unit: "mark",
            member: "delegatingMotivation",
            read: |unit| member(unit.as_mark()?.delegating_motivation(), model),
        },
        Reader {
            unit: "mark",
            member: "progress",
            read: |unit| member(unit.as_mark()?.progress(), model),
        },
        Reader {
            unit: "mark",
            member: "progressMotivation",
            read: |unit| member(unit.as_mark()?.progress_motivation(), model),
        },
        Reader {
            unit: "mark",
            member: "failure",
            read: |unit| member(unit.as_mark()?.failure(), failure),
        },
        Reader {
            unit: "mark",
            member: "jobId",
            read: |unit| member(unit.as_mark()?.job_id(), model),
        },
        Reader {
            unit: "sessionSignals",
            member: "sessionEnded",
            read: |unit| member(unit.as_session_signals()?.session_ended(), model),
        },
        Reader {
            unit: "sessionSignals",
            member: "permissionDenied",
            read: |unit| member(unit.as_session_signals()?.permission_denied(), model),
        },
        Reader {
            unit: "sessionSignals",
            member: "kbIdentityConflict",
            read: |unit| member(unit.as_session_signals()?.kb_identity_conflict(), model),
        },
    ]
}

fn reader(unit: &str, member: &str) -> Result<Reader, String> {
    readers()
        .into_iter()
        .find(|reader| reader.unit == unit && reader.member == member)
        .ok_or_else(|| format!("no reader reads {unit}.{member}"))
}

/// Whether `actual` is what `expected` states: exactly, but where `$has` asks
/// only for some members. A number is the same number however it is written.
fn matches(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Object(stated), _) if stated.len() == 1 && stated.contains_key("$has") => {
            match (stated.get("$has"), actual) {
                (Some(Value::Object(has)), Value::Object(actual)) => has
                    .iter()
                    .all(|(key, value)| actual.get(key).is_some_and(|other| matches(value, other))),
                _ => false,
            }
        }
        (Value::Object(stated), Value::Object(actual)) => {
            stated.len() == actual.len()
                && stated
                    .iter()
                    .all(|(key, value)| actual.get(key).is_some_and(|other| matches(value, other)))
        }
        (Value::Array(stated), Value::Array(actual)) => {
            stated.len() == actual.len()
                && stated
                    .iter()
                    .zip(actual)
                    .all(|(one, other)| matches(one, other))
        }
        (Value::Number(stated), Value::Number(actual)) => {
            stated == actual || stated.as_f64() == actual.as_f64()
        }
        _ => expected == actual,
    }
}

/// Whether a member holds what `expected` states. An error is compared on
/// what the case states of it.
fn holds(expected: &Value, reading: &Reading) -> Result<bool, String> {
    match reading {
        Reading::Error { .. } => {
            let stated = expected.as_object().ok_or_else(|| {
                format!(
                    "it holds an error, {}, and the case states {expected}",
                    reading.written()
                )
            })?;
            let written = reading.written();
            Ok(stated
                .iter()
                .all(|(key, value)| written.get(key) == Some(value)))
        }
        Reading::Value(value) => Ok(matches(&resolved(expected)?, value)),
    }
}

// ── The transport ───────────────────────────────────────────────────────

fn jobs(operation: &str, _asked: &Map<String, Value>) -> Result<Option<Value>, String> {
    match operation {
        "job:create" => Ok(Some(json!({ "jobId": "job-1" }))),
        "job:status-requested" => Ok(Some(json!({
            "jobId": "job-1",
            "type": "mark",
            "status": "running",
            "userId": "did:web:example.org:users:alice",
            "created": "2026-10-01T00:00:00.000Z",
        }))),
        other => Err(format!("{other} is refused here")),
    }
}

/// A queued response: one, or none for a reply that carries none.
fn response(value: &Value) -> Result<Option<Value>, String> {
    Ok(match resolved(value)? {
        Value::Null => None,
        given => Some(given),
    })
}

/// The transport a case states. Its stream carries what a client's does: the
/// replies and the broadcasts, never the requests.
fn transport_of(stated: &Value) -> Result<FaultyTransport, String> {
    let stated = object(stated, "a transport")?;
    let schedule = match stated.get("delayMs") {
        Some(delay) => vec![FaultAction::Delay(duration(delay)?)],
        None => Vec::new(),
    };
    let transport = match text(field(stated, "answers")?, "transport.answers")? {
        "never" => {
            if !schedule.is_empty() {
                return Err("a transport that never answers holds no reply".to_owned());
            }
            FaultyTransport::answering(vec![FaultAction::DropReply], |_, _| Ok(None))
        }
        "refuses" => FaultyTransport::new(schedule),
        "jobs" => FaultyTransport::answering(schedule, jobs),
        other => return Err(format!("no transport answers {other}")),
    };
    if let Some(replies) = stated.get("replies") {
        for (operation, responses) in object(replies, "transport.replies")? {
            let responses = array(responses, "a reply's responses")?
                .iter()
                .map(response)
                .collect::<Result<Vec<_>, _>>()?;
            transport.queue_reply(operation, responses);
        }
    }
    Ok(transport)
}

fn requests(transport: &FaultyTransport, channel: &str) -> Vec<RequestLogEntry> {
    transport
        .request_log()
        .into_iter()
        .filter(|entry| entry.channel == channel)
        .collect()
}

/// The correlation id the `nth` request sent on `channel` carried.
fn request_id(
    transport: &FaultyTransport,
    channel: &str,
    nth: usize,
) -> Result<Option<String>, String> {
    requests(transport, channel)
        .into_iter()
        .nth(nth)
        .map(|entry| entry.correlation_id)
        .ok_or_else(|| format!("request #{nth} on {channel} was not sent"))
}

// ── A case, played ──────────────────────────────────────────────────────

/// What the `listen` channels carried, in order.
type Heard = Arc<Mutex<Vec<Result<Frame, Lagged>>>>;

struct World {
    kind: String,
    client: Arc<SemiontClient>,
    transport: FaultyTransport,
    searches: Searches,
    units: BTreeMap<String, Unit>,
    heard: Heard,
    /// How much of what was heard a `heard` step has checked.
    told: usize,
}

fn correlation(step: &Map<String, Value>) -> Result<Option<String>, String> {
    step.get("correlationId")
        .map(|given| text(given, "a correlation id").map(str::to_owned))
        .transpose()
}

impl World {
    fn unit(&self, name: &str) -> Result<&Unit, String> {
        self.units
            .get(name)
            .ok_or_else(|| format!("no unit {name} was made"))
    }

    fn read(&self, name: &str, member: &str) -> Result<Member, String> {
        (reader(&self.kind, member)?.read)(self.unit(name)?)
    }

    async fn perform(&mut self, step: &Value) -> Result<(), String> {
        if step.as_str() == Some("settle") {
            settle().await;
            return Ok(());
        }
        let step = object(step, "a step")?;
        if let Some(channel) = step.get("say") {
            self.client.bus().emit(
                text(channel, "a channel")?,
                payload(field(step, "payload")?)?,
                Envelope {
                    correlation_id: correlation(step)?,
                    scope: None,
                },
            );
        } else if let Some(channel) = step.get("deliver") {
            self.transport.deliver(Frame {
                channel: text(channel, "a channel")?.to_owned(),
                payload: payload(field(step, "payload")?)?,
                correlation_id: correlation(step)?,
                scope: None,
                trace: None,
            });
        } else if let Some(channel) = step.get("answer") {
            let asked = request_id(
                &self.transport,
                text(channel, "a request's channel")?,
                index(field(step, "nth")?, "a request's place")?,
            )?;
            self.transport.deliver(Frame {
                channel: text(field(step, "reply")?, "a reply's channel")?.to_owned(),
                payload: payload(field(step, "payload")?)?,
                correlation_id: asked,
                scope: None,
                trace: None,
            });
        } else if let Some(operation) = step.get("queueReply") {
            self.transport.queue_reply(
                text(operation, "an operation")?,
                [response(field(step, "response")?)?],
            );
        } else if let Some(method) = step.get("invoke") {
            let method = text(method, "a method")?;
            let unit = self.unit(text(field(step, "of")?, "a unit")?)?;
            let args = payload(field(step, "args")?)?;
            let adapter = adapter(&self.kind, method)?;
            if let Some(unknown) = args
                .keys()
                .find(|name| !adapter.parameters.contains(&name.as_str()))
            {
                return Err(format!("{}.{method} takes no {unknown}", self.kind));
            }
            (adapter.call)(unit, &args)?;
        } else if let Some(passed) = step.get("pass") {
            // What is ready runs at the time it became ready, before the clock
            // moves; what falls due runs to its end, each at its own time.
            let passed = duration(passed)?;
            settle().await;
            tokio::time::sleep(passed).await;
            settle().await;
        } else if let Some(name) = step.get("dispose") {
            self.unit(text(name, "a unit")?)?.dispose();
        } else if let Some(nth) = step.get("answerSearch") {
            let results = field(step, "results")?;
            let results = if results.is_null() {
                None
            } else {
                Some(strings(results, "an answer's results")?)
            };
            self.searches
                .answer(index(nth, "a query's place")?, results)?;
        } else if let Some(stated) = step.get("searched") {
            let queries = self.searches.queries();
            if queries != strings(stated, "searched")? {
                return Err(format!("the search was asked {queries:?}"));
            }
        } else if let Some(expected) = step.get("expect") {
            for (name, members) in object(expected, "expect")? {
                for (member, value) in object(members, "a unit's members")? {
                    let reading = self.read(name, member)?.reading;
                    if !holds(value, &reading)? {
                        return Err(format!(
                            "{name}.{member} holds {}, not {value}",
                            reading.written()
                        ));
                    }
                }
            }
        } else if let Some(channel) = step.get("sent") {
            let channel = text(channel, "a request's channel")?;
            let sent: Vec<Value> = requests(&self.transport, channel)
                .into_iter()
                .map(|entry| Value::Object(entry.payload))
                .collect();
            if let Some(count) = step.get("count") {
                let count = index(count, "a count")?;
                if sent.len() != count {
                    return Err(format!(
                        "{} requests were sent on {channel}, not {count}",
                        sent.len()
                    ));
                }
            } else {
                let sent = Value::Array(sent);
                if !matches(&resolved(field(step, "payloads")?)?, &sent) {
                    return Err(format!("sent on {channel}: {sent}"));
                }
            }
        } else if step.contains_key("nothingSent") {
            let sent: Vec<String> = self
                .transport
                .request_log()
                .into_iter()
                .map(|entry| entry.channel)
                .collect();
            if !sent.is_empty() {
                return Err(format!("requests were sent: {sent:?}"));
            }
        } else if let Some(stated) = step.get("heard") {
            settle().await;
            let frames = locked(&self.heard)[self.told..]
                .iter()
                .cloned()
                .collect::<Result<Vec<Frame>, Lagged>>()
                .map_err(|lagged| {
                    format!("the listen channels' reader fell behind by {}", lagged.0)
                })?;
            self.check_heard(array(stated, "heard")?, &frames)?;
            self.told += frames.len();
        } else if let Some(ended) = step.get("ended") {
            for (name, members) in object(ended, "ended")? {
                for member in strings(members, "ended")? {
                    if !self.read(name, &member)?.ended {
                        return Err(format!("{name}.{member} has not ended"));
                    }
                }
            }
        } else if let Some(destroyed) = step.get("busDestroyed") {
            let stated = destroyed.as_bool().ok_or("busDestroyed is true or false")?;
            let destroyed = self.client.bus().destroyed();
            if destroyed != stated {
                let not = if destroyed { "" } else { " not" };
                return Err(format!("the client's bus is{not} destroyed"));
            }
        } else {
            return Err("no step this runner performs".to_owned());
        }
        Ok(())
    }

    fn check_heard(&self, stated: &[Value], frames: &[Frame]) -> Result<(), String> {
        let got = Value::Array(
            frames
                .iter()
                .map(|frame| {
                    json!({
                        "channel": frame.channel,
                        "payload": frame.payload,
                        "correlationId": frame.correlation_id,
                    })
                })
                .collect(),
        );
        if stated.len() != frames.len() {
            return Err(format!("heard {got}"));
        }
        for (wanted, frame) in stated.iter().zip(frames) {
            let wanted = object(wanted, "a frame heard")?;
            let expected_id = match wanted.get("correlationId") {
                None => None,
                Some(Value::String(given)) => Some(given.clone()),
                Some(named) => {
                    let named = object(named, "a request's correlation id")?;
                    request_id(
                        &self.transport,
                        text(field(named, "sent")?, "a request's channel")?,
                        index(field(named, "nth")?, "a request's place")?,
                    )?
                }
            };
            let payload = resolved(field(wanted, "payload")?)?;
            if frame.channel != text(field(wanted, "channel")?, "a channel")?
                || !matches(&payload, &Value::Object(frame.payload.clone()))
                || frame.correlation_id != expected_id
            {
                return Err(format!("heard {got}"));
            }
        }
        Ok(())
    }
}

async fn play(case: &Value) -> Result<(), String> {
    let case = object(case, "a case")?;
    let kind = text(field(case, "unit")?, "a case's unit")?.to_owned();
    let make = makers()
        .into_iter()
        .find(|maker| maker.unit == kind)
        .ok_or_else(|| format!("this runner makes no {kind}"))?
        .make;
    let transport = transport_of(field(case, "transport")?)?;
    let client = create_test_client(TestClientOptions {
        transport: Some(transport.clone()),
        ..TestClientOptions::default()
    })
    .client;
    let searches = Searches::default();
    let mut units = BTreeMap::new();
    for (name, given) in object(field(case, "made")?, "made")? {
        let given = object(given, "what a unit is made from")?;
        units.insert(name.clone(), make(&client, &searches, given)?);
    }
    let listen = match case.get("listen") {
        Some(listen) => strings(listen, "listen")?,
        None => Vec::new(),
    };
    let channels: Vec<&str> = listen.iter().map(String::as_str).collect();
    let heard = Heard::default();
    // Taken now, before anything runs, so what is said from the moment the
    // units are made is heard.
    let collector = (!channels.is_empty()).then(|| {
        let mut frames = client.bus().frames_among(&channels);
        let heard = heard.clone();
        tokio::spawn(async move {
            while let Some(frame) = frames.next().await {
                locked(&heard).push(frame);
            }
        })
    });
    let mut world = World {
        kind,
        client,
        transport,
        searches,
        units,
        heard,
        told: 0,
    };
    let mut outcome = Ok(());
    for (at, step) in array(field(case, "steps")?, "steps")?.iter().enumerate() {
        if let Err(broken) = world.perform(step).await {
            outcome = Err(format!("steps[{at}] {step}: {broken}"));
            break;
        }
    }
    for unit in world.units.values() {
        unit.dispose();
    }
    if let Some(collector) = collector {
        collector.abort();
    }
    settle().await;
    outcome
}

fn panic_message(panic: &(dyn Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic that says nothing".to_owned())
}

/// Play `case` on a runtime of its own, whose clock moves only when the case
/// moves it.
fn played(case: &Value) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .map_err(|wrong| format!("no runtime: {wrong}"))?;
    match catch_unwind(AssertUnwindSafe(|| runtime.block_on(play(case)))) {
        Ok(outcome) => outcome,
        Err(panic) => Err(format!("it panicked: {}", panic_message(&*panic))),
    }
}

// ── The census ──────────────────────────────────────────────────────────

/// Each step of each case this runner runs, with the unit its case is of.
fn steps_run() -> Vec<(&'static str, &'static Map<String, Value>)> {
    let mut steps = Vec::new();
    for case in run() {
        let unit = unit_of(case);
        let stated = case
            .get("steps")
            .and_then(Value::as_array)
            .expect("a case states its steps");
        steps.extend(
            stated
                .iter()
                .filter_map(Value::as_object)
                .map(|step| (unit, step)),
        );
    }
    steps
}

fn invoked() -> BTreeSet<(String, String)> {
    steps_run()
        .into_iter()
        .filter_map(|(unit, step)| {
            step.get("invoke")
                .and_then(Value::as_str)
                .map(|method| (unit.to_owned(), method.to_owned()))
        })
        .collect()
}

fn members_read() -> BTreeSet<(String, String)> {
    let mut read = BTreeSet::new();
    for (unit, step) in steps_run() {
        if let Some(expected) = step.get("expect").and_then(Value::as_object) {
            for members in expected.values().filter_map(Value::as_object) {
                read.extend(
                    members
                        .keys()
                        .map(|member| (unit.to_owned(), member.clone())),
                );
            }
        }
        if let Some(ended) = step.get("ended").and_then(Value::as_object) {
            for members in ended.values().filter_map(Value::as_array) {
                read.extend(
                    members
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|member| (unit.to_owned(), member.to_owned())),
                );
            }
        }
    }
    read
}

// ── The tests ───────────────────────────────────────────────────────────

#[test]
fn this_sdk_makes_each_unit_it_has_cases_of_and_no_other() {
    // A unit the table states no case of (the cache, whose behaviour its own
    // tables hold) needs no maker here.
    let made: BTreeSet<&str> = makers().iter().map(|maker| maker.unit).collect();
    let cased: BTreeSet<&str> = run().into_iter().map(unit_of).collect();
    assert_eq!(made, cased);
}

#[test]
fn every_case_is_of_a_unit_the_names_table_has() {
    let named: BTreeSet<&str> = NAMES
        .get("stateUnits")
        .and_then(Value::as_array)
        .expect("the names table names its state units")
        .iter()
        .map(|row| {
            row.get("unit")
                .and_then(Value::as_str)
                .expect("a row names its unit")
        })
        .collect();
    let cased: BTreeSet<&str> = cases().iter().map(unit_of).collect();
    assert!(
        cased.is_subset(&named),
        "cases of units the names table has not: {:?}",
        cased.difference(&named).collect::<Vec<_>>()
    );
}

#[test]
fn every_method_a_case_invokes_has_an_adapter_and_every_adapter_is_invoked() {
    let adapted: BTreeSet<(String, String)> = adapters()
        .iter()
        .map(|adapter| (adapter.unit.to_owned(), adapter.method.to_owned()))
        .collect();
    assert_eq!(adapted, invoked());
}

#[test]
fn every_member_a_case_reads_has_a_reader_and_every_reader_is_read() {
    let readable: BTreeSet<(String, String)> = readers()
        .iter()
        .map(|reader| (reader.unit.to_owned(), reader.member.to_owned()))
        .collect();
    assert_eq!(readable, members_read());
}

#[test]
fn a_unit_does_what_its_case_says() {
    let run = run();
    let failures: Vec<String> = run
        .iter()
        .filter_map(|case| {
            played(case).err().map(|broken| {
                let name = case
                    .get("case")
                    .and_then(Value::as_str)
                    .expect("a case says what it is");
                format!("{}: {name}: {broken}", unit_of(case))
            })
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} of {} cases failed:\n\n{}",
        failures.len(),
        run.len(),
        failures.join("\n\n")
    );
}

#[test]
fn the_runner_fails_a_case_whose_check_is_wrong() {
    let mut told = run()
        .into_iter()
        .find(|case| unit_of(case) == "match")
        .expect("a case of the match unit")
        .clone();
    let steps = told
        .get_mut("steps")
        .and_then(Value::as_array_mut)
        .expect("a case states its steps");
    for step in steps {
        if let Some(heard) = step.get_mut("heard") {
            *heard = json!([]);
        }
    }
    let broken = played(&told).expect_err("a case whose heard is wrong fails");
    assert!(
        broken.contains("heard"),
        "it failed for another reason: {broken}"
    );
}
