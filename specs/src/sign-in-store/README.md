# sign-in-store — the sign-ins `semiont login` keeps

One standalone contract: `<stateDir>/tokens.json`, where the semiont launcher
(Go, `apps/launcher`) keeps the session of each stack a person has signed in
to, and where an application built on the Go, Rust or Python SDK finds it.
One sign-in serves the launcher's verbs and that application.

It is a contract because programs in three languages read and write the
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

Every sign-in says who signed in and at which issuer (`email`, `issuer`):
what the access token named when the sign-in was made. A gateway admits no
token that names no address, and none from an issuer it does not trust, so a
session whose token lacks either is no sign-in and is not written. A writer
that renews a sign-in keeps both as they were.

A reader keeps what it does not understand: a member that is not a sign-in,
written by a later release, is written back as it was.

## Where it is

`<stateDir>` is the launcher's state home:
[`cases.json`](cases.json)'s `cases` say where that is on each system — macOS,
Windows, and everything else. Each SDK that reads the store runs them, and the
launcher finds its state home through the Go SDK's.

The file holds bearer credentials. It is created with mode `0600`, and
written by writing a sibling temporary file and renaming it over the old
one, so no reader sees half a document and no credential is left in a stray
file.

## Writing it

Every change to the document is a read, a change and a write, and more than
one program makes them: the launcher's `login`, `logout` and each verb's
renewal, and an SDK session's sign-in, renewal and sign-out. Each holds an exclusive
lock on `<stateDir>/tokens.lock` (`flock`; on Windows, `LockFileEx`) from
before its read until after its rename. Without it, two renewals at once would each write
the document they read, and one stack's new tokens would be lost under the
other's.

A reader that only reads takes no lock: the rename makes each document
whole.

Every writer takes the lock: the Go SDK (`packages/go/sdk`, `SignInStore`),
through which the launcher keeps its sign-ins, the Rust SDK
(`semiont::sign_in_store`) and the Python SDK (`semiont.sign_in_store`). On
Windows the lock is on one byte of the lock file, far past anything the file
holds (`OffsetHigh: 0x40000000`), and a writer that locks the whole file
holds that byte too. Each generates its entry from `SignIn.json`.

## Renewing it

A renewal reads the stack's sign-in, makes the refresh grant at its issuer,
and writes what the issuer issued. Other programs renew the same sign-in, and
sign the stack out, while it does. Three rules keep what each of them did:

1. **A refresh token another program replaced is not spent.** Before the
   grant: when the kept access token is not the one the renewer holds (the
   one the gateway refused, or the one due) and has not expired, another
   program has already renewed. That access token is given as it is, and no
   grant is made.
2. **A renewal another program made meanwhile stands.** After the grant,
   under the lock: the renewal writes its tokens only when the kept sign-in
   still holds the access token and the refresh token it read. When either is
   another, another program renewed, or signed in again, while the grant was
   in flight. Its tokens stand, the ones this renewal was issued are dropped,
   and this renewal gives the kept access token. The refresh token alone does
   not tell: an issuer that rotates none leaves it as it was.
3. **A stack signed out meanwhile stays signed out.** When the sign-in is gone
   by the time the renewal comes to write, nothing is written back, and the
   new access token is given to nobody. When it is gone before the renewal
   reads, there is nothing to renew, and no grant is made.

Each SDK that reads the store runs every case of `cases.json`'s `renewals`
through its renewal, over each store it has, as the table's `$comment` says.
