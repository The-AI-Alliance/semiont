//! Staging with git: the one file that runs it. Deferred, deduped `git add`:
//! the index is for people who commit by hand, so it must be current within
//! seconds, not after every change.
//!
//! Files are moved and deleted HERE, and git is told afterwards. Asking git to
//! do the file operation makes it depend on git's view of the file: `git rm`
//! refuses one that is staged and not yet committed, `git mv` an untracked
//! one. A file operation happens or fails; only the staging is best-effort.
//!
//! The driver refuses a tree git cannot stage into: `ready` fails at boot.
//! Past boot it pays for no check. A move or a remove tells git itself, so it
//! reports git's refusal; a stage is queued behind its caller, so a batch that
//! fails is logged as a degradation and counted, and the caller has already
//! succeeded.
//!
//! Writes to the index are serialized per driver: the index is single-writer,
//! and a concurrent `git add` fails on `index.lock` rather than waiting.

use crate::{Bounds, Done, Staging, StagingError, rename, unlink};
use opentelemetry::KeyValue;
use opentelemetry::metrics::{Counter, Histogram};
use semiont_observability::{logging, telemetry};
use serde_json::json;
use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::Instant;

/// git has no wait for the index lock (its lock timeouts cover refs, not the
/// index) and `git add` against a held lock fails in milliseconds. So the
/// wait is here: about 3 s in all.
const LOCK_RETRY_DELAYS: [Duration; 6] = [
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(400),
    Duration::from_millis(800),
    Duration::from_millis(1600),
];

/// How a git invocation failed.
enum Failure {
    /// The program did not start.
    Spawn(std::io::Error),
    /// It ran and did not exit with zero.
    Exit {
        subcommand: String,
        code: Option<i32>,
        stderr: String,
    },
}

impl Failure {
    /// ONLY the lock race is retried; a bad pathspec or a broken repository fails fast.
    fn is_index_lock(&self) -> bool {
        matches!(self, Self::Exit { code: Some(128), stderr, .. } if stderr.contains("index.lock"))
    }

    /// Why git can never stage here, or nothing if the failure is not of that kind.
    fn cannot_stage(&self) -> Option<&'static str> {
        match self {
            Self::Spawn(_) => Some("git could not be run"),
            Self::Exit {
                code: Some(128),
                stderr,
                ..
            } if stderr.to_lowercase().contains("not a git repository") => {
                Some("git finds no repository there")
            }
            Self::Exit { .. } => None,
        }
    }

    /// git's own words, or ours when it said nothing.
    fn detail(&self) -> String {
        match self {
            Self::Spawn(error) => error.to_string(),
            Self::Exit {
                subcommand,
                code,
                stderr,
            } => {
                let said = stderr.trim();
                if !said.is_empty() {
                    said.to_string()
                } else if let Some(code) = code {
                    format!("git {subcommand} exited with {code}")
                } else {
                    format!("git {subcommand} was killed")
                }
            }
        }
    }
}

struct Pending {
    /// A set: many changes to one path count once.
    queued: BTreeSet<PathBuf>,
    /// When the oldest queued path arrived.
    oldest_at: Option<Instant>,
    /// When the queue is next due. The timer task reads it at every wake.
    deadline: Option<Instant>,
    timer_running: bool,
    disposed: bool,
}

struct Inner {
    root: PathBuf,
    bounds: Bounds,
    pending: Mutex<Pending>,
    /// Held across every command that writes the index, and the file
    /// operation it follows.
    index: tokio::sync::Mutex<()>,
}

pub(crate) struct GitStaging {
    inner: Arc<Inner>,
}

impl GitStaging {
    pub(crate) fn new(root: &Path, bounds: Bounds) -> Self {
        Self {
            inner: Arc::new(Inner {
                root: std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf()),
                bounds,
                pending: Mutex::new(Pending {
                    queued: BTreeSet::new(),
                    oldest_at: None,
                    deadline: None,
                    timer_running: false,
                    disposed: false,
                }),
                index: tokio::sync::Mutex::new(()),
            }),
        }
    }
}

fn args<const N: usize>(fixed: [&str; N], paths: &[&Path]) -> Vec<OsString> {
    fixed
        .iter()
        .map(OsString::from)
        .chain(paths.iter().map(|path| path.as_os_str().to_os_string()))
        .collect()
}

