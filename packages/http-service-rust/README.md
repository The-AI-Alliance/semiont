# semiont-http-service

What Semiont's Rust services that serve HTTP share.

**Not published.** It is a crate of this workspace, built into the
[gateway](../../apps/gateway/README.md). To use Semiont from Rust, the crate
you want is [`semiont`](../sdk-rust/README.md).

| Item | What it is |
|---|---|
| `serve` | An accept loop whose connections the service can close from its side (`ConnectionAbort`), bounded by how many may be open at once. |
| `bearer_token` | The token an `Authorization: Bearer …` header carries. |
| `IssuerVerifier` | Tokens of the knowledge base's trusted issuer, verified against the keys it publishes: discovery read once, the key set fetched when it is due, one fetch at a time under a deadline. The service states the three timings (`KeyTimings`). |

What a response carries, how an error reads and who a token names are each
service's own: the gateway's are in
[its `http.rs`](../../apps/gateway/src/http.rs).
