---
name: semiont-local
description: Install and run a Semiont knowledge base locally with the semiont launcher — no repo clone, no npm, no Node.js
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user get Semiont running on their own machine. The `semiont` launcher is a single static binary that drives their container runtime and pulls the published service images. It needs no source checkout and no Node.js.

## What they need

- **A container runtime**: Apple Container, Docker or Podman. The launcher detects which. Check with `container --version`, `docker --version` or `podman --version`.
- **The launcher**: from Homebrew on macOS and Linux. On Windows, the [GitHub Release](https://github.com/The-AI-Alliance/semiont/releases) carries a zip holding `semiont.exe`; see [Semiont on Windows](../../../operator/platforms/WINDOWS.md).
- **Inference**: an [Anthropic](https://www.anthropic.com/) key, or [Ollama](https://ollama.com/) for a model that runs on the machine and needs no key.

## Fastest path

```bash
brew install the-ai-alliance/semiont/semiont
```

With Anthropic, register where the key comes from. The launcher stores the pointer, never the key, and reads it at every start. Exporting `ANTHROPIC_API_KEY` in the shell works too, and wins over a registered pointer.

```bash
semiont settings secret set ANTHROPIC_API_KEY op://YourVaultName/Anthropic/credential
```

Create a knowledge base in a new directory. `--domain` is its permanent identity, stamped into its event log, and has no default. Use `--inference ollama` for the local model.

```bash
mkdir my-kb && cd my-kb
semiont init --yes --domain example.com:my-kb --inference anthropic
```

Start the stack, then create a person who can sign in:

```bash
semiont start
```

```bash
semiont useradd --email you@example.com
```

`useradd` prompts for the password. Open **http://localhost:3000**: the Browser lists the knowledge bases the launcher runs, and signing in happens at the knowledge base's identity provider.

To run a knowledge base that already exists, clone it and run `semiont start` from inside it.

For the launcher's own verbs (`semiont browse`, `semiont mark`, `semiont yield --upload`), sign the launcher in once:

```bash
semiont login
```

## Common operations

Run each from the knowledge base's directory.

| Command | What it does |
|---|---|
| `semiont status` | Each service's container state and health |
| `semiont logs` | Follow the services' logs |
| `semiont logs --service gateway` | One service's log |
| `semiont stop` | Take the stack down; its data stays |
| `semiont start --service gateway` | Restart one service |
| `semiont start --dry-run` | Print what a start would run, and run nothing |
| `semiont clean` | Delete the stack's stores; the knowledge base's own directory is untouched |
| `semiont settings` | Every setting the launcher keeps, and where each came from |

`semiont --help` lists every verb, and `semiont <verb> --help` its options.

## Where things are

| Address | What answers |
|---|---|
| http://localhost:3000 | The Browser, one for every knowledge base on the machine |
| http://localhost:4000 | The knowledge base's gateway, which scripts and SDKs connect to |

| Path in the knowledge base | Contents |
|---|---|
| `.semiont/config` | The knowledge base's name and its permanent `did:web` identity (committed) |
| `.semiont/events/` | The event log, which is the record of the knowledge base (committed) |
| `.semiont/semiontconfig/<name>.toml` | A stack configuration: inference, graph, vectors, identity (committed; `--config` selects one) |

Everything derived from the event log (the database, the graph, the vectors, the job queue) is kept outside the knowledge base, in a directory the launcher keeps for it. `semiont status --verbose` lists those directories and their sizes. The secrets the launcher generates for a stack are kept there too, or in 1Password when `semiont settings secret-store` names a vault.

## Guidance for the AI assistant

- **Check what they need first.** The usual failures are a container runtime that is not running, and an inference key the start cannot read.
- **`semiont status` is the first diagnostic.** It names the service that is unhealthy; `semiont logs --service <name>` says why.
- **Configuration is in the knowledge base**, at `.semiont/semiontconfig/<name>.toml`. `semiont start --list-configs` shows the ones it has. Inside a container the file is mounted at `~/.semiontconfig`; there is no such file on the host to edit.
- **A change of configuration takes a restart**: `semiont stop`, then `semiont start`.
- **The knowledge base is a git repository.** Its resources, `.semiont/config` and `.semiont/events/` are committed. Secrets never are.
- **`semiont` comes from Homebrew or the GitHub Release, never from npm.** If `which semiont` resolves to an npm install, that copy is shadowing the launcher: uninstall it.
- **Going further.** [Running a local stack](../../../operator/LOCAL-SEMIONT.md) covers ports, the Browser and local-network access; [Configuration](../../../operator/administration/CONFIGURATION.md) covers the config file; [Troubleshooting](../../../operator/administration/TROUBLESHOOTING.md) covers what goes wrong.
