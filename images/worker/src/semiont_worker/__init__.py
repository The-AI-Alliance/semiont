"""Semiont's Worker service: it claims the annotation and generation jobs of the knowledge bases it serves, and runs them against a model.

It is a service's code and no library. Nothing imports it, it has no public
names, and no index holds it: it is run from its image. What the service does
is written rule by rule in `docs/protocol/WORKER-SERVICE.md`, and the parts of
it a case table under `specs/src` states exactly are each held to their table
by the tests.
"""
