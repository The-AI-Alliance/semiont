# Signing in

How a program comes to hold a token a knowledge base accepts.

Sign-in happens at the knowledge base's identity provider, never at the gateway, and no password passes through your program. Which way a program signs in follows from who is signing in.

## Which way

| Who is signing in | The way | TypeScript | Python | Rust | Go | Kotlin |
|---|---|---|---|---|---|---|
| A person, at a script | [The device grant](#the-device-grant): the script shows an address, the person approves in any browser | `SemiontSession.signInDevice` | `sign_in_device` | `sign_in_device` | `SignInWithDevice` | `signInDevice` |
| A person who has run `semiont login` | [The sign-in the launcher keeps](#the-sign-in-semiont-login-keeps): nothing to approve | none | `session_from_kept` | `SignInStore` | `SessionFromKept` | `sessionFromKept` |
| A service or a worker | [A service account](#a-service-or-a-worker): the program signs in as its own account, an agent | `startAgentSession` | `AgentToken` | `AgentToken::sign_in` | `SignInAgent` | `AgentToken` |
| A person, in an application | [A page redirect](#an-application) to the identity provider and back | `SemiontBrowser.beginSignIn`, `completeSignIn` | `begin_sign_in`, `complete_sign_in` | `begin_sign_in`, `complete_sign_in` | `BeginSignIn`, `CompleteSignIn` | `beginSignIn`, `completeSignIn` |
| A program that already holds tokens | [The tokens themselves](#tokens-you-already-hold) | `SemiontSession.fromIssuedSession`, `SemiontSession.fromHttp` | its README | its README | its README | its README |
| Every way above | [The HTTP client you give it](#the-http-client): its requests go through that client | `fetch` | `http=` | `http` | `HTTP` | `http` |

Each SDK's README has its own forms in full: [TypeScript](../../packages/typescript/sdk/README.md#connect), [Python](../../packages/python/sdk/README.md#signing-in), [Go](../../packages/go/sdk/README.md#signing-in), [Kotlin](../../packages/kotlin/sdk/README.md#signing-in), and for Rust [`semiont-http-transport`](../../packages/rust/http-transport/README.md).

## What every way has in common

- **An access token is short-lived**: five minutes from the Keycloak a launcher stack runs. A session renews it before it expires and stores what it holds. A bare client with a bare token stops working when the token does.
- **A person's session ends once, and says why**: `expired` when the identity provider will not renew it, `refused` when the gateway will not accept a token the provider has just issued. Neither is a prompt to retry.
- **What a program writes is attributed to who signed in**: a person's work to the person, an agent's to the agent.

## The HTTP client

Every way makes its requests, of the gateway and of the identity provider, with an HTTP client the program gives it, and the certificates trusted and the proxy gone through are that client's. No SDK reads a setting of its own for either.

| SDK | What it takes | Where | Given none |
|---|---|---|---|
| TypeScript | a `fetch` | `fetch` in the options of `SemiontSession.signInDevice`, `fromIssuedSession` and `fromHttp`, `startAgentSession` and `SemiontBrowser`; the last argument of `createHttpSessionFactory` | the runtime's own |
| Python | an `httpx.AsyncClient` | `http=` on `sign_in_device`, `session_from_kept`, `ServiceToken`, `AgentToken`, `begin_sign_in`, `complete_sign_in` and `HttpSessionFactory` | one of its own |
| Rust | a `reqwest::Client` | `http` in `SignInDevice` and `StoredSignIn`, and the argument `http` of `ServiceToken::new`, `AgentToken::sign_in`, `begin_sign_in`, `complete_sign_in` and `HttpSessionFactory::new` | none: it is required |
| Go | a `*http.Client` | `HTTP` in the `Issuer` that `SignInWithDevice`, `NewServiceToken`, `BeginSignIn` and `CompleteSignIn` take, and in `AgentConfig`, `SessionFromKeptConfig` and `registry.HttpSessionFactory` | none: it is required |
| Kotlin | a `java.net.http.HttpClient` | the last argument `http` of `sessionFromKept`, `beginSignIn`, `completeSignIn`, `ServiceToken`, `AgentToken` and `HttpSessionFactory`, and of `signInDevice` before its `onCode` | the JDK's, with its default proxy selector and trust store |

An SDK never closes a client it is given: the program that built it closes it.

## The device grant

The script asks the identity provider for a code and shows the person where to approve it. The person approves in any browser, on any machine, and the tokens come back to the script.

```typescript
import { SemiontSession, InMemorySessionStorage, httpKb } from '@semiont/sdk';

const url = new URL(process.env.SEMIONT_API_URL ?? 'http://localhost:4000');

const opened = await SemiontSession.signInDevice({
  kb: httpKb({
    id: 'my-script', label: 'My script',
    host: url.hostname, port: Number(url.port || 4000),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  }),
  storage: new InMemorySessionStorage(),
  onCode: ({ verificationUri, verificationUriComplete, userCode }) => {
    console.error(`Approve this script at ${verificationUriComplete ?? verificationUri}`);
    if (!verificationUriComplete) console.error(`Code: ${userCode}`);
  },
});
```

- **It gives an `OpenedSession`**: the session, and the client it was built with. The session only uses its client, so the two end together: `opened.dispose()` ends the session, then closes the client.
- **It needs a person each time the script starts**, unless the script keeps its tokens. A pipeline of several scripts asks once per script.
- **To keep the tokens between runs**, give the session a `SessionStorage` that writes to a file: [`semiont-session`](./skills/semiont-session/SKILL.md#keeping-tokens-across-restarts) has one. The file holds tokens. Keep it where only you can read it, and outside the knowledge base's working tree, which is a git repository.
- **`kb.id` is the key the tokens are stored under.** Two scripts that share one storage use different ids.

[Usage](./Usage.md#setup) has the options, and [`semiont-session`](./skills/semiont-session/SKILL.md) a long-running script built on it.

## The sign-in `semiont login` keeps

[`semiont login`](../../apps/launcher/README.md#login-and-upload) signs a person in to a running stack's knowledge base and keeps the sign-in, one for each stack, in the launcher's state directory. The [sign-in store](../../specs/src/sign-in-store/README.md) is the contract for that file: where it is on each system, what an entry holds, the lock every writer takes, and what a renewal keeps.

A Go, Python, Rust or Kotlin program builds its session over that entry, so a person who has run `semiont login` approves nothing more, and one sign-in serves the launcher and the program. Each reads the entry, renews it, and writes it back under the lock. A renewal another program made meanwhile stands, and a stack signed out meanwhile stays signed out.

The TypeScript SDK does not read the store: a TypeScript script signs in by the device grant.

A program in a container sees the machine's state directory only if it is mounted into the container.

## A service or a worker

A process with no person behind it signs in with a service account: a client id and a secret the identity provider holds. The account is an agent's, as a person's is a person's: the program sends the identity provider's token to the gateway as its bearer, and its DID is `did:web:<domain>:agents:<subject>`, which it learns from `GET /api/users/me`. What the process writes is attributed to it. A write a model produced also names, in its `generator`, the engine it used: the provider and the model.

An agent renews its token by a new grant when the token is due, and at once when the gateway refuses it. A gateway or an identity provider it cannot reach is tried again; a refusal by the identity provider is final. [`semiont-worker`](./skills/semiont-worker/SKILL.md) is a worker built this way.

## An application

A web or a desktop application sends the person to the identity provider and finishes the sign-in when the provider sends them back (the authorization code grant, with PKCE). In every SDK this is the registry's (`SemiontBrowser`), which also keeps the knowledge bases a person has registered and which one is active.

## Tokens you already hold

- **An access token and its refresh token**, from either grant: `SemiontSession.fromIssuedSession`. The session renews them as if it had signed in itself.
- **An access token and your own way to renew it**: `SemiontSession.fromHttp`, with the `refresh` you supply.

Each gives an `OpenedSession`, as the device grant does.
- **An access token alone**: `SemiontClient.fromHttp`. Nothing renews it, so this suits a program that finishes within the token's life.
