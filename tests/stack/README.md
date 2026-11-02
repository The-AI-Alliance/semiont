# Real-stack smoke test

Run `./tests/stack/smoke-stack.sh local` from the repository root after
`./images/local-build.sh`, or supply a published image tag instead of `local`.
Add `--e2e` to run the default end-to-end tier against the stack.

The script starts a fresh knowledge base using the checkout's launcher, checks
health, identity, Browser origins, and shutdown, and cleans up its temporary state.
`.github/workflows/stack-smoke.yml` runs the same test in CI.

Run `python3 -m unittest discover -s tests/stack -p 'test_*.py' -v` to check
image selection and document restoration without starting containers. Both the
Browser and worker machine documents use the requested tag during the run and
are restored on exit, including when startup fails.
