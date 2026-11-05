# Real-stack smoke test

After `make local-build`, from the repository root:

```sh
./images/tests/stack/smoke-stack.sh up local   # make stack-up
./images/tests/stack/smoke-stack.sh e2e        # make e2e
./images/tests/stack/smoke-stack.sh down       # make stack-down
./images/tests/stack/smoke-stack.sh run local --e2e   # all three; make smoke
```

A published image tag can stand for `local`. `up` starts a fresh knowledge base with
the checkout's launcher, checks health, identity and Browser origins, and leaves it
running. `e2e` makes a knowledge base and user of its own beside it, runs the default
end-to-end tier against them, and removes them. `down` stops the stack, checks shutdown,
and cleans up its state. `.github/workflows/stack-smoke.yml` runs `run <tag> --e2e` in CI.

Run `python3 -m unittest discover -s images/tests/stack -p 'test_*.py' -v` to check
image selection, document restoration and the knowledge bases each step makes, without
starting containers. Both the Browser and worker machine documents use the requested
tag from `up` until `down`, and are restored when `up` fails.