/// `semiont.git.duration`: every invocation, the failing ones too.
fn record_command(subcommand: &str, started: std::time::Instant) {
    static DURATION: OnceLock<Histogram<f64>> = OnceLock::new();
    let Some(meter) = telemetry::meter() else {
        return;
    };
    DURATION
        .get_or_init(|| {
            meter
                .f64_histogram("semiont.git.duration")
                .with_description("Wall time of a git subprocess. Async — this is latency, not event-loop blockage. Staging is deduped, so the `add` count is far below the number of appended events.")
                .with_unit("ms")
                .build()
        })
        .record(
            started.elapsed().as_secs_f64() * 1000.0,
            &[KeyValue::new("git.command", subcommand.to_string())],
        );
}

/// `semiont.git.staging.failures`: what makes a stale index visible.
fn record_failure(reason: &'static str) {
    static FAILURES: OnceLock<Counter<u64>> = OnceLock::new();
    let Some(meter) = telemetry::meter() else {
        return;
    };
    FAILURES
        .get_or_init(|| {
            meter
                .u64_counter("semiont.git.staging.failures")
                .with_description(
                    "Staging commands abandoned after retries; the index may be stale",
                )
                .build()
        })
        .add(1, &[KeyValue::new("reason", reason)]);
}

impl Inner {
    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn refusal(&self, why: &str) -> StagingError {
        StagingError(format!(
            "The knowledge base's config says [git] sync = true, and {} is not a git checkout ({why}). \
             Make it one (git init), or set sync = false.",
            self.root.display()
        ))
    }

    async fn run(&self, args: &[OsString]) -> Result<Vec<u8>, Failure> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(Failure::Spawn)?;
        if output.status.success() {
            return Ok(output.stdout);
        }
        Err(Failure::Exit {
            subcommand: subcommand(args),
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    /// One command, waiting out a held index lock. Measured once, retries included.
    async fn git(&self, args: &[OsString]) -> Result<(), Failure> {
        let started = std::time::Instant::now();
        let mut delays = LOCK_RETRY_DELAYS.iter();
        let result = loop {
            match self.run(args).await {
                Ok(_) => break Ok(()),
                Err(failure) => match delays.next() {
                    Some(delay) if failure.is_index_lock() => tokio::time::sleep(*delay).await,
                    _ => break Err(failure),
                },
            }
        };
        record_command(&subcommand(args), started);
        result
    }

    /// The operator's alert: the record is intact and the index is behind it.
    fn degraded(&self, failure: &Failure, paths: usize) {
        record_failure(if failure.is_index_lock() {
            "index-lock"
        } else {
            "other"
        });
        logging::error(
            "Staging degraded: changes are recorded and were not staged in git",
            json!({
                "root": self.root.display().to_string(),
                "paths": paths,
                "error": failure.detail(),
            }),
        );
    }

    /// Tell git, for an operation that is waiting on it. Answers the refusal
    /// when git cannot stage here at all; any other failure is a degradation.
    async fn tell(&self, args: &[OsString]) -> Result<(), StagingError> {
        let Err(failure) = self.git(args).await else {
            return Ok(());
        };
        self.degraded(&failure, 1);
        match failure.cannot_stage() {
            Some(why) => Err(self.refusal(why)),
            None => Ok(()),
        }
    }

    async fn unstage(&self, path: &Path) -> Result<(), StagingError> {
        self.tell(&args(
            ["rm", "--cached", "--quiet", "--ignore-unmatch", "--"],
            &[path],
        ))
        .await
    }

    /// Debounce, but never past the staleness ceiling measured from the
    /// OLDEST pending path.
    fn arm(self: &Arc<Self>, pending: &mut Pending) {
        if pending.disposed || pending.queued.is_empty() {
            pending.deadline = None;
            return;
        }
        let now = Instant::now();
        let since_oldest = pending.oldest_at.map_or(Duration::ZERO, |at| now - at);
        let wait = self
            .bounds
            .flush
            .min(self.bounds.max_wait.saturating_sub(since_oldest));
        pending.deadline = Some(now + wait);
        if pending.timer_running {
            return;
        }
        // Outside a runtime nothing can wait; the paths stay queued for a flush.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            pending.timer_running = true;
            runtime.spawn(Arc::clone(self).timer());
        }
    }

    /// Sleeps to the deadline, which a later change may have moved, then drains.
    /// Boxed: it drains, and a drain may arm the next timer.
    fn timer(self: Arc<Self>) -> Done<'static, ()> {
        Box::pin(async move {
            self.wait_until_due_then_drain().await;
        })
    }

    async fn wait_until_due_then_drain(self: Arc<Self>) {
        loop {
            let due = {
                let mut pending = self.pending();
                match pending.deadline {
                    Some(deadline) if deadline > Instant::now() => deadline,
                    Some(_) => {
                        pending.timer_running = false;
                        break;
                    }
                    None => {
                        pending.timer_running = false;
                        return;
                    }
                }
            };
            tokio::time::sleep_until(due).await;
        }
        let _index = self.index.lock().await;
        self.drain().await;
    }

