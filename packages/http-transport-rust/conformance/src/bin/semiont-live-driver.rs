//! The Rust live driver for the SDK conformance suite (tests/conformance/sdk):
//! the SDK's client, its live queries and their cache, driven one operation
//! per line on stdin, reporting each observer's states on stdout;
//! tests/conformance/sdk/README.md is the protocol.
//!
//! It reaches the SDK only as an application does, through what `semiont` and
//! `semiont-http-transport` export.

use semiont::cache::CacheState;
use semiont::cached::Observed;
use semiont::client::{CachePersistence, ClientOptions, ClientTiming, SemiontClient};
use semiont::namespaces::{Delegation, ResourceFilters};
use semiont::refresh::CacheQuery;
use semiont::storage::InMemorySessionStorage;
use semiont::transport::ConnectionState;
use semiont::types::{AnnotationId, GenerationJobParams, MarkJobParams, ResourceId};
use semiont_conformance_drivers::{
    Arguments, Driver, Ended, Running, count, failed, failure, identifier, locked, object, say,
    serve, text,
};
use semiont_http_transport::client::client;
use semiont_http_transport::transport::{HttpTransportConfig, Timing};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinSet};

/// The client, kept once closed: what a closed client does is part of what
/// the suite asks.
struct Open {
    client: Arc<SemiontClient>,
    closed: bool,
    /// The credential the client uses, held so its source stays open.
    _token: watch::Sender<Option<String>>,
}

#[derive(Default)]
struct Live {
    /// What a cache persists to, kept across `close` and the next `open`: a
    /// reload, to the client.
    storage: Arc<InMemorySessionStorage>,
    open: Mutex<Option<Open>>,
    /// Each observer's task, by the name the suite gave it.
    observers: Mutex<HashMap<String, AbortHandle>>,
    /// The state last reported, and the tasks that report what the client
    /// observes.
    reported: Mutex<Option<ConnectionState>>,
    reporters: Mutex<JoinSet<()>>,
}

fn value<T: Serialize>(of: &T) -> Result<Value, Ended> {
    serde_json::to_value(of)
        .map_err(|e| Ended::Misuse(format!("a value that does not serialize: {e}")))
}

/// The filters a case states for a list of resources, or for a search.
fn filters(query: &Arguments) -> Result<ResourceFilters, Ended> {
    let mut filters = ResourceFilters::default();
    if query.get("filters").is_some() {
        for (name, stated) in object(query, "filters")? {
            match name.as_str() {
                "limit" => filters.limit = stated.as_i64(),
                "archived" => filters.archived = stated.as_bool(),
                "entityType" => filters.entity_type = stated.as_str().map(str::to_owned),
                other => {
                    return Err(Ended::Misuse(format!(
                        "a filter by {other}, which no query of resources takes"
                    )));
                }
            }
        }
    }
    Ok(filters)
}

/// The live query of specs/src/client/refresh.json a case names.
fn named(query: &Arguments) -> Result<CacheQuery, Ended> {
    let name = text(query, "query")?;
    CacheQuery::ALL
        .iter()
        .copied()
        .find(|query| query.name() == name)
        .ok_or_else(|| Ended::Misuse(format!("no live query {name}")))
}

/// Do `$then` with the live query a case names, as `$cached`. A query of
/// the table with no arm does not compile.
macro_rules! with_query {
    ($client:expr, $query:expr, |$cached:ident| $then:expr) => {{
        let query: &Arguments = $query;
        let (browse, gather, match_) = (&$client.browse, &$client.gather, &$client.match_);
        let resource = || identifier::<ResourceId>(query, "resource");
        match named(query)? {
            CacheQuery::Resource => {
                let $cached = browse.resource(&resource()?);
                $then
            }
            CacheQuery::Annotations => {
                let $cached = browse.annotations(&resource()?);
                $then
            }
            CacheQuery::Annotation => {
                let $cached = browse.annotation(
                    &resource()?,
                    &identifier::<AnnotationId>(query, "annotation")?,
                );
                $then
            }
            CacheQuery::Events => {
                let $cached = browse.events(&resource()?);
                $then
            }
            CacheQuery::ReferencedBy => {
                let $cached = gather.referenced_by(&resource()?);
                $then
            }
            CacheQuery::Resources => {
                let $cached = browse.resources(filters(query)?);
                $then
            }
            CacheQuery::MatchedResources => {
                let $cached = match_.resources(text(query, "search")?, filters(query)?);
                $then
            }
            CacheQuery::EntityTypes => {
                let $cached = browse.entity_types();
                $then
            }
            CacheQuery::TagSchemas => {
                let $cached = browse.tag_schemas();
                $then
            }
            CacheQuery::Agents => {
                let $cached = browse.agents();
                $then
            }
        }
    }};
}

/// The line that says the observer `name` was given `state`.
fn emission<T: Serialize>(name: &str, state: CacheState<T>) -> Value {
    let state = match state {
        CacheState::Pending => json!({ "status": "pending" }),
        CacheState::Ready(value) => json!({ "status": "ready", "value": value }),
        CacheState::Failed(error) => json!({ "status": "failed", "error": failed(&error) }),
    };
    json!({ "emission": { "observer": name, "state": state } })
}

