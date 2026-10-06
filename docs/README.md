# Semiont documentation

The docs are organized by who is reading. Find yourself below. A reader may
be a person or an AI agent: nothing here is written for one and not the other.

| You are | You want to | Start here |
|---|---|---|
| An **analyst** | Work in a knowledge base: read, annotate, link, and review what agents propose | [analyst/](analyst/README.md) |
| A **builder** | Build an application, a script, a daemon or an agent on the SDK | [builder/](builder/README.md) |
| An **operator** | Run a knowledge base: install, configure, deploy, secure, observe, back up | [operator/](operator/README.md) |
| A **contributor** | Change Semiont itself | [contributor/](contributor/README.md) |

Three things are for every reader:

- **[architecture/](architecture/README.md)** is how Semiont works inside: the
  actor model, the knowledge system, anchoring, and the package layers.
- **[protocol/](protocol/README.md)** is the contract: the eight verbs, the
  event bus, and what every SDK and transport is held to. Read it to implement
  an SDK, a transport or a service; the other docs point to it for the details.
- **[KNOWLEDGE-BASES.md](KNOWLEDGE-BASES.md)** is the catalog of demo and
  community knowledge bases.

## Analyst

You work in a knowledge base through the Semiont Browser.

- [Working in the Browser](analyst/FEATURES.md): finding and adding resources, annotating, references, generation
- [Getting the Browser and signing in](analyst/README.md#get-the-browser), as a container or the desktop app
- [Keyboard shortcuts](analyst/KEYBOARD-NAV.md) and [accessibility](analyst/ACCESSIBILITY.md)
- [A knowledge base to try](KNOWLEDGE-BASES.md)

## Builder

You write code against a knowledge base, in TypeScript, Rust or Python.

- [Quick Start](builder/QUICK-START.md): a knowledge base running on your machine, to build against
- [Building with the Semiont SDK](builder/README.md): install, where the SDK goes, the guides, the reference
- [Embedding the React components](builder/README.md#react-embedding-semiontreact-ui)
- [Agent skills](builder/skills/), one ready-made definition per task

## Operator

You run a knowledge base, on your own machine or for others.

- [Quick Start](builder/QUICK-START.md): install the launcher, create a knowledge base, start it
- [Running a local stack](operator/LOCAL-SEMIONT.md), and [the launcher's manual](../apps/launcher/README.md) for every command and setting
- [Deploying Semiont](operator/administration/DEPLOYMENT.md): on your machine, on a hosted machine, or on a platform of your own
- [The service catalog](operator/services/OVERVIEW.md) and [container topology](operator/CONTAINER-TOPOLOGY.md): what a stack is made of
- [Administration](operator/administration/): configuration, authentication, security, observability, backup, scaling, troubleshooting
- [What is in a knowledge base](operator/PROJECT-LAYOUT.md)

## Contributor

You change Semiont itself.

- [CONTRIBUTING.md](../CONTRIBUTING.md): the branch and pull-request workflow
- [Orientation](contributor/README.md): where the code lives. Then [local development](contributor/LOCAL-DEVELOPMENT.md), [testing](contributor/TESTING.md), [dependencies](contributor/DEPENDENCIES.md) and [releasing](contributor/RELEASE.md)
- [Browser development](../apps/browser/docs/DEVELOPMENT.md): running the Browser from source against a stack
- [How Semiont works inside](architecture/README.md): the actor model, the knowledge system, anchoring, media types, the package layers
- [The packages](../packages/README.md): each package's internals are documented in its own directory
