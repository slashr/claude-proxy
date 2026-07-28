# Claude Proxy plugin

This repository is a Codex plugin marketplace containing the editable Claude
Proxy source at `plugins/claude-proxy`. It contains no Claude credentials,
installed-plugin cache, worker jobs, sessions, or activity logs.

## First-time setup in a macOS account

Run these commands as the account that uses the ChatGPT desktop app. The
example below assumes this repository was cloned to `~/Code/claude-plugin`.

The public marketplace is [github.com/slashr/claude-proxy](https://github.com/slashr/claude-proxy).
Add it directly from GitHub, then install the plugin from its `slashr`
marketplace:

```bash
codex plugin marketplace add slashr/claude-proxy --ref main
codex plugin add claude-proxy@slashr
```

If this account previously used `claude-proxy@personal`, remove it first so
only one copy installs hooks:

```bash
codex plugin remove claude-proxy@personal
```

Quit and reopen ChatGPT. Open `/hooks` once and trust the plugin hooks.
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

## Worker permissions

Claude workers run headlessly with Claude Auto Mode in both read and write
modes. Auto Mode's classifier remains responsible for deciding which actions
are allowed; the worker no longer enables `bypassPermissions` or
`--dangerously-skip-permissions`. Worker polling is bounded below the desktop
host timeout, stale Claude session IDs are retried from a fresh session, and
unexpected worker exits finalize as failed jobs instead of remaining
permanently running.

## Stopping work

Use the ChatGPT desktop Stop button while a Claude-backed task is running to
cancel its active worker. The activity state becomes `cancelled`, polling ends,
and the worker's launchd service is unloaded so it does not restart. A Stop
hook is part of this behavior, so trust the updated hook definition after an
upgrade.

## Updating

Pull the repository, make the desired source change under
`plugins/claude-proxy`, validate it, cache-bust, push it, refresh the Git
marketplace, and reinstall:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py ~/Code/claude-plugin/plugins/claude-proxy
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py ~/Code/claude-plugin/plugins/claude-proxy
git -C ~/Code/claude-plugin push
codex plugin marketplace upgrade slashr
codex plugin add claude-proxy@slashr
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

Push it to the public repository when sharing the source across macOS
accounts. Each account installs the Git marketplace and authenticates its own
Claude Code CLI session.
