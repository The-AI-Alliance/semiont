"""What every Python service of Semiont does to be one.

A service reads its configuration document and what its environment holds
beside it (`config`), answers for its health (`health`), writes its log
(`log`), and exports its telemetry (`observability`). Every service does each
the same way, so an operator reads one kind of refusal, one kind of log line
and one set of readings from all of them. A service that keeps a projection of
the record follows it by one rule (`follower`), does each resource's work in a
lane of its own (`lanes`), and reads the catalog of resources whole when it
starts (`catalog`). A service that connects to a store as it starts gives it
one minute to answer, and refuses to start on one that does not (`connect`). A service that reads a resource's
bytes is handed a reader of them (`content`), and the one that asks the
Archivist, for them, for a resource's annotations and for the record by
position, is here (`archivist`). What white space is (`white_space`) is the
same for every service, and is stated here.

A service is known by one word in lower case, as its image and its container
are named: `worker`, `weaver`. It hands that word to whatever here speaks for
it. Its distribution, and the name its telemetry is exported under, is that
word after `semiont-`.
"""
