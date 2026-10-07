//! Generates the job storage layout from specs/src/jobs/storage.json: the
//! names and subjects every implementation of the job queue uses on the
//! broker, so work queued by one survives a switch to another. Nothing in the
//! driver restates them.

use serde_json::Value;
use std::fmt::Write as _;
use std::path::PathBuf;

fn main() {
    let crate_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let spec = crate_dir.join("../../../specs/src/jobs/storage.json");
    println!("cargo:rerun-if-changed={}", spec.display());
    let layout: Value = serde_json::from_str(
        &std::fs::read_to_string(&spec).unwrap_or_else(|e| panic!("{}: {e}", spec.display())),
    )
    .unwrap_or_else(|e| panic!("{} is not JSON: {e}", spec.display()));
    let text = |pointer: &str| {
        layout
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("storage.json has no {pointer}"))
            .to_owned()
    };
    let mut out = String::from("// Generated from specs/src/jobs/storage.json; do not edit.\n");
    let _ = writeln!(
        out,
        "/// The work-queue stream every job is published into.\npub const JOBS_STREAM: &str = {:?};",
        text("/stream/name")
    );
    let _ = writeln!(
        out,
        "/// The root of every job subject: a job is published on `<root>.<jobType>`.\npub const JOBS_SUBJECT_ROOT: &str = {:?};",
        text("/stream/subjectRoot")
    );
    let _ = writeln!(
        out,
        "/// The durable consumer that holds each job's message as its lease.\npub const JOBS_CONSUMER: &str = {:?};",
        text("/consumer/durableName")
    );
    let _ = writeln!(
        out,
        "/// The key-value bucket holding one record per job, keyed by its id.\npub const JOBS_BUCKET: &str = {:?};",
        text("/bucket/name")
    );
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    std::fs::write(out_dir.join("storage.rs"), out).expect("cannot write storage.rs");
}
