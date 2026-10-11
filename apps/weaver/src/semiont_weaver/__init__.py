"""Semiont's Weaver: the service that keeps a graph database in step with a knowledge base's record.

What it does is written rule by rule in `docs/protocol/WEAVER.md`. Its parts
are its modules: the recorded events it follows (`recorded`), what each does
to the graph (`fold`), how far it has got (`marks`), the order it works in
(`lanes`), what it reads of the record (`history`), the Weaver those make
(`weaver`), and the process that runs one (`service`).
"""
