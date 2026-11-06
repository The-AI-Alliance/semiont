"""Run the smoke's up, e2e and down against stand-ins, without starting services."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SOURCE = Path(__file__).with_name("smoke-stack.sh")
DOCUMENTS = {
    "browser": "image: ghcr.io/the-ai-alliance/semiont-browser:previous\nkeep: browser-setting\n",
    "worker": "image: ghcr.io/the-ai-alliance/semiont-worker:previous\nkeep: worker-setting\n",
}
ISSUER = "http://192.0.2.1:8080/realms/example.github.io-stack-smoke"
PROTECTED_RESOURCE = {
    "resource": "https://example.github.io/stack-smoke",
    "authorization_servers": [ISSUER],
    "bearer_methods_supported": ["header"],
}
# Keycloak's shape: the token endpoint again under mtls_endpoint_aliases, after the top-level one.
DISCOVERY = {
    "issuer": ISSUER,
    "token_endpoint": f"{ISSUER}/protocol/openid-connect/token",
    "mtls_endpoint_aliases": {
        "token_endpoint": f"{ISSUER}/protocol/openid-connect/token"
    },
}
# Each init writes a KnowledgeBase document whose gateway has a port of its own,
# as init gives a knowledge base beside another the next port block.
LAUNCHER = """import json
import os
from pathlib import Path
import sys
root = Path(os.environ["SMOKE_TEST_ROOT"])
command = sys.argv[1]
def log(name, entry):
    with (root / name).open("a") as f:
        f.write(json.dumps(entry) + "\\n")
if command == "--version":
    print("smoke-test launcher")
elif command == "init":
    inits = root / "inits.jsonl"
    count = len(inits.read_text().splitlines()) if inits.exists() else 0
    log("inits.jsonl", {"cwd": os.getcwd(), "domain": sys.argv[sys.argv.index("--domain") + 1], "flags": sys.argv[2:]})
    stack = Path.cwd() / ".semiont/stack"
    stack.mkdir(parents=True)
    port = 4000 + 10 * count
    (stack / "knowledge-base.yaml").write_text(
        "kind: KnowledgeBase\\nspec:\\n  gateway:\\n"
        "    image: ghcr.io/the-ai-alliance/semiont-gateway:latest\\n"
        f"    port: {port}\\n    publicURL: http://localhost:{port}\\n"
        "  dispatcher:\\n    image: ghcr.io/the-ai-alliance/semiont-dispatcher:latest\\n"
    )
elif command == "settings":
    print(root / "state home" / f"{sys.argv[2]}.yaml")
elif command == "start":
    starts = root / "starts.jsonl"
    count = len(starts.read_text().splitlines()) if starts.exists() else 0
    snapshot = {name: (root / "state home" / f"{name}.yaml").read_text() for name in ("browser", "worker")}
    snapshot["gateway"] = (Path.cwd() / ".semiont/stack/knowledge-base.yaml").read_text()
    snapshot["cwd"] = os.getcwd()
    log("starts.jsonl", snapshot)
    statuses = os.environ["SMOKE_TEST_START_STATUS"].split(",")
    sys.exit(int(statuses[min(count, len(statuses) - 1)]))
elif command in ("stop", "clean", "forget", "useradd", "status"):
    log("launcher.jsonl", sys.argv[1:])
    if command == "useradd":
        sys.stdin.read()
    # The dispatcher's line of a status report, as the launcher prints it when the
    # collector has a reading of its queue.
    if command == "status" and os.environ["SMOKE_TEST_QUEUE"]:
        print("    queue    " + os.environ["SMOKE_TEST_QUEUE"])
