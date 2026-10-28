"""The namespaces of a client (`semiont.client.SemiontClient`).

One per flow of the protocol and three beside them: `frame`, `browse`, `mark`,
`bind`, `gather`, `match`, `yield_` and `beckon`; and `job`, `auth` and
`system`.

Every method returns one of nine shapes, and its name, its shape and what
calling it does first are a row of `specs/src/client/surface.json`, which
every SDK is held to:

- an `async def`: asked once, answered once;
- a `Running`: a long-running operation, its reports and its final value;
- a `Delegation`: a job another party does, its events and the completion its verb's jobs give;
- an `Upload`: an upload's progress and the resource it created;
- a `Cached`: a query, sent when its `fresh` is called;
- a `Claims`: a worker's claims, and each job it comes to hold;
- a plain `def` that returns nothing: a signal, fire-and-forget;
- an `async def` giving `int | None`: a drive at the other participants, and
  how many the gateway reached;
- a `Typed`: one channel's events, from now on.
"""
