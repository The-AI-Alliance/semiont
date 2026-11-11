# Signing in

How a program comes to hold a token a knowledge base accepts.

Sign-in happens at the knowledge base's identity provider, never at the gateway, and no password passes through your program. Which way a program signs in follows from who is signing in.

For OCaml installation, sign-in, and live queries, see the [OCaml builder guide](./OCAML.md).

## Which way

| Who is signing in | The way | TypeScript | Python | Rust | Go | Kotlin | .NET | Swift | Haskell | OCaml |
|---|---|---|---|---|---|---|---|---|---|---|
| A person, at a script | [The device grant](#the-device-grant): the script shows an address, the person approves in any browser | `SemiontSession.signInDevice`, then `SemiontSession.fromKept` | `sign_in_device` | `sign_in_device`, then `session_from_kept` | `SignInWithDevice` | `signInDevice` | `Issuer.SignInDeviceAsync`, then `SemiontSession.FromKeptAsync` | `signInDevice`, then `sessionFromKept` | `Session.signInDevice` | `OAuth.begin_device` and `OAuth.await_device` |
| A person who has run `semiont login` | [The sign-in the launcher keeps](#the-sign-in-semiont-login-keeps): nothing to approve | `SignInStore.entry` and `SemiontSession.fromKept` | `session_from_kept` | `SignInStore::entry` and `session_from_kept` | `SessionFromKept` | `sessionFromKept` | `SignInStore.Entry` and `SemiontSession.FromKeptAsync` | `SignInStore` and `sessionFromKept` | `SignInStore.entry` and `Session.fromKeptSession` | `Sign_in_store.make` and `Sign_in_store.session` |
| A service or a worker | [A service account](#a-service-or-a-worker): the program signs in as its own account, an agent | `startAgentSession` | `AgentToken` | `AgentToken::sign_in` | `SignInAgent` | `AgentToken` | `ServiceToken` and `AgentToken.SignInAsync` | `ServiceToken` and `AgentToken` | `ServiceToken` and `Session.signInAgent` | `Agent.sign_in` or `Service_token` |
| A person, in an application | [A page redirect](#an-application) to the identity provider and back | `SemiontBrowser.beginSignIn`, `completeSignIn` | `begin_sign_in`, `complete_sign_in` | `begin_sign_in`, `complete_sign_in` | `BeginSignIn`, `CompleteSignIn` | `beginSignIn`, `completeSignIn` | `BrowserSignIn.BeginSignInAsync` and `CompleteSignInAsync` | `SemiontBrowser.beginSignIn` and `completeSignIn` | `Registry.beginSignIn` and `completeSignIn` | `Registry.begin_sign_in` and `Registry.complete_sign_in` |
| A program that already holds tokens | [The tokens themselves](#tokens-you-already-hold) | `MemorySignIn` and `SemiontSession.fromKept`, or `SemiontSession.fromHttp` | its README | `MemorySignIn` and `session_from_kept` | its README | its README | `SemiontSession.FromKeptAsync` or `SemiontClient` | `SemiontClient.fromHttp` or `sessionFromKept` | `Session.fromIssuedSession` or `Client.fromHttp` | `Session.start`, then `Client.connect` |
| Every way above | [The HTTP client you give it](#the-http-client): its requests go through that client | `fetch` | `http=` | `http` | `HTTP` | `http` | `HttpClient` | `HTTPClient` | `HttpClient` | `OAuth.http` and the gateway adapter passed to `Client.connect` |

See the SDK guides for [TypeScript](../../packages/typescript/sdk/README.md#connect), [Python](../../packages/python/sdk/README.md#signing-in), [Go](../../packages/go/sdk/README.md#signing-in), [Kotlin](../../packages/kotlin/sdk/README.md#signing-in), [Rust](../../packages/rust/http-transport/README.md), [.NET](../../packages/csharp/sdk/README.md#signing-in), [Swift](../../packages/swift/sdk/README.md#connect), [Haskell](../../packages/haskell/sdk/README.md#signing-in), and [OCaml](../../packages/ocaml/sdk/README.md#sign-in-and-connect).

## What every way has in common

- **An access token is short-lived**: five minutes from the Keycloak a launcher stack runs. A session renews it before it expires and stores what it holds. A bare client with a bare token stops working when the token does.
- **A person's session ends once, and says why**: `expired` when the identity provider will not renew it, `refused` when the gateway will not accept a token the provider has just issued. Neither is a prompt to retry.
- **A stored sign-in outlives the network**: it is forgotten only when the identity provider refuses to renew it, whenever the session renews it: at its start, on its schedule, or when the gateway refuses its token. When the provider cannot be reached, the sign-in is kept, the session holds no token and says so (`session.auth-failed` at its start, `session.refresh-exhausted` after), and it renews the token on the reconnect backoff, or when a request is refused, once the provider answers again.
- **What a program writes is attributed to who signed in**: a person's work to the person, an agent's to the agent.

## The HTTP client

Every way makes its requests, of the gateway and of the identity provider, with an HTTP client the program gives it, and the certificates trusted and the proxy gone through are that client's. No SDK reads a setting of its own for either.

| SDK | What it takes | Where | Given none |
|---|---|---|---|
| TypeScript | a `fetch` | `fetch` in the options of `SemiontSession.signInDevice`, `fromKept` and `fromHttp`, `startAgentSession` and `SemiontBrowser`; the last argument of `signOut`, `createHttpSessionFactory` and of `ServiceToken` | the runtime's own |
| Python | an `httpx.AsyncClient` | `http=` on `sign_in_device`, `session_from_kept`, `ServiceToken`, `AgentToken`, `begin_sign_in`, `complete_sign_in` and `HttpSessionFactory` | one of its own |
| Rust | a `reqwest::Client` | `http` in `SessionFromKept`, and the argument `http` of `sign_in_device`, `sign_out`, `ServiceToken::new`, `AgentToken::sign_in`, `begin_sign_in`, `complete_sign_in` and `HttpSessionFactory::new` | none: it is required |
| Go | a `*http.Client` | `HTTP` in the `Issuer` that `SignInWithDevice`, `NewServiceToken`, `BeginSignIn` and `CompleteSignIn` take, and in `AgentConfig`, `SessionFromKeptConfig` and `registry.HttpSessionFactory` | none: it is required |
| Kotlin | a `java.net.http.HttpClient` | the last argument `http` of `sessionFromKept`, `beginSignIn`, `completeSignIn`, `ServiceToken`, `AgentToken` and `HttpSessionFactory`, and of `signInDevice` before its `onCode` | the JDK's, with its default proxy selector and trust store |
| .NET | a `System.Net.Http.HttpClient` | `httpClient` on `Issuer`, `SemiontSession.FromKeptAsync`, `ServiceToken`, `AgentToken`, `HttpSessionFactory`, and the client and transport constructors. The redirect helpers also accept it. | an SDK-owned HTTP handler with proxy use disabled |
| Haskell | an `HttpClient`, which `Http.newHttpClient` builds from `http-client` `ManagerSettings` and a proxy policy | `httpClient` in the `HttpOptions` that `Session.signInDevice`, `fromKeptSession`, `fromIssuedSession` and `signInAgent`, `Client.fromHttp`, `newHttpSessionFactory` and the registry take, and `issuerHttpClient` in the `IssuerOptions` of `Issuer` and `ServiceToken` | none: it is required |
| OCaml | an `OAuth.http` callback for the issuer and a streaming HTTP adapter for the gateway | the issuer callback goes to the sign-in functions, and the gateway adapter goes to `Client.connect` | both are supplied by the application |

An SDK never closes a client it is given: the program that built it closes it.

## The device grant

The script asks the identity provider for a code and shows the person where to approve it. The person approves in any browser, on any machine, and the tokens come back to the script.

```typescript
import { MemorySignIn, SemiontSession, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');
const kb = httpKb({
  id: 'my-script', label: 'My script',
  host: url.hostname, port: Number(url.port || 4000),
  protocol: url.protocol === 'https:' ? 'https' : 'http',
});
const kept = new MemorySignIn();

await SemiontSession.signInDevice({
  kb,
  kept,
  onCode: ({ verificationUri, verificationUriComplete, userCode }) => {
    console.error(`Approve this script at ${verificationUriComplete ?? verificationUri}`);
    if (!verificationUriComplete) console.error(`Code: ${userCode}`);
  },
});
const opened = await SemiontSession.fromKept({ kb, kept });
```

- **The device grant keeps the sign-in, and `SemiontSession.fromKept` gives an `OpenedSession`**, which holds the session and its client. Call `opened.dispose()` to close the client and then end the session.
- **It needs a person each time the script starts**, unless the script keeps its sign-in. A pipeline of several scripts asks once per script.
- **To keep the sign-in between runs**, keep it in `keptIn(storage, kb.id)` over a `SessionStorage` that writes to a file: [`semiont-session`](./skills/semiont-session/SKILL.md#keeping-tokens-across-restarts) has one. The file holds tokens. Keep it where only you can read it, and outside the knowledge base's working tree, which is a git repository.
- **`kb.id` is the key `keptIn` stores the sign-in under.** Two scripts that share one storage use different ids.

In .NET, `Issuer.SignInDeviceAsync` stores the granted credentials in the
supplied `ISignInKept`. Open a session over that same entry with
`SemiontSession.FromKeptAsync`, which gives the session with the client it
was built with. The
[.NET SDK guide](../../packages/csharp/sdk/README.md#signing-in) shows it.

[Usage](./Usage.md#setup) has the TypeScript options, and [`semiont-session`](./skills/semiont-session/SKILL.md) a long-running script built on it.

## The sign-in `semiont login` keeps

[`semiont login`](../../apps/launcher/README.md#login-and-upload) signs a person in to a running stack's knowledge base and keeps the sign-in, one for each stack, in the launcher's state directory. The [sign-in store](../../protocol/specs/src/sign-in-store/README.md) is the contract for that file: where it is on each system, what an entry holds, the lock every writer takes, and what a renewal keeps.

A program on any of the SDKs builds its session over that entry, so a person who has run `semiont login` approves nothing more, and one sign-in serves the launcher and the program. Each reads the entry, renews it, and writes it back under the lock. A renewal another program made meanwhile stands, and a stack signed out meanwhile stays signed out.

The TypeScript SDK reaches no file itself: a TypeScript program gives its `SignInStore` the files it reads, writes and locks (`SignInFiles`), and the store tells them which file and mode to use. The [TypeScript SDK guide](../../packages/typescript/sdk/README.md#the-sign-in-semiont-login-keeps) says what those files must do to share the store with the launcher.

A program in a container sees the launcher's state directory only if it is mounted into the container.

## A service or a worker

A process with no person behind it signs in with a service account: a client id and a secret the identity provider holds. The account is an agent's, as a person's is a person's: the program sends the identity provider's token to the gateway as its bearer, and its DID is `did:web:<domain>:agents:<subject>`, which it learns from `GET /api/users/me`. What the process writes is attributed to it. A write a model produced also names, in its `generator`, the engine it used: the provider and the model.

An agent renews its token by a new grant when the token is due, and at once when the gateway refuses it. A gateway or an identity provider it cannot reach is tried again; a refusal by the identity provider is final. [`semiont-worker`](./skills/semiont-worker/SKILL.md) is a worker built this way.

## An application

A web or a desktop application sends the person to the identity provider and finishes the sign-in when the provider sends them back (the authorization code grant, with PKCE). The registry keeps the knowledge bases a person has registered and which one
is active. In .NET, `BrowserSignIn` starts and completes the redirect using
the application's `SemiontBrowser`.

## Tokens you already hold

In TypeScript, the entry point depends on the credentials you hold.

- **An access token and its refresh token** go in a `MemorySignIn` (a `StoredSession`: access, refresh, clientId, tokenEndpoint), opened with `SemiontSession.fromKept`. The session renews them as if it had signed in itself.
- **An access token and your own renewal logic** go to `SemiontSession.fromHttp` with the `refresh` you supply. `fromKept` and `fromHttp` each give an `OpenedSession`.
- **An access token alone** goes to `SemiontClient.fromHttp`. Use it for a program that finishes within the token's lifetime.

In .NET, pass an existing access token to `SemiontClient`. For a credential
with a refresh token, store the grant in an `ISignInKept` and open it with
`SemiontSession.FromKeptAsync`. A host with its own renewal logic can pass a `refresher` to
`HttpTransport` and construct the client over that transport.

In every SDK a transport's refresher is told the token the gateway refused,
or that the request carried none. A refresher that holds another token by
then, because it already renewed for an earlier refusal of that one, gives
the token it holds and renews nothing. The sessions and agents of every SDK
answer this way.
