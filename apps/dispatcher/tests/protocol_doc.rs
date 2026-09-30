//! docs/protocol/JOBS.md describes every channel the dispatcher answers or
//! emits. The document is what another implementation of the dispatcher is
//! written from, so a channel the code grows and the document does not is
//! behaviour the next implementation will not have.
//!
//! The channels are read from the dispatcher's own source: every `job:`
//! channel named in a string literal of its three crates.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn rust_files(dir: &Path, into: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let path = entry.expect("a directory entry").path();
        if path.is_dir() {
            rust_files(&path, into);
        } else if path.extension().is_some_and(|e| e == "rs") {
            into.push(path);
        }
    }
}

/// Every `"job:<name>"` literal in `source`.
fn channels(source: &str, into: &mut BTreeSet<String>) {
    for (at, _) in source.match_indices("\"job:") {
        let name: String = source[at + 1..]
            .chars()
            .take_while(|c| c.is_ascii_lowercase() || *c == ':' || *c == '-')
            .collect();
        if source[at + 1 + name.len()..].starts_with('"') {
            into.insert(name);
        }
    }
}

#[test]
fn the_job_protocol_document_names_every_channel_the_dispatcher_answers_or_emits() {
    let mut files = Vec::new();
    for crate_dir in ["src", "handlers/src", "jetstream/src"] {
        rust_files(&root().join(crate_dir), &mut files);
    }
    let mut named = BTreeSet::new();
    for file in &files {
        channels(
            &std::fs::read_to_string(file).expect("a source file"),
            &mut named,
        );
    }
    assert!(
        named.len() > 9,
        "found only {named:?} in the dispatcher's source: the census reads nothing"
    );

    let doc = std::fs::read_to_string(root().join("../../docs/protocol/JOBS.md"))
        .expect("docs/protocol/JOBS.md");
    let undocumented: Vec<&String> = named
        .iter()
        .filter(|c| !doc.contains(&format!("`{c}`")))
        .collect();
    assert!(
        undocumented.is_empty(),
        "docs/protocol/JOBS.md does not name {undocumented:?}"
    );
}
