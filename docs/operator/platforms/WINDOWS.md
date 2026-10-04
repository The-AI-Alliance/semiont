# Semiont on Windows

A knowledge-base stack on Windows is Linux containers under
[Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/), started by the
[`semiont` launcher](../../../apps/launcher/README.md). The launcher runs in one of two places:

- **inside WSL2**, as the Linux build — the same binary a Linux machine runs;
- **on Windows itself**, as `semiont.exe`.

Either way the Browser opens from Windows at `http://localhost:3000`.

## What you need

- Windows 10 or 11, 64-bit, with [WSL2](https://learn.microsoft.com/windows/wsl/install)
  (`wsl --install` from an administrator PowerShell).
- Docker Desktop on its WSL2 backend, running.
- `git`.

## Inside WSL2

1. **Give the distribution Docker.** In Docker Desktop: *Settings → Resources → WSL integration*,
   and switch on the distribution you use. `docker version` then answers inside WSL.

2. **Install the launcher inside WSL.** With [Homebrew](https://brew.sh):

   ```bash
   brew install the-ai-alliance/semiont/semiont
   ```

   Or from the [GitHub Release](https://github.com/The-AI-Alliance/semiont/releases), with the
   [GitHub CLI](https://cli.github.com) — `amd64` here; `arm64` on an Arm machine:

   ```bash
   gh release download --repo The-AI-Alliance/semiont --pattern 'semiont_*_linux_amd64.tar.gz'
   tar -xzf semiont_*_linux_amd64.tar.gz semiont
   sudo install semiont /usr/local/bin/semiont
   ```

3. **Clone the knowledge base inside WSL's own filesystem** — under your WSL home, not under
   `/mnt/c`. Containers mount the clone, and a mount from the Windows drive is slow and does not
   keep Linux file modes.

   ```bash
   cd ~
   git clone https://github.com/The-AI-Alliance/gutenberg-kb.git
   cd gutenberg-kb
   semiont start
   ```

4. **Open the Browser from Windows** at `http://localhost:3000`, and enter `http://localhost:4000`
   as the knowledge base URL. WSL2 forwards `localhost` to Windows.

5. **Sign in a terminal** with `semiont login`. It prints an address and a code; open the address
   in your Windows browser.

Everything else is as [Local Semiont](../LOCAL-SEMIONT.md) describes it: `semiont status`,
`semiont logs`, `semiont stop`. The launcher's own files are where Linux keeps them, inside WSL:
`~/.local/state/semiont` and `~/.local/share/semiont`.

## On Windows itself

1. **Install the launcher.** Download `semiont_<version>_windows_amd64.zip` (or `_arm64`) from the
   [GitHub Release](https://github.com/The-AI-Alliance/semiont/releases), unzip it, and put
   `semiont.exe` in a directory on your `PATH`. From PowerShell, with the GitHub CLI:

   ```powershell
   gh release download --repo The-AI-Alliance/semiont --pattern 'semiont_*_windows_amd64.zip'
   Expand-Archive semiont_*_windows_amd64.zip -DestinationPath "$env:LOCALAPPDATA\Programs\semiont"
   ```

   Then add `%LOCALAPPDATA%\Programs\semiont` to your `PATH`. `semiont version` answers from a new
   terminal.

2. **Clone the knowledge base with its bytes as committed.** A knowledge base's events and
   resources are addressed by their content, so Git must not rewrite their line endings:

   ```powershell
   git clone -c core.autocrlf=false https://github.com/The-AI-Alliance/gutenberg-kb.git
   cd gutenberg-kb
   semiont start
   ```

3. **Open the Browser** at `http://localhost:3000`, and enter `http://localhost:4000` as the
   knowledge base URL.

### Where the launcher keeps its files

| What | Where |
|---|---|
| The stack record, the registry of knowledge bases, sign-ins (`tokens.json`) | `%LOCALAPPDATA%\semiont` |
| Each knowledge base's stores and kept secrets | `%LOCALAPPDATA%\semiont\roots\<knowledge base>` |
| The launcher's log | `%LOCALAPPDATA%\semiont\logs` |
| Configs staged for a running stack | `%TEMP%\semiont-config.*` |

Each knowledge base's directory under `roots`, its kept secrets, `tokens.json` and each staging
directory carry an access list naming your account, the system and the administrators, and
inherit nothing from the directory above them.

`tokens.json` is the sign-in store every Semiont SDK reads: a program built on the SDK and run by
the same Windows account uses the sign-in `semiont login` made.

### What it needs on `PATH`

`docker`, `git`, and Windows' own `netstat` and `tasklist`, which is how the launcher names what
holds a port a stack needs. A knowledge base placed in a GitHub Codespace needs `gh` as well.
