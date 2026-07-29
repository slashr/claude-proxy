"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
const SERVER_NAME = "claude-proxy-activity";
const SERVER_VERSION = manifest.version;
const WIDGET_URI = `ui://claude-proxy/activity-${encodeURIComponent(SERVER_VERSION)}.html`;
const WIDGET_MIME = "text/html;profile=mcp-app";
const PLUGIN_NAME = typeof manifest.name === "string" && manifest.name ? manifest.name : path.basename(PLUGIN_ROOT);
const MARKETPLACE = path.basename(path.resolve(PLUGIN_ROOT, "..", ".."));
const DATA_DIR = process.env.PLUGIN_DATA
  || process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), ".codex", "plugins", "data", `${PLUGIN_NAME}-${MARKETPLACE}`);
const JOB_DIR = path.join(DATA_DIR, "claude-jobs");
const PROGRESS_RELAY_MIN_INTERVAL_MS = 3000;
// Workers have no runtime budget: polling continues for as long as the work
// takes. The only backstop is liveness, so a worker that was killed outright
// cannot be polled forever. The worker heartbeats every five seconds, so a
// silence this long means it is gone, and the PID check keeps a machine that
// slept mid-job from being mistaken for a dead one.
const WORKER_HEARTBEAT_TIMEOUT_SECONDS = 300;
const TOOL_POLL_DEFAULT_WAIT_SECONDS = 120;
const TOOL_POLL_MAX_WAIT_SECONDS = 240;
const lastProgressRelay = new Map();

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function jobPath(jobId) {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9-]+$/.test(jobId)) throw new Error("invalid worker job id");
  return path.join(JOB_DIR, `${jobId}.json`);
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

function workerProcessAlive(job) {
  const pid = Number(job?.worker_pid);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but belongs to another user, which is still
    // proof of life; only ESRCH says nothing is there.
    return error.code === "EPERM";
  }
}

// A worker is only declared dead when its heartbeat has gone quiet *and* its
// process is gone. A queued job that never launched has no PID, so it fails
// once the same silence elapses.
function workerIsDead(job) {
  if (!job || !["queued", "running"].includes(job.state)) return false;
  const lastSign = Number(job.updated_at || job.started_at);
  if (!Number.isInteger(lastSign)) return false;
  const silentFor = Math.floor(Date.now() / 1000) - lastSign;
  return silentFor >= WORKER_HEARTBEAT_TIMEOUT_SECONDS && !workerProcessAlive(job);
}

function finalizeDeadWorker(jobId) {
  const file = jobPath(jobId);
  const job = readJson(file);
  if (!workerIsDead(job)) return job;
  const now = Math.floor(Date.now() / 1000);
  const dead = {
    ...job,
    state: "failed",
    detail: "Claude worker stopped responding and is no longer running.",
    result: "",
    updated_at: now,
    finished_at: now,
    exit_code: 124,
  };
  writeJsonAtomic(file, dead);
  if (typeof job.launch_label === "string" && /^[A-Za-z0-9.-]+$/.test(job.launch_label)) {
    const userId = String(process.getuid?.() ?? "");
    for (const target of [`gui/${userId}/${job.launch_label}`, `user/${userId}/${job.launch_label}`]) {
      const result = spawnSync("/bin/launchctl", ["bootout", target], { stdio: "ignore" });
      if (result.status === 0) break;
    }
  }
  return dead;
}

