# Semiont

[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)

**Semiont turns your documents into a knowledge base that people and AI agents build together, with everything it knows pinned to the passage it came from.** Ask about a passage, and it gathers what to read with it: the documents it connects to, similar passages, and what has been noted about them. Hand it AI work, such as annotating or drafting, and the work becomes a tracked job that any worker can take, yours included. What comes back is on the record: who asked, who did the work, and what each claim rests on.

Your AI agent can do all of this through the SDK, in any of its languages, to explore on the spot or to build an application that lasts. Semiont is open source and can run entirely on your own machines.

![The Semiont browser: a document with its references highlighted, and a panel of assessments beside it](website/assets/images/semiont-2026-03-10.png)

## Quick Start

```bash
brew install the-ai-alliance/semiont/semiont
```

Then follow the **[Quick Start](docs/builder/QUICK-START.md)**: create a knowledge base, start it, sign in, annotate your first document, and work in it from an AI application.

## Documentation

- **[Analyst](docs/analyst/README.md)**: work in a knowledge base, annotating, linking, and reviewing what agents propose. A [demo knowledge base](docs/KNOWLEDGE-BASES.md) comes with content to start on.
- **[Operator](docs/operator/README.md)**: run a knowledge base, for yourself or for others.
- **[Builder](docs/builder/README.md)**: build an application, a script or an agent on the SDK, in TypeScript, Rust, Python or Go, and customize annotation and generation, down to a worker running your own logic or model.
- **[Contributor](docs/contributor/README.md)**: change Semiont itself.

## 📜 License

Apache 2.0 - See [LICENSE](LICENSE) for details.
