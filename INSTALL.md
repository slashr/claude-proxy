# Claude Proxy plugin

This repository is the editable source for the local Claude Proxy plugin. It
contains no Claude credentials, installed-plugin cache, worker jobs, sessions,
or activity logs.

## First-time setup in a macOS account

Run these commands as the account that uses the ChatGPT desktop app. The
example below assumes this repository was cloned to `~/Code/claude-plugin`.

```bash
mkdir -p ~/plugins
ln -sfn ~/Code/claude-plugin ~/plugins/claude-proxy
```

The default personal marketplace resolves `./plugins/claude-proxy` from the
home directory. Create or update `~/.agents/plugins/marketplace.json` with the
following plugin entry. Preserve any other marketplace entries already there.

```json
{
  "name": "claude-proxy",
  "source": {
    "source": "local",
    "path": "./plugins/claude-proxy"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Productivity"
}
```

Then install it:

```bash
codex plugin add claude-proxy@personal
```

Quit and reopen ChatGPT. Open `/hooks` once and trust the two plugin hooks.
Every ordinary substantive prompt then starts a Claude worker. The account must
also have Claude Code installed and logged in to the Claude subscription it
should use.

## `/codex` bypass

Start a prompt with `/codex` to bypass Claude for that prompt only:

```text
/codex explain this one-line shell command
```

The marker is intentionally per-prompt. The next normal prompt returns to
Claude Proxy routing automatically. Use it for Codex-only UI/connectors or a
small task where delegating to Claude is unnecessary.

## Updating

Pull the repository, make the desired source change, validate it, cache-bust,
and reinstall:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py ~/Code/claude-plugin
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py ~/Code/claude-plugin
codex plugin add claude-proxy@personal
```

Quit and reopen ChatGPT after every reinstall because the app keeps the prior
versioned plugin cache path in memory. If hook definitions themselves changed,
open `/hooks` and trust the updated definitions; ordinary source-only updates
do not require re-trust.

## Repository ownership

Initialize and commit this repository as the account owner:

```bash
cd ~/Code/claude-plugin
git init
git add .
git commit -m "Add Claude Proxy plugin"
```

Push it to a private repository before using it across personal accounts.