function safeText(value, limit = 80) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function redact(value) {
  return String(value || "")
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:Bearer\s+)?(?:ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|xox[a-zA-Z]-[A-Za-z0-9-]+|tskey-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, "[redacted credential]")
    .replace(/\b(https?:\/\/)[^\s\/@:]+:[^\s\/@]+@/gi, "$1[redacted credentials]@")
    .replace(/\b(ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|password|token|access-token|client-certificate-data|client-key-data|certificate-authority-data)\s*[=:]\s*[^\s'\"]+/gi, "$1=[redacted]");
}

function preview(value, limit) {
  let text;
  if (typeof value === "string") text = value;
  else { try { text = JSON.stringify(value); } catch { text = String(value || ""); } }
  text = redact(text).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function activityDetails(activityFile) {
  const counts = new Map();
  const toolEvents = new Map();
  const timeline = [];
  let events = 0;
  let retries = 0;
  let retryError = null;
  let initialized = false;
  let hasResult = false;
  let assistantUpdates = 0;
  let latestAssistantMessage = null;
  const transcript = [];
  try {
    for (const line of fs.readFileSync(activityFile, "utf8").split("\n")) {
      if (!line) continue;
      events += 1;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "system" && event.subtype === "api_retry") {
        retries += 1;
        retryError = safeText(event.error, 140) || retryError;
        timeline.push({ kind: "retry", label: "Retrying Claude provider", status: "retrying" });
      }
      if (event.type === "system" && event.subtype === "init") initialized = true;
      if (event.type === "result") hasResult = true;
      for (const block of event?.message?.content || []) {
        if (event.type === "assistant" && block?.type === "thinking") {
          const text = preview(block.thinking || block.text, 900);
          if (text) transcript.push({ kind: "thinking", text });
        }
        if (event.type === "assistant" && block?.type === "text") {
          const text = preview(block.text, 1600);
          if (text) {
            assistantUpdates += 1;
            latestAssistantMessage = text;
            transcript.push({ kind: "assistant", text });
          }
        }
        if (event.type === "assistant" && block?.type === "tool_use" && typeof block.name === "string") {
          const name = safeText(block.name);
          if (!name) continue;
          counts.set(name, (counts.get(name) || 0) + 1);
          const item = { kind: "tool", label: name, status: "running" };
          timeline.push(item);
          const transcriptItem = { kind: "tool", label: name, input: preview(block.input, 500), output: "", status: "running" };
          transcript.push(transcriptItem);
          if (typeof block.id === "string") toolEvents.set(block.id, { item, transcriptItem });
        }
        if (event.type === "user" && block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          const tracked = toolEvents.get(block.tool_use_id);
          if (tracked) {
            const output = preview(block.content, 1100);
            const readOnlyGuard = block.is_error && /Read-mode Claude workers cannot/.test(output);
            tracked.item.status = readOnlyGuard ? "guarded" : block.is_error ? "failed" : "completed";
            tracked.transcriptItem.status = tracked.item.status;
            tracked.transcriptItem.output = output;
          }
        }
      }
      if (event.type === "result") {
        const text = preview(event.result, 1400);
        if (text) transcript.push({ kind: "result", text });
      }
    }
  } catch {}
  const visibleTimeline = timeline.slice(-12).map(({ kind, label, status }) => ({ kind, label, status }));
  const currentTool = [...visibleTimeline].reverse().find(item => item.kind === "tool" && item.status === "running");
  const failedTool = [...visibleTimeline].reverse().find(item => item.kind === "tool" && item.status === "failed");
  const guardedTool = [...visibleTimeline].reverse().find(item => item.kind === "tool" && item.status === "guarded");
  return {
    event_count: events,
    assistant_update_count: assistantUpdates,
    latest_assistant_message: latestAssistantMessage,
    retries,
    retry_error: retryError,
    tool_calls: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })),
    timeline: visibleTimeline,
    transcript: transcript.slice(-30),
    phase: failedTool ? `${failedTool.label} needs attention` : currentTool ? `Running ${currentTool.label}` : guardedTool ? "Continuing in read-only mode" : hasResult ? "Preparing final answer" : initialized ? "Preparing work" : "Starting Claude worker",
  };
}

function snapshot(jobId, rich = false) {
  const resolvedJobPath = jobPath(jobId);
  const job = readJson(resolvedJobPath);
  if (!job) throw new Error(`worker job was not found: ${resolvedJobPath}`);
  const activity = activityDetails(job.activity_file || path.join(DATA_DIR, "claude-activity", `${jobId}.jsonl`));
  const state = job.state || "queued";
  const terminal = ["completed", "failed", "cancelled"].includes(state);
  const elapsedReference = terminal ? (job.updated_at || job.started_at) : Math.floor(Date.now() / 1000);
  const snapshot = {
    job_id: job.job_id,
    state,
    detail: job.detail || "Claude worker is queued.",
    phase: state === "completed" ? "Work completed" : state === "failed" ? "Worker needs attention" : state === "cancelled" ? "Work cancelled" : activity.phase,
    started_at: job.started_at || null,
    updated_at: job.updated_at || job.started_at || null,
    elapsed_seconds: job.started_at ? Math.max(0, elapsedReference - job.started_at) : null,
    event_count: activity.event_count,
    assistant_update_count: activity.assistant_update_count,
    progress_message: activity.latest_assistant_message,
    retries: activity.retries,
    retry_error: activity.retry_error,
    tool_calls: activity.tool_calls,
    timeline: activity.timeline,
    tool_summary: job.tool_summary || (activity.tool_calls.length ? activity.tool_calls.map(({ name, count }) => `${name}: ${count}`).join(", ") : "No Claude tool calls reported."),
  };
  if (rich) snapshot.transcript = activity.transcript;
  return snapshot;
}