impl Live {
    fn client(&self) -> Result<Arc<SemiontClient>, Ended> {
        locked(&self.open)
            .as_ref()
            .map(|open| open.client.clone())
            .ok_or_else(|| Ended::Misuse("no client is open".to_owned()))
    }

    /// Report the state the transport is in, unless it is the one last reported.
    fn report(&self, state: ConnectionState) {
        let mut reported = locked(&self.reported);
        if *reported != Some(state) {
            *reported = Some(state);
            say(json!({ "state": state.as_str() }));
        }
    }

    fn open(self: &Arc<Self>, args: &Arguments) -> Result<Value, Ended> {
        if locked(&self.open).as_ref().is_some_and(|open| !open.closed) {
            return Err(Ended::Misuse("a client is already open".to_owned()));
        }
        let mut wire = Timing::default();
        let mut timing = ClientTiming::default();
        let stated = match args.get("timing") {
            None => &Arguments::new(),
            Some(_) => object(args, "timing")?,
        };
        let ms = |name: &str| count(stated, name).map(Duration::from_millis);
        for name in stated.keys() {
            match name.as_str() {
                "reconnectMs" => wire.reconnect = ms(name)?,
                "lazyRemoveMs" => wire.lazy_remove = ms(name)?,
                "lingerMs" => wire.linger = ms(name)?,
                "busRequestTimeoutMs" => timing.bus_request = ms(name)?,
                "invalidationWindowMs" => timing.invalidation_window = ms(name)?,
                "jobSilenceMs" => timing.job_silence = ms(name)?,
                "jobStatusPollMs" => timing.job_status_poll = ms(name)?,
                other => {
                    return Err(Ended::Misuse(format!(
                        "this driver cannot override {other}"
                    )));
                }
            }
        }
        let (token, tokens) = watch::channel(Some(text(args, "token")?.to_owned()));
        let client = Arc::new(client(
            HttpTransportConfig {
                base_url: text(args, "baseUrl")?.to_owned(),
                token: tokens,
                refresher: None,
                channels: None,
                http: reqwest::Client::new(),
                timing: wire,

                bookmarks: None,
            },
            ClientOptions {
                timing,
                cache_persistence: (args.get("persist") == Some(&Value::Bool(true))).then(|| {
                    CachePersistence {
                        storage: self.storage.clone(),
                        key_prefix: "conformance".to_owned(),
                    }
                }),
            },
        ));

        locked(&self.observers).clear();
        *locked(&self.reported) = None;
        let mut reporters = locked(&self.reporters);
        let mut state = client.state();
        let driver = self.clone();
        reporters.spawn(async move {
            loop {
                let current = *state.borrow_and_update();
                driver.report(current);
                if state.changed().await.is_err() {
                    driver.report(*state.borrow());
                    return;
                }
            }
        });
        let mut failures = client.transport().failures();
        reporters.spawn(async move {
            while let Some(reported) = failures.next().await {
                match reported {
                    Ok(error) => say(json!({
                        "error": failure(error.code.as_str(), error.status, error.message)
                    })),
                    Err(lagged) => eprintln!("the error stream: {lagged}"),
                }
            }
        });
        drop(reporters);

        *locked(&self.open) = Some(Open {
            client,
            closed: false,
            _token: token,
        });
        Ok(Value::Null)
    }

    async fn close(&self) -> Result<Value, Ended> {
        let client = self.client()?;
        client.close().await;
        if let Some(open) = locked(&self.open).as_mut() {
            open.closed = true;
        }
        Ok(Value::Null)
    }