    /// Stage everything pending in one `git add`. The caller holds `index`.
    /// Never fails: staging is not in the critical path, so a failure is
    /// DEGRADED, not down.
    async fn drain(self: &Arc<Self>) {
        let batch = {
            let mut pending = self.pending();
            pending.deadline = None;
            pending.oldest_at = None;
            std::mem::take(&mut pending.queued)
        };
        if batch.is_empty() {
            return;
        }
        let paths: Vec<&Path> = batch.iter().map(PathBuf::as_path).collect();
        let Err(failure) = self.git(&args(["add"], &paths)).await else {
            return;
        };
        // The queue was emptied before the command ran, so a dropped batch is
        // missing from the index for good. Queue it again, but ONLY for a
        // lock race that outlived the retries: a permanent failure would
        // re-arm forever, one subprocess per cycle.
        let count = batch.len();
        if failure.is_index_lock() {
            let mut pending = self.pending();
            pending.queued.extend(batch);
            pending.oldest_at.get_or_insert_with(Instant::now);
            self.arm(&mut pending);
        }
        self.degraded(&failure, count);
    }
}

fn subcommand(args: &[OsString]) -> String {
    args.first()
        .map_or(OsStr::new("git"), OsString::as_os_str)
        .to_string_lossy()
        .into_owned()
}

impl Staging for GitStaging {
    /// Ask git whether it can work here. Any failure refuses.
    fn ready(&self) -> Done<'_, Result<(), StagingError>> {
        Box::pin(async move {
            let inner = &self.inner;
            match inner
                .git(&args(["rev-parse", "--is-inside-work-tree"], &[]))
                .await
            {
                Ok(()) => Ok(()),
                Err(failure) => Err(inner.refusal(
                    failure
                        .cannot_stage()
                        .map_or_else(|| failure.detail(), str::to_string)
                        .as_str(),
                )),
            }
        })
    }

    fn stage(&self, path: &Path) {
        let mut pending = self.inner.pending();
        if pending.disposed {
            return;
        }
        if pending.queued.is_empty() {
            pending.oldest_at = Some(Instant::now());
        }
        pending.queued.insert(path.to_path_buf());
        self.inner.arm(&mut pending);
    }

    /// Pending adds go first: the move must not overtake the add of the file it moves.
    fn relocate(&self, from: &Path, to: &Path) -> Done<'_, Result<(), StagingError>> {
        let (from, to) = (from.to_path_buf(), to.to_path_buf());
        Box::pin(async move {
            let inner = &self.inner;
            let _index = inner.index.lock().await;
            inner.drain().await;
            rename(&inner.root, &from, &to).await?;
            inner.unstage(&from).await?;
            inner.tell(&args(["add", "--"], &[to.as_path()])).await
        })
    }

    fn remove(&self, path: &Path, keep_file: bool) -> Done<'_, Result<(), StagingError>> {
        let path = path.to_path_buf();
        Box::pin(async move {
            let inner = &self.inner;
            let _index = inner.index.lock().await;
            inner.drain().await;
            if !keep_file {
                unlink(&inner.root, &path).await?;
            }
            inner.unstage(&path).await
        })
    }

    /// Read when asked, never kept: a `git checkout` restarts nothing.
    fn current_branch(&self) -> Done<'_, Result<Option<String>, StagingError>> {
        Box::pin(async move {
            let inner = &self.inner;
            let started = std::time::Instant::now();
            let answer = inner
                .run(&args(["rev-parse", "--abbrev-ref", "HEAD"], &[]))
                .await;
            record_command("rev-parse", started);
            match answer {
                Ok(stdout) => {
                    let branch = String::from_utf8_lossy(&stdout).trim().to_string();
                    Ok((!branch.is_empty()).then_some(branch))
                }
                // A checkout with no commit yet has no branch to name: that
                // is none, not a refusal.
                Err(failure) => match failure.cannot_stage() {
                    Some(why) => Err(inner.refusal(why)),
                    None => Ok(None),
                },
            }
        })
    }

    fn flush(&self) -> Done<'_, ()> {
        Box::pin(async move {
            let _index = self.inner.index.lock().await;
            self.inner.drain().await;
        })
    }

    fn dispose(&self) -> Done<'_, ()> {
        Box::pin(async move {
            let _index = self.inner.index.lock().await;
            self.inner.drain().await;
            let mut pending = self.inner.pending();
            pending.disposed = true;
            pending.deadline = None;
        })
    }
}
