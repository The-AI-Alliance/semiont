//! What a knowledge base says of itself: the committed `.semiont/config` of
//! its working tree.

use std::path::Path;

/// The keys of the committed config the Archivist reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    /// `[project] name`, or the root directory's name.
    pub name: String,
    /// `[site] domain`: the knowledge base's identity.
    pub domain: Option<String>,
    /// `[git] sync`, true only when it is the literal `true`.
    pub git_sync: bool,
}

/// The committed config of the tree at `root`. A file that is absent or does
/// not parse reads as every key absent.
pub fn committed(root: &Path) -> Committed {
    let table = std::fs::read_to_string(root.join(".semiont").join("config"))
        .ok()
        .and_then(|text| text.parse::<toml::Table>().ok())
        .unwrap_or_default();
    let text = |section: &str, key: &str| {
        table
            .get(section)
            .and_then(|s| s.get(key))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    Committed {
        name: text("project", "name").unwrap_or_else(|| {
            root.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        }),
        domain: text("site", "domain"),
        git_sync: table
            .get("git")
            .and_then(|s| s.get("sync"))
            .and_then(|v| v.as_bool())
            == Some(true),
    }
}
