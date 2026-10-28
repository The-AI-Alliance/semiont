"""The container supervisor, `scripts/container/supervise.sh`, run as an image runs it, over a child that dies on cue.

Every image runs its service under that one script when the launcher asks it
to. It is tested here because this package reads what the script writes (the
lives of `semiont.process.restarts`, `lives_less_one`), and because nothing
else runs it. What it is held to: a child that dies within ten seconds of its
start, five times in a row, refused to boot, and the supervisor gives up; a
child that lives longer and still dies within a minute is crash-looping, is
said to be, and is started again after a wait that doubles; and a TERM between
two lives is answered at once.
"""

import os
import shutil
import signal
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Final

SUPERVISOR: Final = Path(__file__).resolve().parents[3] / "scripts" / "container" / "supervise.sh"

_LONGEST_WAIT: Final = 90.0
"""How long a test waits for a line it expects, in seconds: a crash-looping life here is eleven of them."""


class Supervised:
    """The supervisor over a child that runs `command` in a shell, and every line it has printed, each with when it came."""

    def __init__(self, command: str) -> None:
        self.name: Final = f"test-{uuid.uuid4().hex[:8]}"
        # Nothing answers the probe: the child is never armed for a hang, and dies only as it is told to.
        environment = {**os.environ, "SUPERVISE_NAME": self.name, "SUPERVISE_PROBE": "http://127.0.0.1:9/health"}
        self.process: Final = subprocess.Popen(
            ["sh", str(SUPERVISOR), "sh", "-c", command],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.lines: Final[list[tuple[float, str]]] = []
        self._reading: Final = threading.Thread(target=self._read, daemon=True)
        self._reading.start()

    def _read(self) -> None:
        output = self.process.stdout
        assert output is not None
        for line in output:
            self.lines.append((time.monotonic(), line.rstrip("\n")))

    def when(self, holds: Callable[[str], bool], count: int = 1) -> float:
        """When the `count`th line that `holds` accepts came. Fails if it does not come in time."""
        deadline = time.monotonic() + _LONGEST_WAIT
        while time.monotonic() < deadline:
            came = [at for at, line in list(self.lines) if holds(line)]
            if len(came) >= count:
                return came[count - 1]
            time.sleep(0.1)
        printed = "\n".join(line for _, line in self.lines)
        raise AssertionError(f"the supervisor did not print what was waited for:\n{printed}")

    def said(self, holds: Callable[[str], bool]) -> list[str]:
        """Every line it printed that `holds` accepts."""
        return [line for _, line in list(self.lines) if holds(line)]

    def ended(self) -> int:
        """How the supervisor exited, once it has.

        Its last lines may still be on their way: a `sleep` it began holds
        its output open a while after it has gone. Wait for a line with
        `when`, never for the output to close.
        """
        return self.process.wait(timeout=_LONGEST_WAIT)

    def close(self) -> None:
        """Stop it, if it is still running, and take away what it wrote under the name it was given."""
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=10)
        shutil.rmtree(Path("/tmp") / f"{self.name}-supervisor", ignore_errors=True)


def test_a_child_that_dies_within_seconds_of_its_start_five_times_is_given_up_on() -> None:
    supervised = Supervised("exit 3")
    try:
        assert supervised.ended() == 1
        supervised.when(lambda line: "gave up: 5 rapid failures" in line)
        lives = supervised.said(lambda line: f"starting {supervised.name} (" in line)
        assert len(lives) == 5
        assert supervised.said(lambda line: "gave up: 5 rapid failures" in line)
        # A refusal to boot is no crash loop: it is not waited out, and it is not called one.
        assert supervised.said(lambda line: "crash-looping" in line) == []
    finally:
        supervised.close()


def test_a_child_that_dies_within_a_minute_of_its_start_is_crash_looping_and_waits_longer_each_time() -> None:
    # Past the ten seconds that make a refusal to boot, and then killed as the kernel kills what outgrows its memory.
    supervised = Supervised("sleep 11; kill -9 $$")
    try:
        first = supervised.when(lambda line: "crash-looping" in line)
        second = supervised.when(lambda line: "crash-looping" in line, count=2)
        looping = supervised.said(lambda line: "crash-looping" in line)
        assert "killed by signal 9, which under a memory ceiling is almost always running out of memory" in looping[0]
        assert looping[0].endswith("deaths in a row within 60s of a start: 1; the next start is in 2s")
        assert looping[1].endswith("deaths in a row within 60s of a start: 2; the next start is in 4s")

        # The first wait was two seconds: the second life began no sooner.
        second_life = supervised.when(lambda line: f"starting {supervised.name} (" in line, count=2)
        assert second_life - first >= 1.5

        # A TERM in the wait after the second death is answered at once, not when the wait is over.
        told = time.monotonic()
        supervised.process.send_signal(signal.SIGTERM)
        assert supervised.ended() == 0
        assert time.monotonic() - told < 3
        supervised.when(lambda line: "stopped by TERM between lives" in line)
        assert second < told

        # The restart count counts the lives alone: no other line names the start of the service.
        named = supervised.said(lambda line: f"starting {supervised.name}" in line)
        assert all(f"starting {supervised.name} (rapid failures so far: " in line for line in named)
        assert len(named) == 2
    finally:
        supervised.close()
