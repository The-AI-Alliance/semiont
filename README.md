# Semiont

[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)

**Semiont turns your documents into a knowledge base that people and AI agents build together, with everything it knows pinned to the passage it came from.** Beside each document, the knowledge base keeps what has been noticed in it: what it mentions, how it connects to the others, and what to make of it. Give your AI agent the Semiont SDK, and it can analyze the knowledge base on the spot, or build an application of your own that lasts. Either way, its answers can cite the passages they rest on, and be checked against them. Semiont is open source and can run entirely on your own machines.

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
