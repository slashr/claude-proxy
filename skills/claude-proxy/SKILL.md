---
name: claude-proxy
description: Route substantive Codex tasks through the locally authenticated Claude Code subscription while Codex remains the orchestrator, verifier, and user-facing writer. Use for multi-step investigation, repository work, implementations, debugging, code review, analysis, or whenever a Claude worker/subagent pass would materially help. Do not use for trivial self-contained answers, Codex-only connector/UI work, or when the user says not to use Claude.
---

# Claude Proxy

Codex owns the conversation, authorization, and validation. The installed `UserPromptSubmit` hook starts Claude asynchronously, and the bundled MCP App renders safe worker status inside the ChatGPT desktop conversation. Direct Codex shell commands remain blocked so Codex cannot silently substitute itself for Claude.

## Workflow

1. The prompt hook provides a Claude worker job ID. Call `claude_is_working` for that job ID. Each poll returns within four minutes so the host request cannot expire; if it returns `timed_out: true`, call it again. Related prompts resume the same Claude session when it is still available; stale sessions are retried from a fresh Claude session automatically.
2. Do not call a Codex shell tool before explaining or synthesizing the worker result. The direct-shell guard denies the call.
3. The inline card shows a redacted live transcript: Claude-visible text, thinking summaries, tool names, and bounded tool inputs/results. It must redact credentials and private keys before rendering.
4. The worker uses Claude's `bypassPermissions` mode so headless jobs and PR workflows do not stall on approval prompts. Read-mode jobs attach a worker-side `PreToolUse` guard that denies `Edit`, `Write`, and `NotebookEdit`, plus common destructive or mutating Bash commands. Write-mode jobs can make file changes clearly within the user's request; neither mode authorizes unrelated external-state changes.
5. For independent, noisy, or parallelizable work, Claude may delegate to its own subagents. Use one worker for small tasks; avoid agents for their own sake.
6. Independently assess material claims and clearly label any verification Codex could not complete without a local tool or connector.
7. Write the final response in Codex's voice. Include outcomes, proof, and remaining boundaries; do not quote raw Claude output.

## Runner

The prompt hook normally invokes Claude automatically. Use the bundled runner only to recover from a hook failure or for an explicitly directed retry:

```bash
/Users/akash/plugins/claude-proxy/scripts/run-claude-proxy \
  --mode read -- "Review the current branch against main. Return only evidenced findings."
```

Resume a worker session:

```bash
/Users/akash/plugins/claude-proxy/scripts/run-claude-proxy \
  --mode read --session-id '<session-id>' -- "Investigate the first finding further."
```

The runner emits Claude Code JSON, preserves sessions by default, and rejects permission-bypass modes. It does not make a Claude answer authoritative or bypass Codex safety requirements.
