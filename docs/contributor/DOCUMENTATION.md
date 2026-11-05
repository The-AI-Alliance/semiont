# Changing documentation and SDK examples

[`docs/builder`](../builder/README.md) is what someone building on the SDK reads. Three rules keep it one coherent set:

- **Each kind of content has one home.** A concept a newcomer needs before any code goes in the [Introduction](../builder/INTRODUCTION.md) and nowhere else, so the mental model is taught in one place. A new recipe goes in the [Developer Guide](../builder/DEVELOPER-GUIDE.md), a new method in [Usage](../builder/Usage.md), a new design rationale in [Reactive model](../builder/REACTIVE-MODEL.md) or [State units](../builder/STATE-UNITS.md). A new cache behavior gets a B-number in [Cache semantics](../../protocol/contract/CACHE-SEMANTICS.md) and a test that cites it. A change that fits no one home is probably two changes.
- **Code fences are compile-checked.** Every `ts`, `tsx` and `typescript` fence in the builder docs, the skills included, is extracted and type-checked against the built packages by `docs/checks/doc-snippets/audit-doc-snippets.sh`, with a pass that catches an `await` on something that is not awaitable. Names a snippet does not define come from the prelude at [`docs/checks/doc-snippets/prelude.ts`](../checks/doc-snippets/prelude.ts) (the skills have their own, `prelude-skills.ts`): extend the prelude rather than adding boilerplate to a snippet. Mark a fence `ts sketch` only for pseudocode or a display-only shape. Exemptions are counted, and the count should hold or shrink.
- **Wire-level truth lives in [`protocol/contract/`](../../protocol/contract/README.md).** [TRANSPORT-CONTRACT.md](../../protocol/contract/TRANSPORT-CONTRACT.md) is what every transport honors, [TRANSPORT-HTTP.md](../../protocol/contract/TRANSPORT-HTTP.md) the wire over a gateway, and [EVENT-BUS.md](../../protocol/contract/EVENT-BUS.md) and [CHANNELS.md](../../protocol/contract/CHANNELS.md) the bus and its channels. The builder docs link there and do not restate wire format.

Before changing an SDK itself, read [Reactive model](../builder/REACTIVE-MODEL.md) and [State units](../builder/STATE-UNITS.md) for the constraints a change has to fit, [Cache semantics](../../protocol/contract/CACHE-SEMANTICS.md) before touching anything the cache backs, and the protocol docs before touching anything on the wire. The axiom and liveness harnesses in `@semiont/core/testing/axioms` are the executable half of those docs. The test doubles are at `@semiont/core/testing`, which needs no `fast-check`.

## Where to go for the rest

- [CONTRIBUTING.md](../../CONTRIBUTING.md): the pull-request process
- [Architecture](../architecture/README.md): the actors, the stores, and why the pieces are shaped as they are
- [Browser development](../../images/browser/docs/DEVELOPMENT.md): running the Browser from source against a stack
- [Adding a media type](../architecture/MEDIA-TYPES.md#adding-a-media-type): what a media type declares, and what each declaration costs
- [Protocol](../../protocol/contract/README.md): the flows, the bus, the transport contract
- [Builder docs](../builder/README.md): the SDKs, as someone building on them sees them
- [Operator docs](../operator/README.md): running what you built
