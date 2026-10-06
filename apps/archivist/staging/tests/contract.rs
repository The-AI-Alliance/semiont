//! What `Staging` promises, held against both drivers, and what the git
//! driver promises beyond it.
//!
//! One suite, both drivers: what a store may rely on is what both keep. The
//! file operation is the store's critical path — it happens or it fails,
//! whatever version control thinks of the file — and only the staging is
//! best-effort.

use semiont_archivist_staging::{Bounds, Staging, staging_for};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const QUICK: Bounds = Bounds {
    flush: Duration::from_millis(20),
    max_wait: Duration::from_millis(100),
};

const NEVER_ON_ITS_OWN: Bounds = Bounds {
    flush: Duration::from_secs(600),
    max_wait: Duration::from_secs(600),
};

fn bounds(flush: u64, max_wait: u64) -> Bounds {
    Bounds {
        flush: Duration::from_millis(flush),
        max_wait: Duration::from_millis(max_wait),
    }
}

/// A temporary directory, removed when the test ends.
struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "semiont-staging-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("create the temporary tree");
        // The path git itself reports, so messages can be compared.
        let root = root
            .canonicalize()
            .expect("canonicalize the temporary tree");
        Self { root }
    }

    fn checkout() -> Self {
        let tree = Self::new();
        tree.git(&["init", "--quiet"]);
        tree
    }

    fn at(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    fn write(&self, name: &str, body: &str) -> PathBuf {
        let path = self.at(name);
        std::fs::write(&path, body).expect("write a file");
        path
    }

    fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.at(name)).expect("read a file")
    }

    fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@test.invalid"])
            .args(args)
            .current_dir(&self.root)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// The paths in the index, sorted.
    fn index(&self) -> Vec<String> {
        let mut paths: Vec<String> = self
            .git(&["ls-files", "--cached"])
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect();
        paths.sort();
        paths
    }

    fn drop_checkout(&self) {
        std::fs::remove_dir_all(self.at(".git")).expect("remove .git");
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A tree and the driver under test over it.
struct Case {
    tree: Tree,
    staging: Arc<dyn Staging>,
    /// Whether what this driver stages reaches a git index.
    indexed: bool,
}

impl Case {
    fn open(indexed: bool) -> Self {
        let tree = if indexed {
            Tree::checkout()
        } else {
            Tree::new()
        };
        let staging = staging_for(&tree.root, indexed, QUICK);
        Self {
            tree,
            staging,
            indexed,
        }
    }

    fn expect_index(&self, paths: &[&str]) {
        if self.indexed {
            assert_eq!(self.tree.index(), paths);
        }
    }
}

fn exists(path: &Path) -> bool {
    path.exists()
}

// ── The contract ─────────────────────────────────────────────────────────

async fn is_ready(case: Case) {
    case.staging.ready().await.expect("ready");
}

async fn a_flush_leaves_a_staged_path_where_a_person_can_commit_it(case: Case) {
    case.staging.stage(&case.tree.write("a.txt", "x"));
    case.staging.flush().await;

    case.expect_index(&["a.txt"]);
    assert_eq!(case.tree.read("a.txt"), "x");
}

async fn relocate_renames_the_file_and_the_index_follows(case: Case) {
    case.staging.stage(&case.tree.write("from.txt", "moved"));

    case.staging
        .relocate(&case.tree.at("from.txt"), &case.tree.at("to.txt"))
        .await
        .expect("relocate");

    assert!(!exists(&case.tree.at("from.txt")));
    assert_eq!(case.tree.read("to.txt"), "moved");
    case.expect_index(&["to.txt"]);
}

async fn remove_takes_the_file_off_disk_and_out_of_the_index(case: Case) {
    case.staging.stage(&case.tree.write("gone.txt", "x"));

    case.staging
        .remove(&case.tree.at("gone.txt"), false)
        .await
        .expect("remove");

    assert!(!exists(&case.tree.at("gone.txt")));
    case.expect_index(&[]);
}

async fn remove_keeping_the_file_leaves_it_on_disk_out_of_the_index(case: Case) {
    case.staging
        .stage(&case.tree.write("kept.txt", "still here"));

    case.staging
        .remove(&case.tree.at("kept.txt"), true)
        .await
        .expect("remove");

    assert_eq!(case.tree.read("kept.txt"), "still here");
    case.expect_index(&[]);
}

// `git rm` refuses a file that is staged and not yet committed.
async fn remove_deletes_a_file_no_one_has_committed(case: Case) {
    case.staging.stage(&case.tree.write("uncommitted.txt", "x"));
    case.staging.flush().await;
    case.expect_index(&["uncommitted.txt"]);

    case.staging
        .remove(&case.tree.at("uncommitted.txt"), false)
        .await
        .expect("remove");

    assert!(!exists(&case.tree.at("uncommitted.txt")));
    case.expect_index(&[]);
}

// `git mv` refuses an untracked file.
async fn relocate_and_remove_work_on_a_file_never_staged(case: Case) {
    case.tree.write("unstaged.txt", "never staged");

    case.staging
        .relocate(
            &case.tree.at("unstaged.txt"),
            &case.tree.at("unstaged-moved.txt"),
        )
        .await
        .expect("relocate");
    assert!(!exists(&case.tree.at("unstaged.txt")));
    assert_eq!(case.tree.read("unstaged-moved.txt"), "never staged");

    case.staging
        .remove(&case.tree.at("unstaged-moved.txt"), false)
        .await
        .expect("remove");
    assert!(!exists(&case.tree.at("unstaged-moved.txt")));
}

async fn relocate_of_a_file_that_is_not_there_fails(case: Case) {
    let refused = case
        .staging
        .relocate(&case.tree.at("missing.txt"), &case.tree.at("anywhere.txt"))
        .await;

    assert!(refused.is_err(), "the rename is not best-effort");
    assert!(!exists(&case.tree.at("anywhere.txt")));
}

async fn a_failed_relocate_leaves_the_driver_usable(case: Case) {
    let _ = case
        .staging
        .relocate(&case.tree.at("missing.txt"), &case.tree.at("anywhere.txt"))
        .await;

    case.staging.stage(&case.tree.write("after.txt", "x"));
    case.staging.flush().await;
    case.expect_index(&["after.txt"]);
}

async fn removing_a_file_already_absent_is_not_an_error(case: Case) {
    case.staging
        .remove(&case.tree.at("never-was.txt"), false)
        .await
        .expect("remove");
}

async fn flush_and_dispose_finish_with_nothing_pending(case: Case) {
    case.staging.flush().await;
    case.staging.dispose().await;
}

async fn dispose_drains_what_was_staged(case: Case) {
    case.staging.stage(&case.tree.write("last.txt", "x"));

    case.staging.dispose().await;

    case.expect_index(&["last.txt"]);
}

async fn staging_happens_on_its_own_within_the_bound(case: Case) {
    case.staging.stage(&case.tree.write("timed.txt", "x"));

    tokio::time::sleep(Duration::from_millis(400)).await;

    case.expect_index(&["timed.txt"]);
    case.staging.flush().await;
}

async fn paths_relative_to_the_root_are_the_roots(case: Case) {
    case.tree.write("near.txt", "here");
    case.staging.stage(Path::new("near.txt"));

    case.staging
        .relocate(Path::new("near.txt"), Path::new("far.txt"))
        .await
        .expect("relocate");
    assert_eq!(case.tree.read("far.txt"), "here");
    case.expect_index(&["far.txt"]);

    case.staging
        .remove(Path::new("far.txt"), false)
        .await
        .expect("remove");
    assert!(!exists(&case.tree.at("far.txt")));
    case.expect_index(&[]);
}

macro_rules! contract {
    ($($test:ident),* $(,)?) => {
        mod git_staging {
            $(#[tokio::test(flavor = "multi_thread")]
            async fn $test() {
                super::$test(super::Case::open(true)).await;
            })*
        }
        mod no_staging {
            $(#[tokio::test(flavor = "multi_thread")]
            async fn $test() {
                super::$test(super::Case::open(false)).await;
            })*
        }
    };
}

contract!(
    is_ready,
    a_flush_leaves_a_staged_path_where_a_person_can_commit_it,
    relocate_renames_the_file_and_the_index_follows,
    remove_takes_the_file_off_disk_and_out_of_the_index,
    remove_keeping_the_file_leaves_it_on_disk_out_of_the_index,
    remove_deletes_a_file_no_one_has_committed,
    relocate_and_remove_work_on_a_file_never_staged,
    relocate_of_a_file_that_is_not_there_fails,
    a_failed_relocate_leaves_the_driver_usable,
    removing_a_file_already_absent_is_not_an_error,
    flush_and_dispose_finish_with_nothing_pending,
    dispose_drains_what_was_staged,
    staging_happens_on_its_own_within_the_bound,
    paths_relative_to_the_root_are_the_roots,
);

// ── A knowledge base that does not sync git ──────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn no_staging_never_touches_version_control() {
    let case = Case::open(false);
    case.staging.stage(&case.tree.write("a.txt", "x"));
    case.staging
        .relocate(&case.tree.at("a.txt"), &case.tree.at("b.txt"))
        .await
        .expect("relocate");
    case.staging
        .remove(&case.tree.at("b.txt"), false)
        .await
        .expect("remove");
    case.staging.flush().await;

    assert!(!exists(&case.tree.at(".git")));
}