    /// Report each state `observed` gives, as the observer `name`, and its end.
    ///
    /// The state a watcher is given at once, the query's state now, is said
    /// here, before this returns, and only the states after it from a task of
    /// their own. So it is written before the `observe` that began it is
    /// answered, and a case that reads what the observer holds straight after
    /// `observe` finds it there. Said from the task, it could be written
    /// after the answer: the two would be written from two tasks, in no order.
    async fn reporting<T: Serialize + Send + 'static>(
        &self,
        name: String,
        mut observed: Observed<T>,
    ) -> AbortHandle {
        let observing = match observed.next().await {
            Some(now) => {
                say(emission(&name, now));
                true
            }
            // The client is closed: the query completed before it gave a state.
            None => false,
        };
        locked(&self.reporters).spawn(async move {
            while observing && let Some(state) = observed.next().await {
                say(emission(&name, state));
            }
            say(json!({ "completed": name }));
        })
    }

    async fn observe(&self, args: &Arguments) -> Result<Value, Ended> {
        let client = self.client()?;
        let observer = text(args, "observer")?.to_owned();
        if locked(&self.observers).contains_key(&observer) {
            return Err(Ended::Misuse(format!("{observer} is already observing")));
        }
        let reporting = with_query!(client, object(args, "query")?, |cached| self
            .reporting(observer.clone(), cached.watch())
            .await);
        locked(&self.observers).insert(observer, reporting);
        Ok(Value::Null)
    }

    fn unobserve(&self, args: &Arguments) -> Result<Value, Ended> {
        let observer = text(args, "observer")?;
        match locked(&self.observers).remove(observer) {
            Some(reporting) => {
                reporting.abort();
                Ok(Value::Null)
            }
            None => Err(Ended::Misuse(format!("{observer} is not observing"))),
        }
    }

    /// A one-shot read of the live query a case names.
    async fn fresh(&self, query: &Arguments) -> Result<Value, Ended> {
        let client = self.client()?;
        let read = with_query!(client, query, |cached| value(&cached.fresh().await?)?);
        Ok(json!({ "value": read }))
    }

    fn invalidate(&self, query: &Arguments) -> Result<Value, Ended> {
        let client = self.client()?;
        with_query!(client, query, |cached| cached.invalidate());
        Ok(Value::Null)
    }

    /// A job followed to its end, observed as a live query is: each event it
    /// reports is a `ready` state, its failure a `failed` one, its end a
    /// completion. `job` gives the job to follow, once the observer's name
    /// is known to be free.
    fn follow<C: Serialize + Send + 'static>(
        &self,
        args: &Arguments,
        job: impl FnOnce() -> Result<Delegation<C>, Ended>,
    ) -> Result<Value, Ended> {
        let observer = text(args, "observer")?.to_owned();
        let mut observers = locked(&self.observers);
        if observers.contains_key(&observer) {
            return Err(Ended::Misuse(format!("{observer} is already observing")));
        }
        let mut following = job()?;
        let name = observer.clone();
        let task = locked(&self.reporters).spawn(async move {
            while let Some(reported) = following.next().await {
                let state = match reported {
                    Ok(event) => json!({ "status": "ready", "value": event }),
                    Err(error) => json!({ "status": "failed", "error": failed(&error) }),
                };
                say(json!({ "emission": { "observer": name, "state": state } }));
            }
            say(json!({ "completed": name }));
        });
        observers.insert(observer, task);
        Ok(Value::Null)
    }

    /// A `mark` job delegated for a resource. `params` is what the job is
    /// created with, its motivation among them.
    fn mark_delegate(&self, args: &Arguments) -> Result<Value, Ended> {
        let client = self.client()?;
        self.follow(args, || {
            let params: MarkJobParams =
                serde_json::from_value(Value::Object(object(args, "params")?.clone()))
                    .map_err(|e| Ended::Misuse(format!("params: {e}")))?;
            Ok(client
                .mark
                .delegate(&identifier::<ResourceId>(args, "resource")?, params))
        })
    }

    /// A `yield` job delegated, whose follower gives up on it after
    /// `stallDeadlineMs` of silence. `params` is what the job is created
    /// with, its context among them.
    fn yield_delegate(&self, args: &Arguments) -> Result<Value, Ended> {
        let client = self.client()?;
        self.follow(args, || {
            let params: GenerationJobParams =
                serde_json::from_value(Value::Object(object(args, "params")?.clone()))
                    .map_err(|e| Ended::Misuse(format!("params: {e}")))?;
            let stall = Duration::from_millis(count(args, "stallDeadlineMs")?);
            Ok(client.yield_.delegate(params, Some(stall)))
        })
    }

    async fn operation(self: &Arc<Self>, op: &str, args: Arguments) -> Result<Value, Ended> {
        match op {
            "open" => self.open(&args),
            "close" => self.close().await,
            "observe" => self.observe(&args).await,
            "unobserve" => self.unobserve(&args),
            "fresh" => self.fresh(object(&args, "query")?).await,
            "invalidate" => self.invalidate(object(&args, "query")?),
            "markDelegate" => self.mark_delegate(&args),
            "yieldDelegate" => self.yield_delegate(&args),
            "delete" => {
                let client = self.client()?;
                client
                    .mark
                    .delete(
                        &identifier::<ResourceId>(&args, "resource")?,
                        &identifier::<AnnotationId>(&args, "annotation")?,
                    )
                    .await?;
                Ok(Value::Null)
            }
            // Answers after everything the client reported before it: the
            // suite's way to know it has read every state an observer was in.
            "sync" => Ok(Value::Null),
            other => Err(Ended::Misuse(format!(
                "{other} is not an operation of this driver"
            ))),
        }
    }
}

impl Driver for Live {
    const OPERATIONS: &'static [&'static str] = &[
        "open",
        "close",
        "observe",
        "unobserve",
        "fresh",
        "invalidate",
        "markDelegate",
        "yieldDelegate",
        "delete",
        "sync",
    ];

    async fn run(
        self: Arc<Self>,
        _running: Arc<Running>,
        _id: u64,
        op: String,
        args: Arguments,
    ) -> Result<Value, Ended> {
        self.operation(&op, args).await
    }

    async fn finish(self: Arc<Self>) {
        if let Ok(client) = self.client() {
            client.close().await;
        }
        let mut reporters = std::mem::take(&mut *locked(&self.reporters));
        while reporters.join_next().await.is_some() {}
    }
}

#[tokio::main]
async fn main() {
    serve(Live::default()).await;
}
