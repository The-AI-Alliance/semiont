# Real-stack smoke test

From the repository root:

```sh
./images/tests/stack/smoke-stack.sh up local   # make stack-up
./images/tests/stack/smoke-stack.sh e2e        # make e2e
./images/tests/stack/smoke-stack.sh e2e --script test:slow --model gemma4:26b -- specs/01-sign-in.spec.ts
                                               # make e2e E2E_SCRIPT=test:slow E2E_MODEL=gemma4:26b E2E_ARGS=specs/01-sign-in.spec.ts
./images/tests/stack/smoke-stack.sh down       # make stack-down
./images/tests/stack/smoke-stack.sh run local --e2e   # all three; make smoke
```

A published image tag can stand for `local`. `up local` first builds the `:local` images,
as `make local PACKAGE_NAMES=typescript` does, when the build finds them older than
the checkout. `up` starts a fresh knowledge base with the checkout's launcher, checks
health, identity and Browser origins, and leaves it running. `e2e` makes a knowledge base
and user of its own beside it and runs the default end-to-end tier against them, or the
npm script `--script` names, with the arguments after `--` given to Playwright. Its
knowledge base is bound to the model `semiont init` picks, or to the one `--model` names. It then
reads the knowledge base's job queue from `semiont status` until nothing is pending or
running: a job left pending or running after two minutes fails the run. A run that passed
removes its knowledge base and user; one that failed leaves the knowledge base running to
read, and says where. `down` removes each knowledge base a failed `e2e` left, stops the
stack, checks shutdown, and cleans up its state. `.github/workflows/stack-smoke.yml` runs
`run <tag> --e2e` in CI.

Run `python3 -m unittest discover -s images/tests/stack -p 'test_*.py' -v` to check
image selection, document restoration, the knowledge bases each step makes and leaves,
and the suite's script and arguments, without starting containers. Both the Browser and
worker machine documents use the requested tag from `up` until `down`, and are restored
when `up` fails.
