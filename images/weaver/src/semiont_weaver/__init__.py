"""Semiont's Weaver: the service that keeps a graph database in step with a knowledge base's record.

What it does is written rule by rule in `docs/protocol/WEAVER.md`. Its parts
are its modules: the recorded events it follows (`recorded`), what each does
to the graph (`fold`), what it reads of the record (`history`), the Weaver
those make (`weaver`), its configuration (`config`), its logger (`log`), and
the process that runs one (`service`). How far it has got, its cursors, is
`semiont_service.follower`, and the order it works in, a lane for each
resource, `semiont_service.lanes`.
"""
