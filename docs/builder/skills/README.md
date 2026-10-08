# Agent skills

A skill is a definition an AI coding assistant loads to do one job with Semiont: a `SKILL.md` that says when the skill applies, what to ask the user, and the script to write. Each one here stands alone, so copy the directories you want into your assistant's skills directory (`.claude/skills/` for Claude Code), or into a knowledge base's own repository beside the skills written for its corpus.

The scripts are TypeScript on `@semiont/sdk`, and every code fence in them is type-checked against the built SDK with the rest of the builder docs. [`semiont-worker`](semiont-worker/SKILL.md) shows its worker in Rust and in Python too, and each of those blocks is, word for word, a program its SDK's own tests compile and run. See [the SDK guide](../Usage.md) for the calls they use.

## The layers

A knowledge base is built up in layers, each one made from the layers under it. The skills follow them:

| Layer | What it holds | Skill |
|---|---|---|
| 1. Primary material | The documents: the ground truth everything else points back to | [`semiont-ingest`](semiont-ingest/SKILL.md) |
| 2. Annotations | What someone marked in a document: a highlight, a comment, an assessment, a tag, a reference to an entity | [`semiont-highlight`](semiont-highlight/SKILL.md), [`semiont-comment`](semiont-comment/SKILL.md), [`semiont-assess`](semiont-assess/SKILL.md), [`semiont-tag`](semiont-tag/SKILL.md) |
| 3. Canonical nodes | One resource for each entity, which every mention of that entity is bound to | [`semiont-wiki`](semiont-wiki/SKILL.md) |
| 4. Edges | How the nodes relate: who is whose parent, which party is the counterparty | [`semiont-relate`](semiont-relate/SKILL.md) |
| 5. Aggregates | Resources composed from the layers below, written to be read: a report, a timeline, a memo | [`semiont-aggregate`](semiont-aggregate/SKILL.md) |

In verbs: [yield](../../protocol/flows/YIELD.md) the documents, [mark](../../protocol/flows/MARK.md) them, [gather](../../protocol/flows/GATHER.md), [match](../../protocol/flows/MATCH.md) and [bind](../../protocol/flows/BIND.md) each mention to its node, and yield again what the knowledge base can now say. [Frame](../../protocol/flows/FRAME.md) declares the vocabulary every layer uses.

## Running Semiont, and scripts that stay up

| Skill | For |
|---|---|
| [`semiont-local`](semiont-local/SKILL.md) | Installing the launcher and running a knowledge base on your own machine |
| [`semiont-session`](semiont-session/SKILL.md) | A script that keeps running: token renewal, bus subscriptions, shutdown |
| [`semiont-worker`](semiont-worker/SKILL.md) | A daemon that claims jobs from the queue and reports their progress |
| [`semiont-tour`](semiont-tour/SKILL.md) | Driving a participant's Browser from a script: a guided tour of a knowledge base |
