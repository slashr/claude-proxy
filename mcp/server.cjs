"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
const SERVER_NAME = "claude-proxy-activity";
const SERVER_VERSION = manifest.version;
const WIDGET_URI = `ui://claude-proxy/activity-${encodeURIComponent(SERVER_VERSION)}.html`;
const WIDGET_MIME = "text/html;profile=mcp-app";
const DATA_DIR = process.env.PLUGIN_DATA || path.join(os.homedir(), ".codex", "plugins", "data", "claude-proxy-personal");
const JOB_DIR = path.join(DATA_DIR, "claude-jobs");

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

function safeText(value, limit = 80) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function redact(value) {
  return String(value || "")
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:Bearer\s+)?(?:ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b/g, "[redacted credential]")
    .replace(/\b(ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|password|token)\s*[=:]\s*[^\s'\"]+/gi, "$1=[redacted]");
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
          if (text) transcript.push({ kind: "assistant", text });
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
            tracked.item.status = block.is_error ? "failed" : "completed";
            tracked.transcriptItem.status = tracked.item.status;
            tracked.transcriptItem.output = preview(block.content, 1100);
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
  return {
    event_count: events,
    retries,
    retry_error: retryError,
    tool_calls: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })),
    timeline: visibleTimeline,
    transcript: transcript.slice(-30),
    phase: failedTool ? `${failedTool.label} needs attention` : currentTool ? `Running ${currentTool.label}` : hasResult ? "Preparing final answer" : initialized ? "Preparing work" : "Starting Claude worker",
  };
}

function snapshot(jobId, rich = false) {
  const job = readJson(jobPath(jobId));
  if (!job) throw new Error("worker job was not found");
  const activity = activityDetails(job.activity_file || path.join(DATA_DIR, "claude-activity", `${jobId}.jsonl`));
  const state = job.state || "queued";
  const terminal = ["completed", "failed"].includes(state);
  const elapsedReference = terminal ? (job.updated_at || job.started_at) : Math.floor(Date.now() / 1000);
  const snapshot = {
    job_id: job.job_id,
    state,
    detail: job.detail || "Claude worker is queued.",
    phase: state === "completed" ? "Work completed" : state === "failed" ? "Worker needs attention" : activity.phase,
    started_at: job.started_at || null,
    updated_at: job.updated_at || job.started_at || null,
    elapsed_seconds: job.started_at ? Math.max(0, elapsedReference - job.started_at) : null,
    event_count: activity.event_count,
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
<section id="claude-worker-card" aria-live="polite">
  <div class="content">
    <div class="head"><div class="brand"><span class="mark">✦</span><span>Claude worker</span></div><span id="state" class="state">Connecting</span></div>
    <div id="phase" class="phase">Connecting to worker…</div>
    <p id="detail" class="detail">Loading safe activity…</p>
    <div id="stats" class="stats"></div>
    <ol id="timeline" class="timeline"><li class="empty">Waiting for the first public activity update…</li></ol>
    <ol id="transcript" class="transcript"></ol>
  </div>
  <div class="notice">Streaming Claude activity. Credentials are redacted before rendering.</div>
</section>
<script type="module">
(() => {
  const state = document.getElementById("state");
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
        const item = document.createElement("details"); item.className = "entry tool";
        const summary = document.createElement("summary"); summary.className = "tool-summary";
        const title = document.createElement("span"); title.className = "tool-title"; title.textContent = entry.label || "Tool";
        const outcome = document.createElement("span"); outcome.className = "outcome"; outcome.textContent = entry.status || "running";
        const source = entry.output || entry.input || "No output reported yet";
        const preview = document.createElement("span"); preview.className = "tool-preview"; preview.textContent = source.replace(/\s+/g, " ").slice(0, 150);
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
    if (["completed", "failed"].includes(data.state) && timer) { clearInterval(timer); timer = null; }
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
    { name: "show_claude_worker", title: "Show Claude worker activity", description: "Open the live inline activity card for an already-started Claude worker. Call this immediately when the prompt hook supplies a job ID.", inputSchema: schema, annotations: { readOnlyHint: true }, _meta: uiMeta() },
    { name: "get_claude_worker_status", title: "Get Claude worker status", description: "Read lean live status, provider retry count, and tool-name summary for a Claude worker.", inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: "get_claude_worker_activity", title: "Get Claude worker activity", description: "Read the redacted live transcript, tool inputs/results, and worker status for the inline activity widget.", inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: "wait_for_claude_worker", title: "Wait for Claude worker", description: "Wait until a Claude worker finishes, then return its worker result for Codex to verify and synthesize. The inline activity card remains the user-facing progress view.", inputSchema: { ...schema, properties: { ...schema.properties, timeout_seconds: { type: "integer", minimum: 1, maximum: 600, description: "Maximum time to wait; defaults to 600." } } }, annotations: { readOnlyHint: true } },
  ];
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function callTool(name, args) {
  const jobId = args?.job_id;
  if (name === "show_claude_worker") return toolResult(snapshot(jobId), true);
  if (name === "get_claude_worker_status") return toolResult(snapshot(jobId));
  if (name === "get_claude_worker_activity") return toolResult(snapshot(jobId, true));
  if (name === "wait_for_claude_worker") {
    const deadline = Date.now() + ((args.timeout_seconds || 600) * 1000);
    let current = snapshot(jobId);
    while (!["completed", "failed"].includes(current.state) && Date.now() < deadline) {
      await sleep(750);
      current = snapshot(jobId);
    }
    if (current.state === "completed") {
      const job = readJson(jobPath(jobId));
      return toolResult({ ...current, worker_result: job.result, claude_session_id: job.claude_session_id });
    }
    if (current.state === "failed") return toolResult({ ...current, worker_result: null });
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
  if (message.method === "initialize") return rpc(message.id, { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: SERVER_NAME, title: "Claude worker activity", version: SERVER_VERSION }, instructions: "Use show_claude_worker immediately after the Claude prompt hook provides a job ID, then wait_for_claude_worker before responding." });
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