#[tokio::test(flavor = "multi_thread")]
async fn no_staging_reports_no_branch_even_in_a_checkout() {
    let tree = Tree::checkout();
    tree.git(&["commit", "--quiet", "--allow-empty", "-m", "init"]);
    tree.git(&["checkout", "--quiet", "-b", "feature-xyz"]);

    let none = staging_for(&tree.root, false, QUICK);
    let git = staging_for(&tree.root, true, QUICK);

    assert_eq!(none.current_branch().await.expect("branch"), None);
    assert_eq!(
        git.current_branch().await.expect("branch").as_deref(),
        Some("feature-xyz")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn no_staging_leaves_a_checkouts_index_alone() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, false, QUICK);

    staging.stage(&tree.write("a.txt", "x"));
    staging.flush().await;
    staging.dispose().await;

    assert!(tree.index().is_empty());
}

// ── The current branch ───────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn current_branch_names_the_branch_read_at_every_ask() {
    let case = Case::open(true);
    case.tree
        .git(&["commit", "--quiet", "--allow-empty", "-m", "init"]);
    case.tree.git(&["checkout", "--quiet", "-b", "first-line"]);
    assert_eq!(
        case.staging
            .current_branch()
            .await
            .expect("branch")
            .as_deref(),
        Some("first-line")
    );

    case.tree.git(&["checkout", "--quiet", "-b", "second-line"]);
    assert_eq!(
        case.staging
            .current_branch()
            .await
            .expect("branch")
            .as_deref(),
        Some("second-line")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn current_branch_is_none_in_a_checkout_with_no_commit() {
    let case = Case::open(true);
    assert_eq!(case.staging.current_branch().await.expect("branch"), None);
}

// ── The queue: deferred, deduped, bounded ────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn stage_returns_before_git_has_run() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, NEVER_ON_ITS_OWN);
    staging.stage(&tree.write("a.txt", "x"));

    assert!(tree.index().is_empty());

    staging.flush().await;
    assert_eq!(tree.index(), ["a.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn many_changes_to_one_path_stage_it_once() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, bounds(50, 500));
    tree.write("events.jsonl", "x");
    for _ in 0..1400 {
        staging.stage(Path::new("events.jsonl"));
    }

    staging.flush().await;
    assert_eq!(tree.index(), ["events.jsonl"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn distinct_paths_are_staged_together() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, bounds(50, 500));
    for name in ["a.txt", "b.txt", "c.txt"] {
        staging.stage(&tree.write(name, "x"));
    }

    staging.flush().await;
    assert_eq!(tree.index(), ["a.txt", "b.txt", "c.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_continuous_stream_cannot_defer_staging_forever() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, bounds(60_000, 150));
    staging.stage(&tree.write("first.txt", "x"));
    for n in 0..6 {
        tokio::time::sleep(Duration::from_millis(40)).await;
        staging.stage(&tree.write(&format!("n{n}.txt"), "x"));
    }

    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(tree.index().contains(&"first.txt".to_string()));
    staging.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relocate_does_not_overtake_the_add_of_the_file_it_moves() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, NEVER_ON_ITS_OWN);
    staging.stage(&tree.write("from.txt", "x"));

    staging
        .relocate(Path::new("from.txt"), Path::new("to.txt"))
        .await
        .expect("relocate");

    assert_eq!(tree.index(), ["to.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn dispose_leaves_nothing_unstaged_whatever_the_bounds() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, NEVER_ON_ITS_OWN);
    staging.stage(&tree.write("last.txt", "x"));

    staging.dispose().await;
    assert_eq!(tree.index(), ["last.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stage_after_dispose_is_ignored() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, QUICK);
    staging.dispose().await;

    staging.stage(&tree.write("late.txt", "x"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    staging.flush().await;

    assert!(tree.index().is_empty());
}

// ── A held index lock ────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_command_that_finds_the_index_locked_is_tried_again() {
    let tree = Tree::checkout();
    let lock = tree.at(".git/index.lock");
    std::fs::write(&lock, "").expect("hold the lock");
    let staging = staging_for(&tree.root, true, bounds(10, 20));
    staging.stage(&tree.write("survivor.txt", "x"));

    // Whoever held the lock finishes while the command is waiting it out.
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(tree.index().is_empty());
    std::fs::remove_file(&lock).expect("release the lock");

    staging.flush().await;
    assert_eq!(tree.index(), ["survivor.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_batch_that_outlived_the_retries_is_queued_again() {
    let tree = Tree::checkout();
    let lock = tree.at(".git/index.lock");
    std::fs::write(&lock, "").expect("hold the lock");
    let staging = staging_for(&tree.root, true, NEVER_ON_ITS_OWN);
    staging.stage(&tree.write("survivor.txt", "x"));

    // The whole retry schedule runs against the held lock, and the flush
    // still finishes: a failure to stage reaches no caller.
    staging.flush().await;
    assert!(tree.index().is_empty());
    std::fs::remove_file(&lock).expect("release the lock");

    staging.flush().await;
    assert_eq!(tree.index(), ["survivor.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_permanent_failure_degrades_and_is_not_queued_again() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, bounds(5, 20));
    // The pathspec matches nothing: git fails, always.
    staging.stage(Path::new("never-existed.txt"));
    staging.flush().await;

    // Were the batch queued again, this flush would fail the good path with it.
    staging.stage(&tree.write("good.txt", "x"));
    staging.flush().await;
    assert_eq!(tree.index(), ["good.txt"]);
    staging.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relocate_git_refuses_for_another_reason_still_succeeds() {
    let tree = Tree::checkout();
    let lock = tree.at(".git/index.lock");
    let staging = staging_for(&tree.root, true, NEVER_ON_ITS_OWN);
    tree.write("a.txt", "kept");
    std::fs::write(&lock, "").expect("hold the lock");

    staging
        .relocate(&tree.at("a.txt"), &tree.at("b.txt"))
        .await
        .expect("the file moved; the index being behind is a degradation");

    assert_eq!(tree.read("b.txt"), "kept");
    std::fs::remove_file(&lock).expect("release the lock");
    assert!(tree.index().is_empty());
}

// ── A tree git cannot stage into ─────────────────────────────────────────

fn assert_refusal(message: &str, root: &Path, why: &str) {
    assert_eq!(
        message,
        format!(
            "The knowledge base's config says [git] sync = true, and {} is not a git checkout ({why}). \
             Make it one (git init), or set sync = false.",
            root.display()
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn will_not_start_over_a_tree_that_is_not_a_checkout() {
    let tree = Tree::new();
    let staging = staging_for(&tree.root, true, QUICK);

    let refusal = staging.ready().await.expect_err("ready refuses");

    assert_refusal(&refusal.0, &tree.root, "git finds no repository there");
    assert_eq!(refusal.to_string(), refusal.0);
}

#[tokio::test(flavor = "multi_thread")]
async fn will_not_start_where_git_cannot_be_run() {
    let tree = Tree::new();
    // No program starts in a working directory that does not exist.
    let root = tree.at("absent");
    let staging = staging_for(&root, true, QUICK);

    let refusal = staging.ready().await.expect_err("ready refuses");

    assert_refusal(&refusal.0, &root, "git could not be run");
}

// While running, the driver does not go looking for trouble: a check before
// each operation would cost a subprocess.
#[tokio::test(flavor = "multi_thread")]
async fn a_tree_that_stops_being_a_checkout_a_move_and_a_remove_do_their_work_and_fail() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, QUICK);
    staging.ready().await.expect("ready");
    tree.write("a.txt", "kept");
    tree.drop_checkout();
    let why = "git finds no repository there";

    let moved = staging
        .relocate(&tree.at("a.txt"), &tree.at("b.txt"))
        .await
        .expect_err("relocate reports the refusal");
    assert_refusal(&moved.0, &tree.root, why);
    assert_eq!(tree.read("b.txt"), "kept");

    let branch = staging
        .current_branch()
        .await
        .expect_err("current_branch reports the refusal");
    assert_refusal(&branch.0, &tree.root, why);

    let removed = staging
        .remove(&tree.at("b.txt"), false)
        .await
        .expect_err("remove reports the refusal");
    assert_refusal(&removed.0, &tree.root, why);
    assert!(!exists(&tree.at("b.txt")));

    staging.flush().await;
    staging.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queued_stage_that_cannot_be_staged_reaches_no_caller() {
    let tree = Tree::checkout();
    let staging = staging_for(&tree.root, true, QUICK);
    staging.ready().await.expect("ready");
    tree.drop_checkout();

    staging.stage(&tree.write("a.txt", "x"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    staging.flush().await;

    assert_eq!(tree.read("a.txt"), "x");
}

#[tokio::test(flavor = "multi_thread")]
async fn stages_again_once_the_checkout_is_back() {
    let tree = Tree::new();
    let staging = staging_for(&tree.root, true, QUICK);
    assert!(staging.ready().await.is_err());

    tree.git(&["init", "--quiet"]);
    staging.stage(&tree.write("a.txt", "x"));
    staging.flush().await;

    assert_eq!(tree.index(), ["a.txt"]);
}
