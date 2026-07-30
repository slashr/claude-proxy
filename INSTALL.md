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

## Voice task exclusion

GPT-Live wraps delegated work with the Voice transcript and rotates the Codex
task session for each delegation. To keep a whole voice chat in Codex, say this
exact sentence as its own turn:

```text
Use Codex only for this chat
```

The plugin records that choice in the Voice task session. This keeps later
Voice work Codex-only even after GPT-Live no longer includes the opening command
in its transcript. Say one of these exact commands as its own turn to resume
Claude routing:

```text
Resume Claude Proxy
```

```text
Use Claude again
```

Typed tasks can use `/codex thread` for a session-scoped Codex-only mode. The
ordinary `/codex` marker remains a one-prompt bypass.

## Worker permissions

Claude workers run headlessly with Claude Auto Mode in both read and write
modes. Auto Mode's classifier remains responsible for deciding which actions
are allowed; the worker no longer enables `bypassPermissions` or
`--dangerously-skip-permissions`. Worker polling is bounded below the desktop
host timeout, stale Claude session IDs are retried from a fresh session, and
unexpected worker exits finalize as failed jobs instead of remaining
permanently running. Follow-ups in the same Codex task and workspace resume
their Claude conversation, so short replies such as `pr?` keep their task
context. Separate Codex tasks are isolated. Say `fresh Claude` or `new Claude
task` to intentionally start a clean Claude conversation.

When a fresh conversation is necessary, the plugin supplies a bounded handoff
packet with the prior user request, prior worker result, workspace, and Git
branch/HEAD. It does not forward private Codex reasoning or raw tool
transcripts.

While a worker runs, its job record is refreshed every five seconds and macOS
idle sleep is prevented with `caffeinate`; closing the laptop lid or forcing
sleep can still suspend it. Workers have no runtime budget and are never
terminated for taking a long time. Polls wait two minutes by default, with a
one-minute minimum, so long work does not generate high-frequency status churn.
The five-second heartbeat is used for liveness: a worker whose heartbeat has
been silent for five minutes and whose process is gone is unloaded from launchd
and recorded as failed, so a job killed outright cannot be polled forever. A
stale per-task lock is recovered by the same rule. Transient provider overloads
or dropped mid-response connections are retried up to three times with 20, 40,
and 80 second backoff. Workers launch fresh with a bounded, workspace-scoped
Codex handoff rather than resuming Claude's opaque prior conversation. They
also launch with an empty Claude MCP configuration, which avoids unrelated
user-configured MCP servers blocking headless startup.
A separate startup watchdog retries a Claude CLI that emits no first stream
event within two and a half minutes; it stops watching as soon as any activity
arrives, so it never limits legitimate long-running work. A CLI that ignores
its graceful termination is force-stopped after five seconds so the retry can
proceed.

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