function widgetUri(jobId) {
  return jobId ? `${WIDGET_URI}?job_id=${encodeURIComponent(jobId)}` : WIDGET_URI;
}

function widgetHtml(resourceUri = WIDGET_URI) {
  return `
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  #claude-worker-card { border: 1px solid color-mix(in srgb, #8b5cf6 32%, currentColor 12%); border-radius: 16px; max-width: 700px; overflow: hidden; background: linear-gradient(135deg, color-mix(in srgb, #7c3aed 12%, transparent), transparent 46%); }
  .content { padding: 16px; }
  .head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:700; letter-spacing:-.01em; }
  .mark { display:grid; place-items:center; width:25px; height:25px; border-radius:8px; background:#7c3aed; color:white; font-size:15px; }
  .state { border-radius:999px; padding:4px 10px; font-size:12px; font-weight:650; text-transform:capitalize; background:color-mix(in srgb, #7c3aed 18%, transparent); }
  .state.completed { background:color-mix(in srgb, #16a34a 20%, transparent); color:color-mix(in srgb, #16a34a 80%, currentColor); }
  .state.failed { background:color-mix(in srgb, #dc2626 18%, transparent); color:color-mix(in srgb, #dc2626 82%, currentColor); }
  .state.cancelled { background:color-mix(in srgb, #d97706 20%, transparent); color:color-mix(in srgb, #d97706 82%, currentColor); }
  .phase { margin:14px 0 3px; font-size:15px; font-weight:620; }
  .detail { margin:0; opacity:.7; font-size:13px; }
  .stats { display:flex; gap:8px; flex-wrap:wrap; margin-top:13px; }
  .stat { border:1px solid color-mix(in srgb, currentColor 13%, transparent); border-radius:8px; padding:5px 8px; font-size:12px; opacity:.82; }
  .timeline { list-style:none; padding:13px 0 0; margin:14px 0 0; border-top:1px solid color-mix(in srgb, currentColor 12%, transparent); display:grid; gap:8px; }
  .timeline-item { display:grid; grid-template-columns:12px minmax(0,1fr) auto; align-items:center; gap:8px; font-size:13px; }
  .dot { width:8px; height:8px; border-radius:50%; background:color-mix(in srgb, currentColor 30%, transparent); }
  .dot.running { background:#8b5cf6; box-shadow:0 0 0 3px color-mix(in srgb, #8b5cf6 20%, transparent); animation:pulse 1.35s ease-in-out infinite; }
  .dot.completed { background:#22c55e; }
  .dot.failed { background:#ef4444; }
  .dot.retrying { background:#f59e0b; }
  .label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .outcome { border-radius:999px; padding:2px 7px; font-size:11px; background:color-mix(in srgb, currentColor 9%, transparent); opacity:.72; text-transform:capitalize; }
  .empty { color:color-mix(in srgb, currentColor 58%, transparent); font-size:13px; }
  .notice { padding:9px 16px; background:color-mix(in srgb, currentColor 5%, transparent); color:color-mix(in srgb, currentColor 68%, transparent); font-size:11px; }
  .transcript { list-style:none; padding:13px 0 0; margin:14px 0 0; border-top:1px solid color-mix(in srgb, currentColor 12%, transparent); display:grid; gap:10px; }
  .entry { border:1px solid color-mix(in srgb, currentColor 11%, transparent); border-radius:9px; padding:9px 10px; font-size:12px; }
  .entry-head { display:flex; justify-content:space-between; gap:10px; font-weight:650; margin-bottom:5px; }
  .entry pre { white-space:pre-wrap; word-break:break-word; margin:6px 0 0; font:11px ui-monospace, SFMono-Regular, Menlo, monospace; opacity:.82; }
  details.entry.tool { padding:0; overflow:hidden; }
  .tool-summary { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 10px; padding:10px; cursor:pointer; list-style:none; }
  .tool-summary::-webkit-details-marker { display:none; }
  .tool-title { font-weight:700; }
  .tool-preview { grid-column:1 / -1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.62; font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tool-hint { font-size:11px; opacity:.56; }
  .tool-body { border-top:1px solid color-mix(in srgb, currentColor 10%, transparent); padding:0 10px 10px; }
  .tool-body pre { max-height:360px; overflow:auto; }
  .entry.thinking { border-color:color-mix(in srgb, #8b5cf6 25%, transparent); }
  .entry.assistant { background:color-mix(in srgb, #3b82f6 8%, transparent); }
  .entry.result { background:color-mix(in srgb, #22c55e 8%, transparent); }
  .warn { color:#c26b00; }
  @keyframes pulse { 50% { opacity:.45; } }
</style>
<style>
  /* Compact Codex-style inline chrome: the timeline duplicates the transcript. */
  #claude-worker-card {
    max-width: 700px;
    border: 0;
    border-radius: 0;
    background: transparent;
    font-size: 13px;
    line-height: 18px;
  }
  #claude-worker-card .content { padding: 0; }
  #claude-worker-card .activity-summary {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    list-style: none;
  }
  #claude-worker-card .activity-summary::-webkit-details-marker { display: none; }
  #claude-worker-card .activity-summary .brand { min-width: 0; }
  #claude-worker-card .activity-phase {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: .65;
    font-size: 12px;
  }
  #claude-worker-card .activity-summary::after {
    content: "Show";
    font-size: 11px;
    opacity: .56;
  }
  #claude-worker-card details.activity[open] .activity-summary::after { content: "Hide"; }
  #claude-worker-card .activity-body { padding-top: 10px; }
  #claude-worker-card .mark { width: 20px; height: 20px; border-radius: 6px; font-size: 12px; }
  #claude-worker-card .state { padding: 2px 8px; font-size: 11px; }
  #claude-worker-card .tool-summary { gap: 6px; margin-top: 6px; padding: 7px 9px; }
  #claude-worker-card .timeline { display: none; }
  #claude-worker-card .transcript { margin-top: 8px; gap: 6px; }
  #claude-worker-card .transcript > details { margin: 0; }
  #claude-worker-card .entry {
    padding: 7px 9px;
    border-radius: 8px;
    background: transparent;
  }
  #claude-worker-card .transcript .entry {
    border: 0;
    border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
    border-radius: 0;
    padding: 5px 0;
  }
  /* Tool activity is supporting detail: keep it on a compact, shared baseline. */
  #claude-worker-card .transcript > details.entry.tool {
    min-height: 0;
    padding: 0;
  }
  #claude-worker-card .transcript > details.entry.tool .tool-summary {
    min-height: 24px;
    box-sizing: border-box;
    padding: 3px 0;
    line-height: 16px;
  }
  #claude-worker-card .tool-summary {
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0 8px;
  }
  #claude-worker-card .tool-summary > .tool-title {
    grid-column: 1;
    grid-row: 1;
    font-size: 12px;
    line-height: 16px;
    white-space: nowrap;
  }
  #claude-worker-card .tool-summary > .tool-preview {
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
    font-size: 10px;
    line-height: 14px;
  }
  #claude-worker-card .tool-summary > .outcome {
    grid-column: 3;
    grid-row: 1;
    padding: 1px 6px;
    font-size: 10px;
    line-height: 14px;
  }
  #claude-worker-card .tool-summary > .tool-hint { display: none; }
  #claude-worker-card .tool-summary::after {
    grid-column: 4;
    grid-row: 1;
    content: "Show";
    font-size: 11px;
    line-height: 14px;
    opacity: .56;
  }
  #claude-worker-card details.entry.tool[open] .tool-summary::after { content: "Hide"; }
  #claude-worker-card .entry-head { font-size: 12px; line-height: 16px; margin-bottom: 3px; }
  #claude-worker-card .entry pre { margin-top: 4px; font-size: 10px; }
  #claude-worker-card .tool-body { padding: 0 9px 8px; }
  #claude-worker-card .notice { padding: 8px 0 0; font-size: 11px; background: transparent; }
</style>
<section id="claude-worker-card" aria-live="polite">
  <details class="activity">
    <summary class="activity-summary"><div class="brand"><span class="mark">✦</span><span>Claude worker</span></div><span id="activity-phase" class="activity-phase">Connecting to worker…</span><span id="state" class="state">Connecting</span></summary>
    <div class="content activity-body">
      <div id="phase" class="phase">Connecting to worker…</div>
      <p id="detail" class="detail">Loading safe activity…</p>
      <div id="stats" class="stats"></div>
      <ol id="timeline" class="timeline"><li class="empty">Waiting for the first public activity update…</li></ol>
      <ol id="transcript" class="transcript"></ol>
    </div>
    <div class="notice">Streaming Claude activity. Credentials are redacted before rendering.</div>
  </details>
</section>
<script type="module">
(() => {
  const state = document.getElementById("state");
  const activityPhase = document.getElementById("activity-phase");
  const phase = document.getElementById("phase");
  const detail = document.getElementById("detail");
  const stats = document.getElementById("stats");
  const timeline = document.getElementById("timeline");
  const transcript = document.getElementById("transcript");
  let jobId = new URL(${JSON.stringify(resourceUri)}, "https://widget.local").searchParams.get("job_id");
  let timer = null;
  let app = null;
  function parse(value) {
    if (typeof value === "string") { try { return JSON.parse(value); } catch { return null; } }
    return value && typeof value === "object" ? value : null;
  }
  function initial() {
    const host = window.openai || {};
    return parse(host.toolOutput) || parse(host.toolResponseMetadata) || parse(host);
  }
  function render(data) {
    if (!data) return;
    jobId = data.job_id || jobId;
    const currentState = data.state || "running";
    state.textContent = currentState;
    state.className = "state " + currentState;
    phase.textContent = data.phase || "Claude worker is running";
    activityPhase.textContent = data.phase || "Claude worker is running";
    detail.textContent = data.detail || "Claude worker is running.";
    detail.className = "detail" + (data.retry_error ? " warn" : "");
    const bits = [];
    if (Number.isFinite(data.elapsed_seconds)) bits.push(data.elapsed_seconds + "s elapsed");
    if (Number.isFinite(data.event_count)) bits.push(data.event_count + " events");
    if (data.retries) bits.push(data.retries === 1 ? "1 retry" : data.retries + " retries");
    stats.replaceChildren(...bits.map(bit => { const item = document.createElement("span"); item.className = "stat"; item.textContent = bit; return item; }));
    const entries = data.timeline || [];
    if (!entries.length) {
      timeline.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "Waiting for the first public activity update…" }));
    } else {
      timeline.replaceChildren(...entries.map(entry => {
        const item = document.createElement("li"); item.className = "timeline-item";
        const dot = document.createElement("span"); dot.className = "dot " + (entry.status || "");
        const label = document.createElement("span"); label.className = "label"; label.textContent = entry.kind === "tool" ? entry.label : entry.label;
        const outcome = document.createElement("span"); outcome.className = "outcome"; outcome.textContent = entry.status || "active";
        item.append(dot, label, outcome); return item;
      }));
    }
    const transcriptEntries = data.transcript || [];
    transcript.replaceChildren(...transcriptEntries.map(entry => {
      if (entry.kind === "tool") {
        const item = document.createElement("details"); item.className = "entry tool " + (entry.status || "running");
        const summary = document.createElement("summary"); summary.className = "tool-summary";
        const title = document.createElement("span"); title.className = "tool-title"; title.textContent = entry.label || "Tool";
        const outcome = document.createElement("span"); outcome.className = "outcome"; outcome.textContent = entry.status || "running";
        const source = entry.output || entry.input || "No output reported yet";
        const preview = document.createElement("span"); preview.className = "tool-preview"; preview.textContent = source.slice(0, 150);
        const hint = document.createElement("span"); hint.className = "tool-hint"; hint.textContent = "Expand";
        summary.append(title, outcome, preview, hint); item.append(summary);
        const body = document.createElement("div"); body.className = "tool-body";
        if (entry.input) { const input = document.createElement("pre"); input.textContent = "input: " + entry.input; body.append(input); }
        if (entry.output) { const output = document.createElement("pre"); output.textContent = "output: " + entry.output; body.append(output); }
        item.append(body); return item;
      }
      const item = document.createElement("li"); item.className = "entry " + (entry.kind || "");
      const head = document.createElement("div"); head.className = "entry-head";
      const title = document.createElement("span"); title.textContent = entry.kind === "tool" ? entry.label : entry.kind === "thinking" ? "Thinking" : entry.kind === "result" ? "Result" : "Claude";
      const outcome = document.createElement("span"); outcome.textContent = entry.status || "";
      head.append(title, outcome); item.append(head);
      if (entry.text) { const body = document.createElement("div"); body.textContent = entry.text; item.append(body); }
      return item;
    }));
    if (["completed", "failed", "cancelled"].includes(data.state) && timer) { clearInterval(timer); timer = null; }
  }
  async function refresh() {
    if (!jobId) { detail.textContent = "Worker ID was unavailable; reopen this activity card."; return; }
    try {
      let result;
      if (app) {
        result = await app.callServerTool({ name: "get_claude_worker_activity", arguments: { job_id: jobId } });
      } else if (window.openai?.callTool) {
        result = await window.openai.callTool("get_claude_worker_activity", { job_id: jobId });
      }
      const payload = parse(result?.structuredContent) || parse(result);
      if (!payload) throw new Error("activity endpoint returned no structured data");
      render(payload);
    } catch (error) { detail.textContent = "Activity refresh failed: " + (error?.message || "unknown error"); detail.className = "detail warn"; }
  }
  async function boot() {
    render(initial());
    try {
      const { App } = await import("https://esm.sh/@modelcontextprotocol/ext-apps@1.7.0");
      app = new App({ name: "Claude worker activity", version: "${SERVER_VERSION}" });
      app.ontoolresult = result => render(parse(result?.structuredContent) || parse(result));
      app.onerror = () => {};
      await app.connect();
    } catch {
      // ChatGPT's compatibility bridge remains a functional fallback.
    }
    if (!timer) timer = setInterval(refresh, 1500);
    refresh();
  }
  boot();
  window.addEventListener("message", () => { render(initial()); });
})();
</script>`;
}

