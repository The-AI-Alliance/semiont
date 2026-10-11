"""What every Python service of Semiont does to be one.

A service reads its configuration document and what its environment holds
beside it (`config`), answers for its health (`health`), writes its log
(`log`), and exports its telemetry (`observability`). Every service does each
the same way, so an operator reads one kind of refusal, one kind of log line
and one set of readings from all of them.

A service is known by one word in lower case, as its image and its container
are named: `worker`, `weaver`. It hands that word to whatever here speaks for
it. Its distribution, and the name its telemetry is exported under, is that
word after `semiont-`.
"""
