//! A knowledge base that does not sync git still moves and removes its own
//! files, and runs no program at all.

use crate::{Done, Staging, StagingError, rename, unlink};
use std::path::{Path, PathBuf};

pub(crate) struct NoStaging {
    root: PathBuf,
}

impl NoStaging {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }
}

impl Staging for NoStaging {
    fn ready(&self) -> Done<'_, Result<(), StagingError>> {
        Box::pin(async { Ok(()) })
    }

    fn stage(&self, _path: &Path) {}

    fn relocate(&self, from: &Path, to: &Path) -> Done<'_, Result<(), StagingError>> {
        let (from, to) = (from.to_path_buf(), to.to_path_buf());
        Box::pin(async move { rename(&self.root, &from, &to).await })
    }

    fn remove(&self, path: &Path, keep_file: bool) -> Done<'_, Result<(), StagingError>> {
        let path = path.to_path_buf();
        Box::pin(async move {
            if keep_file {
                return Ok(());
            }
            unlink(&self.root, &path).await
        })
    }

    fn current_branch(&self) -> Done<'_, Result<Option<String>, StagingError>> {
        Box::pin(async { Ok(None) })
    }

    fn flush(&self) -> Done<'_, ()> {
        Box::pin(async {})
    }

    fn dispose(&self) -> Done<'_, ()> {
        Box::pin(async {})
    }
}