function uiMeta(jobId) {
  return {
    ui: { resourceUri: widgetUri(jobId) },
    "ui/resourceUri": widgetUri(jobId),
    "openai/outputTemplate": widgetUri(jobId),
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Opening Claude worker activity",
    "openai/toolInvocation/invoked": "Opened Claude worker activity",
  };
}

function toolResult(payload, includeUi = false) {
  const result = { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  if (includeUi) result._meta = uiMeta(payload.job_id);
  return result;
}

function toolError(error) {
  const payload = { ok: false, error: error.message || String(error) };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

function tools() {
  const schema = { type: "object", properties: { job_id: { type: "string", description: "Claude worker job ID supplied by the prompt hook." } }, required: ["job_id"], additionalProperties: false };
  return [
    { name: "show_claude_worker", title: "Show Claude worker activity", description: "Open the inline activity card for an already-started Claude worker. Use only when the user explicitly asks to inspect activity.", inputSchema: schema, annotations: { readOnlyHint: true }, _meta: uiMeta() },
    { name: "get_claude_worker_status", title: "Get Claude worker status", description: "Read lean live status, provider retry count, and tool-name summary for a Claude worker.", inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: "get_claude_worker_activity", title: "Get Claude worker activity", description: "Read the redacted live transcript, tool inputs/results, and worker status for the inline activity widget.", inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: "claude_is_working", title: "Claude is working…", description: "Poll until a Claude worker finishes, is cancelled, or emits a safe, rate-limited progress message. Each poll returns within four minutes so the host request cannot expire; when timed_out is true, call this tool again. When state is running and progress_message is present, relay it to the user. When it reaches completed or failed, synthesize worker_result. When state is cancelled, stop polling and acknowledge the cancellation. Workers have no time limit, so keep polling for as long as the job stays running, however many polls that takes.", inputSchema: { ...schema, properties: { ...schema.properties, timeout_seconds: { type: "integer", minimum: 1, maximum: TOOL_POLL_MAX_WAIT_SECONDS, description: `Maximum time for this poll; defaults to ${TOOL_POLL_DEFAULT_WAIT_SECONDS}.` } } }, annotations: { readOnlyHint: true }, _meta: { "openai/toolInvocation/invoking": "Claude is working…", "openai/toolInvocation/invoked": "Claude updated" } },
  ];
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function callTool(name, args) {
  const jobId = args?.job_id;
  if (name === "show_claude_worker") return toolResult(snapshot(jobId), true);
  if (name === "get_claude_worker_status") return toolResult(snapshot(jobId));
  if (name === "get_claude_worker_activity") return toolResult(snapshot(jobId, true));
  if (name === "claude_is_working" || name === "wait_for_claude_worker") {
    let current = snapshot(jobId);
    const requestedTimeoutSeconds = Math.min(
      TOOL_POLL_MAX_WAIT_SECONDS,
      Math.max(1, Number(args.timeout_seconds || TOOL_POLL_DEFAULT_WAIT_SECONDS)),
    );
    const deadline = Date.now() + (requestedTimeoutSeconds * 1000);
    const initialAssistantUpdates = current.assistant_update_count || 0;
    while (!["completed", "failed", "cancelled"].includes(current.state) && Date.now() < deadline) {
      await sleep(750);
      current = snapshot(jobId);
      if (["completed", "failed", "cancelled"].includes(current.state)) break;
      const previousRelay = lastProgressRelay.get(jobId);
      const mayRelay = !previousRelay || (Date.now() - previousRelay.at) >= PROGRESS_RELAY_MIN_INTERVAL_MS;
      if (mayRelay && current.assistant_update_count > initialAssistantUpdates && current.progress_message) {
        lastProgressRelay.set(jobId, { at: Date.now(), assistantUpdates: current.assistant_update_count });
        return toolResult({ ...current, worker_result: null, progress_update: true });
      }
    }
    if (!["completed", "failed", "cancelled"].includes(current.state) && workerIsDead(readJson(jobPath(jobId)))) {
      finalizeDeadWorker(jobId);
      current = snapshot(jobId);
    }
    if (current.state === "completed") {
      lastProgressRelay.delete(jobId);
      const job = readJson(jobPath(jobId));
      return toolResult({ ...current, worker_result: job.result, claude_session_id: job.claude_session_id });
    }
    if (current.state === "failed") {
      lastProgressRelay.delete(jobId);
      return toolResult({ ...current, worker_result: null });
    }
    if (current.state === "cancelled") {
      lastProgressRelay.delete(jobId);
      return toolResult({ ...current, worker_result: null, cancelled: true });
    }
    return toolResult({ ...current, timed_out: true, worker_result: null });
  }
  throw new Error(`unknown tool: ${name}`);
}

function rpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handle(message) {
  if (!plainObject(message)) return rpcError(null, -32600, "Invalid Request");
  if (typeof message.method !== "string") return rpcError(message.id ?? null, -32600, "Invalid method");
  if (message.method.startsWith("notifications/") || message.method === "$/cancelRequest") return null;
  if (message.method === "initialize") return rpc(message.id, { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: SERVER_NAME, title: "Claude worker activity", version: SERVER_VERSION }, instructions: "Use claude_is_working after the Claude prompt hook provides a job ID. Open show_claude_worker only when the user explicitly asks to inspect activity." });
  if (message.method === "ping") return rpc(message.id, {});
  if (message.method === "tools/list") return rpc(message.id, { tools: tools() });
  if (message.method === "tools/call") {
    try { return rpc(message.id, await callTool(message.params?.name, message.params?.arguments || {})); }
    catch (error) { return rpc(message.id, toolError(error)); }
  }
  if (message.method === "resources/list") return rpc(message.id, { resources: [{ uri: WIDGET_URI, name: "Claude worker activity", mimeType: WIDGET_MIME, description: "Live Claude Code worker activity." }] });
  if (message.method === "resources/read") {
    const resourceUri = message.params?.uri;
    if (typeof resourceUri !== "string" || (resourceUri !== WIDGET_URI && !resourceUri.startsWith(`${WIDGET_URI}?job_id=`))) return rpcError(message.id, -32602, "Unknown resource");
    return rpc(message.id, { contents: [{ uri: resourceUri, mimeType: WIDGET_MIME, text: widgetHtml(resourceUri), _meta: {
      "openai/widgetDescription": "Live Claude worker activity.",
      "openai/widgetCSP": { connect_domains: [], resource_domains: ["https://esm.sh"], frame_domains: [] },
      ui: { csp: { connectDomains: [], resourceDomains: ["https://esm.sh"], frameDomains: [] } },
    } }] });
  }
  if (message.method === "resources/templates/list") return rpc(message.id, { resourceTemplates: [] });
  if (message.method === "prompts/list") return rpc(message.id, { prompts: [] });
  return rpcError(message.id, -32601, "Method not found");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch (error) { process.stdout.write(`${JSON.stringify(rpcError(null, -32700, error.message))}\n`); return; }
  const response = await handle(message);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});
