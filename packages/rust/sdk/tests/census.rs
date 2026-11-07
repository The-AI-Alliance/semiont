//! The gates on the crate's state units, read off its own source.
//!
//! - **The census.** Every type that is a `StateUnit` has a test that runs
//!   the axioms against it: a subject whose unit it is, handed to
//!   `assert_state_unit_axioms`. A unit added without one fails here.
//! - **X3, statically.** No `static` item, and nothing that makes one: state
//!   outside a unit's instances is state two units share. The axioms' own X3
//!   catches a leak that moves a surface; this catches the ones that do not.
//!   The bus log is the one exception: it is the process's, as the
//!   environment variable that turns it on is.
//! - **The clock.** Every wait and every interval is the runtime's, which a
//!   paused runtime holds still: no `std::time::Instant`, no
//!   `thread::sleep` and no `recv_timeout`, in this crate or the HTTP
//!   transport's (`protocol/specs/src/client/surface.json`, `clock`, reads
//!   the same two, and leaves out what it leaves out: a module's tests kept
//!   in a file of their own, `tests.rs`, which the module declares
//!   `#[cfg(test)] mod tests;`). And every jitter is drawn from the caller's
//!   random source, or the system's when it gives none, in one place: no
//!   random draw outside `src/retry.rs`, and no UUID read as a number
//!   anywhere.

use std::fs;
use std::path::{Path, PathBuf};

fn sources(under: &str) -> Vec<(String, String)> {
    fn walk(directory: &Path, found: &mut Vec<PathBuf>) {
        let entries = fs::read_dir(directory)
            .unwrap_or_else(|error| panic!("cannot list {}: {error}", directory.display()));
        for entry in entries {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                walk(&path, found);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                found.push(path);
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut found = Vec::new();
    walk(&root.join(under), &mut found);
    found.sort();
    found
        .into_iter()
        .map(|path| {
            let name = path
                .strip_prefix(root)
                .expect("under the crate")
                .to_string_lossy()
                .replace('\\', "/");
            let text = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("cannot read {name}: {error}"));
            (name, text)
        })
        .collect()
}

/// The identifier `text` begins with.
fn identifier(text: &str) -> &str {
    let end = text
        .find(|c: char| !(c.is_alphanumeric() || c == '_'))
        .unwrap_or(text.len());
    &text[..end]
}

/// The name that follows each `marker` in `text`.
fn named_after<'a>(text: &'a str, marker: &str) -> Vec<&'a str> {
    text.match_indices(marker)
        .map(|(at, _)| identifier(text[at + marker.len()..].trim_start()))
        .filter(|name| !name.is_empty())
        .collect()
}

/// The types `text` makes state units.
fn state_units(text: &str) -> Vec<&str> {
    text.lines()
        .filter(|line| line.trim_start().starts_with("impl"))
        .flat_map(|line| named_after(line, "StateUnit for "))
        .collect()
}

/// The units whose axioms `text` runs: for each subject it hands to
/// `assert_state_unit_axioms`, the unit that subject is of.
fn units_held_to_the_axioms(text: &str) -> Vec<&str> {
    let handed: Vec<&str> = named_after(text, "assert_state_unit_axioms(&");
    text.match_indices("impl AxiomSubject for ")
        .filter_map(|(at, marker)| {
            let subject = identifier(&text[at + marker.len()..]);
            let body = &text[at..];
            let unit = named_after(
                &body[..body.find("\n}").unwrap_or(body.len())],
                "type Unit = ",
            );
            (handed.contains(&subject))
                .then(|| unit.first().copied())
                .flatten()
        })
        .collect()
}

#[test]
fn the_census_reads_what_it_is_shown() {
    let source = "impl<K, V> StateUnit for Cache<K, V>\nwhere\n{\n}\nimpl StateUnit for Probe {\n}\n// a StateUnit for nothing\n";
    assert_eq!(state_units(source), ["Cache", "Probe"]);

    let tests = "impl AxiomSubject for Caches {\n    type Unit = Cache<String, String>;\n}\nimpl AxiomSubject for Idle {\n    type Unit = Probe;\n}\nfn t() { assert_state_unit_axioms(&Caches { n: 1 }); }\n";
    assert_eq!(units_held_to_the_axioms(tests), ["Cache"]);
}

#[test]
fn every_state_unit_has_a_test_that_runs_the_axioms_against_it() {
    let units: Vec<(String, String)> = sources("src")
        .iter()
        .filter(|(file, _)| !file.starts_with("src/testing/"))
        .flat_map(|(file, text)| {
            state_units(text)
                .into_iter()
                .map(|unit| (unit.to_owned(), file.clone()))
                .collect::<Vec<_>>()
        })
        .collect();
    assert!(
        units.iter().any(|(unit, _)| unit == "Cache"),
        "the census found no cache among the crate's state units: {units:?}"
    );

    // This file shows the census a subject of its own, which holds nothing.
    let tests: Vec<(String, String)> = sources("tests")
        .into_iter()
        .filter(|(file, _)| file != "tests/census.rs")
        .collect();
    let held: Vec<&str> = tests
        .iter()
        .flat_map(|(_, text)| units_held_to_the_axioms(text))
        .collect();
    let unheld: Vec<String> = units
        .iter()
        .filter(|(unit, _)| !held.contains(&unit.as_str()))
        .map(|(unit, file)| format!("{unit} ({file})"))
        .collect();
    assert!(
        unheld.is_empty(),
        "state units with no test that runs assert_state_unit_axioms against them: {unheld:?}"
    );
}