"""
DRAINED = "0 pending · 0 running · 4 completed · 0 failed since worker start"


class SmokeStackTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.kb = self.root / "kb"
        script = self.root / "images/tests/stack/smoke-stack.sh"
        script.parent.mkdir(parents=True)
        shutil.copyfile(SOURCE, script)
        runtime_helper = self.root / "images/scripts/container-runtime.sh"
        runtime_helper.parent.mkdir(parents=True)
        shutil.copyfile(
            SOURCE.parents[2] / "scripts/container-runtime.sh", runtime_helper
        )
        e2e_package = self.root / "images/e2e/package.json"
        e2e_package.parent.mkdir(parents=True)
        shutil.copyfile(SOURCE.parents[2] / "e2e/package.json", e2e_package)
        for directory in (
            "apps/launcher/dist",
            "packages/go/launcher",
            "packages/go/sdk",
            "bin",
            "state home",
        ):
            (self.root / directory).mkdir(parents=True)
        for name, text in DOCUMENTS.items():
            (self.root / "state home" / f"{name}.yaml").write_text(text)
        self.launcher = self.root / "apps/launcher/dist/semiont"
        self.launcher.write_text(f"#!{sys.executable}\n" + LAUNCHER)
        self.launcher.chmod(0o755)
        shutil.copy2(self.launcher, self.root / "built-launcher")
        # The build. `stale` answers what SMOKE_TEST_STALE says is stale. Every other
        # operation writes the launcher where there is none, and, as Go does for a
        # build that changed nothing, leaves one that is there as it was.
        build = self.root / "images/scripts/build-session.sh"
        build.write_text(
            "#!/bin/sh\n"
            'printf "%s\\n" "$*" >> "$SMOKE_TEST_ROOT/builds.log"\n'
            'if [ "$1" = stale ]; then printf "%s" "$SMOKE_TEST_STALE"; exit "$SMOKE_TEST_STALE_STATUS"; fi\n'
            '[ "$SMOKE_TEST_BUILD_STATUS" = 0 ] || exit "$SMOKE_TEST_BUILD_STATUS"\n'
            f'[ -e "{self.launcher}" ] || cp -p "$SMOKE_TEST_ROOT/built-launcher" "{self.launcher}"\n'
        )
        self.use_runtime("smoke-test-runtime", 0)

    def use_runtime(self, runtime: str, e2e_status: int) -> None:
        self.runtime = runtime
        log = self.root / "runtime.log"
        for name, body in {
            # The gateway names an issuer on a host of the runtime's choosing, which
            # answers discovery and the Browser's origin. The URL is curl's last argument.
            "curl": f'for url; do :; done\nprintf "%s\\n" "$url" >> "{self.root / "curl.log"}"\n'
            'case "$url" in\n'
            f"  */.well-known/oauth-protected-resource) printf '%s' '{json.dumps(PROTECTED_RESOURCE)}' ;;\n"
            f"  {ISSUER}/.well-known/openid-configuration) printf '%s' '{json.dumps(DISCOVERY)}' ;;\n"
            f"  {DISCOVERY['token_endpoint']}) printf 'access-control-allow-origin: http://localhost:3000\\n' ;;\n"
            "  *) exit 7 ;;\n"
            "esac",
            "nc": "exit 1",
            # The smoke waits ten seconds between readings of a queue; the test does not. Every
            # other sleep is the real one: the runtime probe's watchdog kills a probe that a
            # sleep returning at once outran.
            "sleep": '[ "$*" = 10 ] && exit 0\nexec /bin/sleep "$@"',
            runtime: f'printf "%s\\n" "$*" >> "{log}"\n'
            # The suite's run: after `sh -c <script>`, the shell's $0 and arguments, one per field.
            'if [ "$1" = run ]; then\n'
            '  while [ $# -gt 0 ] && [ "$1" != -c ]; do shift; done\n'
            "  shift 2\n"
            f'  printf "%s\\t" "$@" >> "{self.root / "suites.log"}"\n'
            f'  printf "\\n" >> "{self.root / "suites.log"}"\n'
            f"  exit {e2e_status}\n"
            "fi\n"
            # Another knowledge base's container, stopped, as a machine keeps one.
            'case "$1" in ps|ls) echo semiont-another-kb-gateway ;; logs) echo "a log line of $*" ;; esac\nexit 0',
        }.items():
            executable = self.root / "bin" / name
            executable.write_text(f"#!/bin/sh\n{body}\n")
            executable.chmod(0o755)

    def smoke(
        self,
        *args: str,
        start_status: str = "0",
        build_status: str = "0",
        stale: str = "",
        stale_status: str = "0",
        queue: str = DRAINED,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(self.root / "images/tests/stack/smoke-stack.sh"), *args],
            check=False,
            env={
                **os.environ,
                "PATH": str(self.root / "bin") + os.pathsep + os.environ["PATH"],
                "SMOKE_TEST_ROOT": str(self.root),
                "SMOKE_TEST_START_STATUS": start_status,
                "SMOKE_TEST_BUILD_STATUS": build_status,
                "SMOKE_TEST_STALE": stale,
                "SMOKE_TEST_STALE_STATUS": stale_status,
                "SMOKE_TEST_QUEUE": queue,
                "CONTAINER_RUNTIME": self.runtime,
                "SMOKE_KB": str(self.kb),
            },
            capture_output=True,
            text=True,
            timeout=60,
        )

    def lines(self, name: str) -> list:
        path = self.root / name
        return (
            [json.loads(line) for line in path.read_text().splitlines()]
            if path.exists()
            else []
        )

    def stopped(self) -> list[str]:
        """The root of each `stop`, resolved: macOS reports a temporary directory's cwd under /private."""
        stops = [call for call in self.lines("launcher.jsonl") if call[0] == "stop"]
        for call in stops:
            self.assertIn(
                "--root", call, "a stop naming no root stops whichever stack it finds"
            )
        return [os.path.realpath(call[call.index("--root") + 1]) for call in stops]

    def asked_status(self) -> list[str]:
        """The root of each `status`, resolved."""
        return [
            os.path.realpath(call[call.index("--root") + 1])
            for call in self.lines("launcher.jsonl")
            if call[0] == "status"
        ]

    def suites(self) -> list[list[str]]:
        """Each run of the suite: its shell's $0 and arguments."""
        path = self.root / "suites.log"
        return (
            [line.rstrip("\t").split("\t") for line in path.read_text().splitlines()]
            if path.exists()
            else []
        )

    def build_calls(self) -> list[str]:
        path = self.root / "builds.log"
        return path.read_text().splitlines() if path.exists() else []

    def builds(self) -> list[str]:
        """What the smoke built, leaving out what it asked."""
        return [call for call in self.build_calls() if not call.startswith("stale")]

    def edit_launcher_source(self) -> None:
        """A launcher source file newer than the launcher."""
        past = time.time() - 100
        os.utime(self.launcher, (past, past))
        (self.root / "packages/go/launcher/start.go").write_text("package launcher\n")

    def assert_documents_restored(self) -> None:
        for name, original in DOCUMENTS.items():
            self.assertEqual(
                (self.root / "state home" / f"{name}.yaml").read_text(), original
            )

    def test_up_names_the_images_and_down_restores_the_documents(self) -> None:
        for tag in ("local", "latest", "0.7.1"):
            with self.subTest(tag=tag):
                result = self.smoke("up", tag)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                for name in DOCUMENTS:
                    self.assertIn(
                        f"image: ghcr.io/the-ai-alliance/semiont-{name}:{tag}\n",
                        (self.root / "state home" / f"{name}.yaml").read_text(),
                    )
                started = self.lines("starts.jsonl")[-1]
                for name in ("browser", "worker", "gateway"):
                    self.assertIn(
                        f"ghcr.io/the-ai-alliance/semiont-{name}:{tag}\n", started[name]
                    )
                    if name != "gateway":
                        self.assertIn(f"keep: {name}-setting\n", started[name])
                result = self.smoke("down")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assert_documents_restored()
                self.assertIn(os.path.realpath(self.kb), self.stopped())
                shutil.rmtree(self.kb)

    def test_up_builds_a_missing_launcher_before_it_starts_anything(self) -> None:
        self.launcher.unlink()
        result = self.smoke("up", "local")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.builds(), ["launcher"])
        self.assertEqual(len(self.lines("starts.jsonl")), 1)

    def test_a_launcher_older_than_its_source_is_built_once(self) -> None:
        self.edit_launcher_source()
        self.assertEqual(self.smoke("up", "local").returncode, 0)
        result = self.smoke("e2e")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.builds(), ["launcher"])

    def test_down_stops_with_the_launcher_that_is_there(self) -> None:
        self.assertEqual(self.smoke("up", "local").returncode, 0)
        self.edit_launcher_source()
        result = self.smoke("down")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.builds(), [])
        self.assert_documents_restored()

    def test_a_launcher_that_does_not_build_starts_nothing(self) -> None:
        self.launcher.unlink()
        result = self.smoke("up", "local", build_status="1")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(self.lines("starts.jsonl"), [])
        self.assertEqual(self.lines("inits.jsonl"), [])

    def test_up_of_local_builds_stale_images_before_it_starts_anything(self) -> None:
        stale = "images/archivist\tDockerfile, copied source, toolchain or npm dependencies changed\n"
        result = self.smoke("up", "local", stale=stale)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            self.build_calls(),
            ["stale --package typescript", "local-build --package typescript"],
        )
        self.assertIn("images/archivist", result.stdout)
        self.assertEqual(len(self.lines("starts.jsonl")), 1)

    def test_up_of_current_local_images_builds_nothing(self) -> None:
        result = self.smoke("up", "local")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.build_calls(), ["stale --package typescript"])
        self.assertIn("nothing to build", result.stdout)
        self.assertIn(
            "semiont init --domain example.github.io:stack-smoke made it", result.stdout
        )

    def test_up_of_a_published_tag_asks_nothing_of_the_build(self) -> None:
        result = self.smoke("up", "0.7.1", stale="images/archivist\tchanged\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.build_calls(), [])

    def test_images_that_do_not_build_start_nothing(self) -> None:
        for status in ("stale", "build"):
            with self.subTest(failed=status):
                (self.root / "builds.log").unlink(missing_ok=True)
                result = self.smoke(
                    "up",
                    "local",
                    stale="images/archivist\tchanged\n",
                    stale_status="1" if status == "stale" else "0",
                    build_status="1" if status == "build" else "0",
                )
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertEqual(self.lines("starts.jsonl"), [])
                self.assertEqual(self.lines("inits.jsonl"), [])

    def test_up_checks_the_realm_at_the_issuer_the_gateway_names(self) -> None:
        result = self.smoke("up", "local")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            (self.root / "curl.log").read_text().splitlines(),
            [
                "http://localhost:4000/.well-known/oauth-protected-resource",
                f"{ISSUER}/.well-known/openid-configuration",
                DISCOVERY["token_endpoint"],
            ],
        )

    def test_a_failed_up_takes_its_stack_down(self) -> None:
        result = self.smoke("up", "local", start_status="1")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assert_documents_restored()
        self.assertFalse((self.kb / ".smoke-kept").exists())
        self.assertNotEqual(self.smoke("down").returncode, 0)
        self.assertNotIn(
            "semiont-another-kb-gateway",
            result.stdout + result.stderr,
            "the launcher prints a failed container's log; the smoke prints none of the machine's",
        )

    def test_e2e_and_down_refuse_without_a_stack_up(self) -> None:
        for command in ("e2e", "down"):
            result = self.smoke(command)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("up", result.stderr)
        self.assertEqual(self.lines("starts.jsonl"), [])

    def test_a_second_up_refuses_while_one_is_up(self) -> None:
        self.assertEqual(self.smoke("up", "local").returncode, 0)
        result = self.smoke("up", "local")
        self.assertEqual(result.returncode, 1)
        self.assertIn("make stack-down", result.stderr)
        self.assertEqual(len(self.lines("starts.jsonl")), 1)

    def test_each_e2e_runs_on_a_fresh_knowledge_base_beside_up(self) -> None:
        self.assertEqual(self.smoke("up", "0.7.1").returncode, 0)
        for _ in range(2):
            result = self.smoke("e2e")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        inits = self.lines("inits.jsonl")
        self.assertEqual(len(inits), 3)
        self.assertEqual(len({init["domain"] for init in inits}), 3)
        self.assertEqual(len({init["cwd"] for init in inits}), 3)
        for e2e in inits[1:]:
            self.assertNotEqual(os.path.realpath(e2e["cwd"]), os.path.realpath(self.kb))
            self.assertFalse(Path(e2e["cwd"]).exists())
            self.assertIn(os.path.realpath(e2e["cwd"]), self.stopped())
            # A queue that reads empty is read once.
            self.assertEqual(self.asked_status().count(os.path.realpath(e2e["cwd"])), 1)
        for start in self.lines("starts.jsonl")[1:]:
            self.assertIn("semiont-gateway:0.7.1\n", start["gateway"])
        self.assertNotIn(os.path.realpath(self.kb), self.stopped())
        calls = (self.root / "runtime.log").read_text()
        self.assertIn("E2E_GATEWAY_URL=http://localhost:4010", calls)
        self.assertIn("E2E_GATEWAY_URL=http://localhost:4020", calls)
        self.assertTrue((self.kb / ".smoke-kept").exists())

    def test_e2e_runs_test_ci_unless_another_script_is_named(self) -> None:
        self.assertEqual(self.smoke("up", "0.7.1").returncode, 0)
        for args in (
            (),
            ("--script", "test:slow"),
            ("--", "specs/20-x.spec.ts", "--repeat-each=5"),
            ("--script", "test:model", "--", "--grep", "two words"),
        ):
            with self.subTest(args=args):
                result = self.smoke("e2e", *args)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            self.suites(),
            [
                ["sh", "smoke-test-runtime", "test:ci"],
                ["sh", "smoke-test-runtime", "test:slow"],
                [
                    "sh",
                    "smoke-test-runtime",
                    "test:ci",
                    "specs/20-x.spec.ts",
                    "--repeat-each=5",
                ],
                ["sh", "smoke-test-runtime", "test:model", "--grep", "two words"],
            ],
        )

    def test_run_gives_its_e2e_the_script_and_arguments(self) -> None:
        result = self.smoke(
            "run", "local", "--e2e", "--script", "test:slow", "--", "specs/20-x.spec.ts"
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            self.suites(),
            [["sh", "smoke-test-runtime", "test:slow", "specs/20-x.spec.ts"]],
        )

    def test_e2e_binds_its_knowledge_base_to_the_model_named_and_up_to_inits(self) -> None:
        self.assertEqual(self.smoke("up", "0.7.1").returncode, 0)
        for args in ((), ("--script", "test:slow", "--model", "gemma4:26b")):
            with self.subTest(args=args):
                result = self.smoke("e2e", *args)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        up, default, named = self.lines("inits.jsonl")
        self.assertEqual(up["flags"], ["--yes", "--domain", "example.github.io:stack-smoke"])
        self.assertEqual(default["flags"], ["--yes", "--domain", default["domain"]])
        self.assertEqual(named["flags"], ["--yes", "--domain", named["domain"], "--model", "gemma4:26b"])
        self.assertEqual(
            self.suites(),
            [["sh", "smoke-test-runtime", "test:ci"], ["sh", "smoke-test-runtime", "test:slow"]],
        )

    def test_run_gives_its_e2e_the_model(self) -> None:
        result = self.smoke("run", "local", "--e2e", "--model", "gemma4:26b")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        up, e2e = self.lines("inits.jsonl")
        self.assertNotIn("--model", up["flags"])
        self.assertEqual(e2e["flags"][-2:], ["--model", "gemma4:26b"])

    def test_an_option_it_does_not_know_starts_nothing(self) -> None:
        for args in (
            ("e2e", "--scirpt", "test:slow"),
            ("e2e", "--script"),
            ("e2e", "--script", ""),
            ("e2e", "--model"),
            ("e2e", "--model", ""),
            ("e2e", "specs/20-x.spec.ts"),
            ("run", "local", "--script", "test:slow"),
            ("run", "local", "--e2e", "test:slow"),
        ):
            with self.subTest(args=args):
                result = self.smoke(*args)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("usage", result.stderr)
        self.assertEqual(self.lines("inits.jsonl"), [])
        self.assertEqual(self.build_calls(), [])

    def test_a_failed_e2e_leaves_its_knowledge_base_up_until_down(self) -> None:
        self.assertEqual(self.smoke("up", "0.7.1").returncode, 0)
        self.use_runtime("smoke-test-runtime", 7)
        result = self.smoke("e2e")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        kept = os.path.realpath(self.lines("inits.jsonl")[1]["cwd"])
        self.assertTrue(Path(kept).exists())
        self.assertNotIn(kept, self.stopped())
        self.assertIn(Path(kept).parent.name, result.stdout)
        self.assertIn("make stack-down", result.stdout)
        result = self.smoke("down")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(Path(kept).exists())
        # The shared containers stop with the last knowledge base, so UP's is last.
        self.assertEqual(self.stopped(), [kept, os.path.realpath(self.kb)])
        self.assert_documents_restored()

    def test_e2e_fails_on_a_job_left_pending_or_running(self) -> None:
        self.assertEqual(self.smoke("up", "0.7.1").returncode, 0)
        for queue, reason in (
            ("2 pending · 0 running", "2 pending and 0 running"),
            (
                "0 pending · 1 running · 3 completed · 0 failed since worker start",
                "0 pending and 1 running",
            ),
            ("", "no queue line"),
        ):
            with self.subTest(queue=queue):
                result = self.smoke("e2e", queue=queue)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(reason, result.stdout)
                kept = os.path.realpath(self.lines("inits.jsonl")[-1]["cwd"])
                self.assertTrue(Path(kept).exists(), "a failed run leaves its KB")
                self.assertNotIn(kept, self.stopped())
                # Read again and again while it does not read empty.
                self.assertGreater(self.asked_status().count(kept), 1)
        left = [os.path.realpath(init["cwd"]) for init in self.lines("inits.jsonl")[1:]]
        result = self.smoke("down")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for kept in left:
            self.assertFalse(Path(kept).exists())
        self.assertEqual(self.stopped(), [*left, os.path.realpath(self.kb)])

    def test_run_with_e2e_uses_the_selected_runtime_and_takes_everything_down(
        self,
    ) -> None:
        for runtime in ("container", "docker", "podman"):
            for status in (0, 7):
                with self.subTest(runtime=runtime, status=status):
                    for name in (
                        "starts.jsonl",
                        "inits.jsonl",
                        "launcher.jsonl",
                        "runtime.log",
                        "suites.log",
                    ):
                        (self.root / name).unlink(missing_ok=True)
                    shutil.rmtree(self.kb, ignore_errors=True)
                    self.use_runtime(runtime, status)
                    result = self.smoke("run", "local", "--e2e")
                    self.assertEqual(
                        result.returncode,
                        int(status != 0),
                        result.stdout + result.stderr,
                    )
                    self.assert_documents_restored()
                    self.assertFalse((self.kb / ".smoke-kept").exists())
                    calls = (self.root / "runtime.log").read_text()
                    self.assertIn("e2e-localhost-bridge.mjs", calls)
                    self.assertIn("sh " + runtime, calls)
                    if runtime == "container":
                        self.assertNotIn("--network host", calls)
                        self.assertNotIn("--ipc host", calls)
                    else:
                        self.assertIn("--network host --ipc host", calls)
                    stops = self.stopped()
                    self.assertEqual(stops[-1], os.path.realpath(self.kb))
                    self.assertNotIn(os.path.realpath(self.kb), stops[:-1])
                    # Passed or failed, the e2e's knowledge base is gone when run is done.
                    e2e = os.path.realpath(self.lines("inits.jsonl")[1]["cwd"])
                    self.assertIn(e2e, stops)
                    self.assertFalse(Path(e2e).exists())
                    self.assertEqual(self.suites(), [["sh", runtime, "test:ci"]])


if __name__ == "__main__":
    unittest.main()
