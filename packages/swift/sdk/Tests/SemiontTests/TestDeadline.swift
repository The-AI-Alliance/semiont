// How long a test waits for what must happen before it calls the wait hung. Every test starts at
// once, and on a small CI runner a second can pass before a test's tasks are scheduled. A wait
// that passes returns as soon as its condition holds, so only a hung one waits this long. It is
// clear of every timer a test sets, so a bug fails the test one way, never by a race with it.
let testDeadlineMs = 15_000
