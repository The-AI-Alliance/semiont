"""Semiont's Python SDK.

What the protocol states, as Python types: the kinds of id
(`semiont.identifiers`), the shapes it sends and answers with
(`semiont.types`), the channels of its bus and the requests made over them
(`semiont.channels`, `semiont.operations`), and the tables a client keeps to
(`semiont.error_codes`, `semiont.timing`, `semiont.refresh`). All of it is
generated from `specs/`.

And the bus itself: what a client needs of whatever carries it
(`semiont.transport`), a request made over it (`semiont.bus`), and a
knowledge base's gateway as the carrier (`semiont.http`).
"""
