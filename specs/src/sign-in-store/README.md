# sign-in-store — the sign-ins `semiont login` keeps

One standalone contract: `<stateDir>/tokens.json`, where the semiont launcher
(Go, `apps/launcher`) keeps the session of each stack a person has signed in
to, and where an application built on the Go, Rust, Python or Kotlin SDK finds it.
One sign-in serves the launcher's verbs and that application.

It is a contract because programs in four languages read and write the
file. Like [discovery](../discovery/README.md), its schema refs nothing
outside this directory.

## The document

A JSON object. Each member is one sign-in ([`SignIn.json`](SignIn.json)),
under the key of the stack it is for:

| Key | The stack |
|---|---|
| `local:<did-key>` | the local stack of the knowledge base whose did:web is `did:web:<domain>`: `<did-key>` is `<domain>` with each run of characters outside `A-Z a-z 0-9 . _ -` replaced by one `-` (`did:web:example.org:my-kb` is `local:example.org-my-kb`) |
| `codespace:<owner>/<name>` | the codespace stack of that repository |

The keys are the launcher's stack keys, as in its `stack.json`. An SDK
session reaches a sign-in by using the stack's key as its knowledge base id.

Every sign-in here was issued to the script client (`script` in
[`session/oauth.json`](../session/oauth.json)), and is renewed as that
client. A session issued to any other client is not kept here: renewing it
as the script client would be refused.

Every sign-in says at which issuer it was made (`issuer`), and who signed in
when the access token named an address (`email`): what the token named when
the sign-in was made. A gateway admits no token from an issuer it does not
trust, so a session whose token names no issuer is no sign-in and is not
written. An account need not have an address, so a token that names none is
kept without one. A writer that renews a sign-in keeps both as they were.

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

Every writer keeps `<stateDir>` to its owner, as the launcher keeps its state
home, once it holds the lock (below) and before it reads, so the file and the
temporary file are its owner's alone from the moment each is made, and the
lock from then on: with the mode, and on Windows, where a mode keeps nobody
out, the access list, that [`owner-only.json`](owner-only.json) states. The
list allows full access to the user the writer runs as (its process token's
user), to the system and to the administrators, and to nobody else; it is
handed down to everything made in the directory, and it is protected, so
nothing is inherited from above. Every writer, and the launcher, generates
both from that file.

A directory that has the list already is left as it is: setting a list hands
it down to everything beneath, and is done under the lock because a file
being handed the list cannot be renamed over. The directory's list and this
one are compared as Windows writes each out, which names some users by an
abbreviation (the built-in administrator's SID is written `LA`), and with
their entries in any order: entries that each allow mean the same in any
order.

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
(`semiont::sign_in_store`), the Python SDK (`semiont.sign_in_store`) and the
Kotlin SDK (`semiont.signin.SignInStore`). On
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
