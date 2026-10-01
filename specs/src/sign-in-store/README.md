# sign-in-store — the sign-ins `semiont login` keeps

One standalone contract: `<stateDir>/tokens.json`, where the semiont launcher
(Go, `apps/launcher`) keeps the session of each stack a person has signed in
to, and where an application built on the Rust SDK finds it. One sign-in
serves the launcher's verbs and that application.

It is a contract because two programs in two languages read and write the
file. Like [discovery](../discovery/README.md), its schema refs nothing
outside this directory.

## The document

A JSON object. Each member is one sign-in ([`SignIn.json`](SignIn.json)),
under the key of the stack it is for:

| Key | The stack |
|---|---|
| `local` | the machine's one local stack |
| `codespace:<owner>/<name>` | the codespace stack of that repository |

The keys are the launcher's stack keys, as in its `stack.json`. An SDK
session reaches a sign-in by using the stack's key as its knowledge base id.

Every sign-in here was issued to the script client (`script` in
[`session/oauth.json`](../session/oauth.json)), and is renewed as that
client. A session issued to any other client is not kept here: renewing it
as the script client would be refused.

A reader keeps what it does not understand: a member that is not a sign-in,
written by a later release, is written back as it was.

## Where it is

`<stateDir>` is the launcher's state home:
[`cases.json`](cases.json) says where that is on each system, and every
program that finds the file runs those cases.

The file holds bearer credentials. It is created with mode `0600`, and
written by writing a sibling temporary file and renaming it over the old
one, so no reader sees half a document and no credential is left in a stray
file.

## Writing it

Every change to the document is a read, a change and a write, and two
programs make them: the launcher's `login`, `logout` and each verb's
renewal, and an SDK session's renewal and sign-out. Each holds an exclusive
advisory lock (`flock`) on `<stateDir>/tokens.lock` from before its read
until after its rename. Without it, two renewals at once would each write
the document they read, and one stack's new tokens would be lost under the
other's.

A reader that only reads takes no lock: the rename makes each document
whole.

The Rust SDK takes the lock (`semiont::sign_in_store`). The launcher's Go
does not take it yet, and is not generated from `SignIn.json` or held to
`cases.json` yet.
