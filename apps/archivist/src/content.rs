//! The working tree: a resource's content is a file in it, named by a
//! storage URI, `file://` and the file's path from the root.

use ring::digest::{Context, SHA256};
use semiont_archivist_staging::Staging;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncReadExt;

pub struct Content {
    root: PathBuf,
    staging: Arc<dyn Staging>,
}

/// What is at a storage URI: its checksum and its size.
pub struct Held {
    pub checksum: String,
    pub byte_size: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The SHA-256 of `bytes`, in lowercase hex.
pub fn checksum(bytes: &[u8]) -> String {
    let mut context = Context::new(&SHA256);
    context.update(bytes);
    hex(context.finish().as_ref())
}

impl Content {
    pub fn new(root: &Path, staging: Arc<dyn Staging>) -> Content {
        Content {
            root: root.to_owned(),
            staging,
        }
    }

    /// The file a storage URI names. A URI that is not `file://`, or that
    /// names a place outside the working tree, names none.
    pub fn resolve(&self, uri: &str) -> Result<PathBuf, String> {
        let Some(path) = uri.strip_prefix("file://") else {
            return Err(format!(
                "Invalid storage URI (must start with file://): {uri}"
            ));
        };
        let relative = Path::new(path.trim_start_matches('/'));
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(format!(
                "Invalid storage URI (must name a file inside the working tree): {uri}"
            ));
        }
        Ok(self.root.join(relative))
    }

    /// The storage URI of a file of the working tree.
    pub fn uri_of(&self, path: &Path) -> Option<String> {
        let relative = path.strip_prefix(&self.root).ok()?;
        Some(format!("file://{}", relative.to_string_lossy()))
    }

    /// Put `bytes` at `uri`: to a file beside the target, renamed onto it.
    pub async fn store(&self, uri: &str, bytes: &[u8]) -> Result<Held, String> {
        let target = self.resolve(uri)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        let mut beside = target.clone().into_os_string();
        beside.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let beside = PathBuf::from(beside);
        if let Err(error) = tokio::fs::write(&beside, bytes).await {
            let _ = tokio::fs::remove_file(&beside).await;
            return Err(format!("cannot write {uri}: {error}"));
        }
        if let Err(error) = tokio::fs::rename(&beside, &target).await {
            let _ = tokio::fs::remove_file(&beside).await;
            return Err(format!("cannot write {uri}: {error}"));
        }
        Ok(Held {
            checksum: checksum(bytes),
            byte_size: bytes.len() as u64,
        })
    }

    /// What is at `uri`, read through.
    async fn held(&self, uri: &str) -> Result<Held, String> {
        let path = self.resolve(uri)?;
        let mut file = tokio::fs::File::open(&path)
            .await
            .map_err(|e| format!("cannot read {uri}: {e}"))?;
        let mut context = Context::new(&SHA256);
        let mut byte_size = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .await
                .map_err(|e| format!("cannot read {uri}: {e}"))?;
            if read == 0 {
                break;
            }
            context.update(&buffer[..read]);
            byte_size += read as u64;
        }
        Ok(Held {
            checksum: hex(context.finish().as_ref()),
            byte_size,
        })
    }

    /// Take the file already at `uri` into the record: it must be the
    /// checksum expected, and is then staged.
    pub async fn register(&self, uri: &str, expected: Option<&str>) -> Result<Held, String> {
        let held = self.held(uri).await?;
        if let Some(expected) = expected
            && expected != held.checksum
        {
            let head = |checksum: &str| checksum.chars().take(8).collect::<String>();
            return Err(format!(
                "Checksum mismatch for {uri}: expected {}... but got {}...\nThe file on disk differs from the recorded checksum. Has it been modified since staging?",
                head(expected),
                head(&held.checksum)
            ));
        }
        self.staging.stage(&self.resolve(uri)?);
        Ok(held)
    }

    pub async fn exists(&self, uri: &str) -> Result<bool, String> {
        Ok(tokio::fs::try_exists(self.resolve(uri)?)
            .await
            .unwrap_or(false))
    }

    /// Unstage the file at `uri`, and delete it unless told to keep it.
    pub async fn remove(&self, uri: &str, keep_file: bool) -> Result<(), String> {
        self.staging
            .remove(&self.resolve(uri)?, keep_file)
            .await
            .map_err(|e| e.to_string())
    }
}
