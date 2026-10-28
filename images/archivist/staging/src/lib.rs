//! Staging: recording the working tree's changes where a person can commit
//! them (docs/protocol/ARCHIVIST.md § Staging). The trait names the job;
//! `git` is the one technology behind it, and `none` is a knowledge base that
//! does not sync git.
//!
//! One driver per repository: git's index is single-writer and a driver
//! serializes only its own commands, so every store that stages into a
//! repository shares the one `Arc` `staging_for` returned for it.

#![forbid(unsafe_code)]

mod git;
mod none;

use std::fmt;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub type Done<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How far staging may run behind the working tree.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    /// The quiet period after the last change before staging.
    pub flush: Duration,
    /// The ceiling, measured from the oldest pending path: without it a
    /// continuous stream of changes defers staging forever.
    pub max_wait: Duration,
}

/// A staging failure a caller is told of.
#[derive(Debug)]
pub struct StagingError(pub String);

impl fmt::Display for StagingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StagingError {}

pub trait Staging: Send + Sync {
    /// Fails where this driver cannot do its job. A process awaits it before it serves.
    fn ready(&self) -> Done<'_, Result<(), StagingError>>;
    /// The path's current state will be staged within the staleness bound. Returns at once:
    /// the staging is queued, so a failure is logged as a degradation, never returned.
    fn stage(&self, path: &Path);
    /// Rename the file; what is staged follows it. Runs after everything staged before it.
    fn relocate(&self, from: &Path, to: &Path) -> Done<'_, Result<(), StagingError>>;
    /// Unstage the path, and delete the file unless `keep_file`. An absent file is not an error.
    fn remove(&self, path: &Path, keep_file: bool) -> Done<'_, Result<(), StagingError>>;
    /// The branch the tree is on, or none.
    fn current_branch(&self) -> Done<'_, Result<Option<String>, StagingError>>;
    /// Everything staged so far is where a person can commit it.
    fn flush(&self) -> Done<'_, ()>;
    /// Drain and stop.
    fn dispose(&self) -> Done<'_, ()>;
}

/// The driver for a knowledge base's repository: git when it syncs git, none otherwise.
pub fn staging_for(root: &Path, git_sync: bool, bounds: Bounds) -> Arc<dyn Staging> {
    if git_sync {
        Arc::new(git::GitStaging::new(root, bounds))
    } else {
        Arc::new(none::NoStaging::new(root))
    }
}

/// The path as the file system sees it: relative paths are the root's.
fn resolve(root: &Path, path: &Path) -> std::path::PathBuf {
    root.join(path)
}

async fn rename(root: &Path, from: &Path, to: &Path) -> Result<(), StagingError> {
    let (from, to) = (resolve(root, from), resolve(root, to));
    tokio::fs::rename(&from, &to).await.map_err(|error| {
        StagingError(format!(
            "rename {} -> {}: {error}",
            from.display(),
            to.display()
        ))
    })
}

/// An absent file is already unlinked.
async fn unlink(root: &Path, path: &Path) -> Result<(), StagingError> {
    let path = resolve(root, path);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(StagingError(format!("unlink {}: {error}", path.display()))),
    }
}
