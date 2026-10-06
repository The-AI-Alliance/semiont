"""Semiont's Python SDK.

What the protocol states, as Python types: the kinds of id
(`semiont.identifiers`), the shapes it sends and answers with
(`semiont.types`), the channels of its bus and the requests made over them
(`semiont.channels`, `semiont.operations`), and the tables a client keeps to
(`semiont.error_codes`, `semiont.timing`, `semiont.refresh`,
`semiont.telemetry_table`). All of it is generated from `specs/`.

The wire itself: what a client needs of whatever carries its bus, its content
and a gateway's own answers (`semiont.transport`), the bus typed by channel
(`semiont.bus`), a knowledge base's gateway as the carrier, and how a process
signs in there (`semiont.http`), and what is told to OpenTelemetry of it
(`semiont.telemetry`).

And the client every Semiont SDK has (`semiont.client`): its namespaces
(`semiont.namespaces`), each method a row of `specs/src/client/surface.json`,
its own bus (`semiont.event_bus`), and a session with one knowledge base
(`semiont.session`).
"""
