# Working in a knowledge base

An analyst works in a knowledge base: reads, annotates, links, and reviews what agents propose. An analyst may be a person or an AI agent. People do this work in the Semiont Browser, which these pages cover.

- **[FEATURES.md](FEATURES.md)**: working in the Browser, from finding a resource to annotating, linking and generating
- **[KEYBOARD-NAV.md](KEYBOARD-NAV.md)**: the keyboard shortcuts
- **[ACCESSIBILITY.md](ACCESSIBILITY.md)**: what the Browser provides for assistive technology

## Get the Browser

There are three ways to have it.

**With a knowledge base you run.** `semiont start` starts the Browser with the rest of the stack, at `http://localhost:3000`. The [Quick Start](../../README.md#quick-start) covers this.

**On its own, as a container.** To work in a knowledge base someone else runs, start only the Browser (substitute `docker` or `podman` for `container` as needed):

```bash
container run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-browser:latest
```

The image serves static files and holds no knowledge-base configuration. You connect to knowledge bases from the page.

**As a desktop app.** Semiont ships a native app for macOS and Linux, with no container runtime to install. Download it from the [GitHub releases](https://github.com/The-AI-Alliance/semiont/releases); install notes, including the macOS Gatekeeper step, are in [apps/desktop/README.md](../../apps/desktop/README.md).

## Connect and sign in

Open `http://localhost:3000`, or the desktop app, and open the **Knowledge Bases** panel.

1. **Choose a knowledge base.** Those the launcher runs on this machine are listed under **Found on this machine**. For any other, choose **Add knowledge base** and enter its protocol, host and port. A gateway's default port is `4000`.
2. **Sign in.** Signing in happens at the knowledge base's identity provider, not in the Browser: you are handed to its page and back. It asks for your name the first time.

Whoever runs the knowledge base creates your account, with `semiont useradd`.

The panel shows each knowledge base's status: **Connected**, **Session expired**, **Signed out** or **Unreachable**. You can register several and switch between them.

## If something is in the way

- **The Browser container cannot reach a knowledge base on your machine.** The container runtime needs local network access: see [Local network access](../operator/LOCAL-SEMIONT.md#local-network-access).
- **You want to verify the image before running it.** See [Supply-chain verification](../operator/administration/IMAGES.md#supply-chain-verification).
- **You need the Browser's logs.** `semiont logs --service browser` from the knowledge base's directory, or your container engine's `logs` command for a Browser you started yourself.

How the Browser is built is in [apps/browser/docs](../../apps/browser/docs/).