/// The lines of `text` that declare state outside any instance.
fn statics(text: &str) -> Vec<&str> {
    text.lines()
        .map(str::trim_start)
        .filter(|line| {
            let item = line
                .strip_prefix("pub(crate) ")
                .or_else(|| line.strip_prefix("pub "))
                .unwrap_or(line);
            item.starts_with("static ")
                || item.starts_with("thread_local!")
                || item.starts_with("lazy_static!")
        })
        .collect()
}

#[test]
fn the_static_gate_reads_what_it_is_shown() {
    let source = "static COUNT: AtomicUsize = AtomicUsize::new(0);\n    pub(crate) static mut SEEN: u8 = 0;\nthread_local! { static HERE: u8 = 0; }\nconst NAME: &'static str = \"static\";\n// static in a comment\nfn of() -> &'static str { \"\" }\n";
    assert_eq!(
        statics(source),
        [
            "static COUNT: AtomicUsize = AtomicUsize::new(0);",
            "pub(crate) static mut SEEN: u8 = 0;",
            "thread_local! { static HERE: u8 = 0; }",
        ]
    );
}

#[test]
fn nothing_in_the_crate_holds_state_outside_an_instance() {
    let found: Vec<String> = sources("src")
        .iter()
        .filter(|(file, _)| file != "src/bus_log.rs")
        .flat_map(|(file, text)| {
            statics(text)
                .into_iter()
                .map(|line| format!("{file}: {line}"))
                .collect::<Vec<_>>()
        })
        .collect();
    assert!(
        found.is_empty(),
        "state outside any instance (X3): {found:#?}"
    );
}

/// The one file a jitter is drawn in.
const DRAWN_IN: &str = "src/retry.rs";

/// What a random draw is written as: a draw from a random source, or the
/// system's source named.
const DRAWS: [&str; 5] = [
    ".next_u32()",
    ".next_u64()",
    ".fill_bytes(",
    "SysRng",
    "getrandom",
];

/// What `text`, the source of `file`, does that a wait on the runtime's clock
/// and a jitter drawn from the caller's source rule out. Comment lines say
/// nothing.
fn off_the_clock(file: &str, text: &str) -> Vec<&'static str> {
    let code: String = text
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let std_instant = code.contains("std::time::Instant")
        || code.match_indices("std::time::{").any(|(at, _)| {
            let group = &code[at..];
            group[..group.find('}').expect("a use group closes")]
                .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                .any(|word| word == "Instant")
        });
    let mut found = Vec::new();
    if std_instant {
        found
            .push("std::time::Instant, which moves on while a paused runtime's clock stands still");
    }
    if code.contains("thread::sleep") {
        found.push("thread::sleep, a wait no paused runtime holds");
    }
    if code.contains("recv_timeout(") {
        found.push("recv_timeout, a wait no paused runtime holds");
    }
    if code.contains(".as_u128()") || code.contains(".as_u64_pair()") {
        found.push("a UUID read as a number: a random draw from no caller's source");
    }
    if file != DRAWN_IN && DRAWS.iter().any(|draw| code.contains(draw)) {
        found.push("a random draw outside equal_jitter, in src/retry.rs");
    }
    found
}

#[test]
fn the_clock_gate_reads_what_it_is_shown() {
    let off = "use std::time::{\n    Duration,\n    Instant,\n};\nfn wait() { std::thread::sleep(ONE); let _ = ticks.recv_timeout(ONE); }\nfn draw() -> u128 { uuid::Uuid::new_v4().as_u128() + random.next_u64() as u128 }\n";
    assert_eq!(
        off_the_clock("src/stream.rs", off),
        [
            "std::time::Instant, which moves on while a paused runtime's clock stands still",
            "thread::sleep, a wait no paused runtime holds",
            "recv_timeout, a wait no paused runtime holds",
            "a UUID read as a number: a random draw from no caller's source",
            "a random draw outside equal_jitter, in src/retry.rs",
        ]
    );

    let on = "use std::time::{Duration, SystemTime};\nuse tokio::time::Instant;\n// std::time::Instant and thread::sleep, said in a comment\nfn id() -> String { uuid::Uuid::new_v4().to_string() }\n";
    assert_eq!(off_the_clock("src/stream.rs", on), Vec::<&str>::new());
    assert_eq!(
        off_the_clock(
            DRAWN_IN,
            "fn draw() -> u64 { UnwrapErr(SysRng).next_u64() }\n"
        ),
        Vec::<&str>::new()
    );
}

#[test]
fn every_wait_is_on_the_runtimes_clock_and_every_jitter_drawn_from_the_callers_source() {
    let found: Vec<String> = sources("src")
        .into_iter()
        .chain(sources("../http-transport/src"))
        .filter(|(file, _)| !file.ends_with("/tests.rs"))
        .flat_map(|(file, text)| {
            off_the_clock(&file, &text)
                .into_iter()
                .map(|breach| format!("{file}: {breach}"))
                .collect::<Vec<_>>()
        })
        .collect();
    assert!(found.is_empty(), "off the clock: {found:#?}");
}
