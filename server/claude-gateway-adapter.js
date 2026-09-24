"use strict";

/**
 * Claude Code -> Hermes3D gateway adapter.
 *
 * Claude Code posts its hook events here over HTTP (type: "http" hooks, see
 * scripts/claude/install-hooks.js) and the status line script posts usage /
 * model data. The adapter turns them into Hermes3D gateway protocol v3 frames
 * on ws://localhost:18789, so the office runs in "Demo backend" mode with no
 * UI changes: every Claude Code session becomes an office worker, subagents
 * become helper workers.
 *
 *   POST /hook        <- Claude Code hook JSON (any event)
 *   POST /statusline  <- status line JSON (model, rate_limits, context)
 *   GET  /state       -> debug snapshot
 *   GET  /usage       -> latest rate limit snapshot
 *   WS   /            -> Hermes3D Studio
 *
 * Observation only: the adapter never answers a hook with a decision, so it
 * cannot block or change what Claude Code does.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.CLAUDE_ADAPTER_PORT || process.env.DEMO_ADAPTER_PORT || "18789", 10);
const HOST = process.env.CLAUDE_ADAPTER_HOST || "127.0.0.1";
const MAIN_KEY = "main";
const STATE_DIR = process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), ".agent-office");
const STATE_FILE = path.join(STATE_DIR, "claude-state.json");
const STALE_AGENT_MS = parseInt(process.env.AGENT_OFFICE_STALE_HOURS || "8", 10) * 3600_000;
const SUBAGENT_LINGER_MS = 20_000;
const SESSION_END_LINGER_MS = 5_000;
const APPROVAL_TTL_MS = 10 * 60_000;
const HISTORY_LIMIT = 60;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEBUG = process.env.AGENT_OFFICE_DEBUG === "1";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * agentId -> {
 *   id, name, role, emoji, workspace, kind: "session" | "subagent",
 *   sessionId, subagentId?, parentId?, subagentType?,
 *   model, status: "idle"|"running"|"waiting"|"error", runId, currentTool,
 *   lastActivityAt, createdAt, history: [{role, content, ts}], ended
 * }
 */
const agents = new Map();
const sessionToAgent = new Map(); // Claude session_id -> agentId
const subagentToAgent = new Map(); // Claude agent_id -> agentId
const pendingApprovals = new Map(); // agentId -> approval id
const removalTimers = new Map();
const usage = {
  fiveHour: null, // { usedPercentage, resetsAt }
  sevenDay: null,
  updatedAt: null,
  sessionId: null,
};
const sendFns = new Set();
let globalSeq = 0;

const randomId = () => randomUUID().replace(/-/g, "");
const now = () => Date.now();
const sessionKeyFor = (agentId) => `agent:${agentId}:${MAIN_KEY}`;
const log = (...args) => console.log("[claude-gateway]", ...args);
const debug = (...args) => {
  if (DEBUG) console.log("[claude-gateway:debug]", ...args);
};

function truncate(text, max) {
  const value = typeof text === "string" ? text : text == null ? "" : String(text);
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

function projectName(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return "Claude";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "Claude";
}

function shortModel(model) {
  if (!model) return null;
  const value = String(model).toLowerCase();
  for (const family of ["fable", "mythos", "opus", "sonnet", "haiku"]) {
    if (value.includes(family)) return family.charAt(0).toUpperCase() + family.slice(1);
  }
  return String(model);
}

const EMOJI_BY_FAMILY = { Opus: "🟣", Sonnet: "🔵", Haiku: "🟢", Fable: "🟠", Mythos: "🟠" };

function emojiFor(agent) {
  if (agent.kind === "subagent") return "🧑‍🔧";
  return EMOJI_BY_FAMILY[shortModel(agent.model)] || "🤖";
}

function roleFor(agent) {
  const model = shortModel(agent.model);
  if (agent.kind === "subagent") {
    const parent = agents.get(agent.parentId);
    const base = agent.subagentType || "subagent";
    return parent ? `${base} · ${parent.name}` : base;
  }
  return model ? `Claude Code · ${model}` : "Claude Code";
}

function uniqueName(base) {
  const taken = new Set([...agents.values()].map((agent) => agent.name));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} #${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} #${randomId().slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// Persistence (so a restart of the adapter keeps the office populated)
// ---------------------------------------------------------------------------

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const snapshot = {
        version: 1,
        agents: [...agents.values()]
          .filter((agent) => agent.kind === "session" && !agent.ended)
          .map((agent) => ({ ...agent, status: "idle", runId: null, currentTool: null, history: agent.history.slice(-20) })),
        usage,
      };
      const tmp = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch (error) {
      log("state save failed:", error.message);
    }
  }, 1_000);
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const agent of raw.agents || []) {
      if (!agent || !agent.id || !agent.sessionId) continue;
      if (now() - (agent.lastActivityAt || 0) > STALE_AGENT_MS) continue;
      agents.set(agent.id, { ...agent, history: Array.isArray(agent.history) ? agent.history : [] });
      sessionToAgent.set(agent.sessionId, agent.id);
    }
    if (raw.usage) Object.assign(usage, raw.usage);
    log(`restored ${agents.size} session(s) from ${STATE_FILE}`);
  } catch {
    // first run or unreadable file: start empty
  }
}

// ---------------------------------------------------------------------------
// Outgoing frames
// ---------------------------------------------------------------------------

function broadcast(frame) {
  const out = { ...frame };
  if (out.type === "event" && typeof out.seq !== "number") out.seq = globalSeq++;
  for (const send of sendFns) {
    try {
      send(out);
    } catch {}
  }
}

function emitPresence() {
  const recent = [...agents.values()].map((agent) => ({
    key: sessionKeyFor(agent.id),
    updatedAt: agent.lastActivityAt,
  }));
  broadcast({
    type: "event",
    event: "presence",
    payload: {
      sessions: {
        recent,
        byAgent: [...agents.values()].map((agent) => ({
          agentId: agent.id,
          recent: [{ key: sessionKeyFor(agent.id), updatedAt: agent.lastActivityAt }],
        })),
      },
    },
  });
}

function emitAgentEvent(agent, stream, data) {
  broadcast({
    type: "event",
    event: "agent",
    payload: {
      runId: agent.runId,
      sessionKey: sessionKeyFor(agent.id),
      stream,
      ts: now(),
      data,
    },
  });
}

function emitChat(agent, state, message) {
  broadcast({
    type: "event",
    event: "chat",
    payload: {
      runId: agent.runId,
      sessionKey: sessionKeyFor(agent.id),
      state,
      ...(state === "final" ? { stopReason: "end_turn" } : {}),
      ...(message ? { message } : {}),
    },
  });
}

function emitSpeech(agent, text) {
  const clean = truncate(text, 240);
  if (!clean) return;
  broadcast({
    type: "event",
    event: "office.speech",
    payload: { agentId: agent.id, name: agent.name, text: clean, atMs: now() },
  });
}

function emitUsage() {
  broadcast({ type: "event", event: "claude.usage", payload: usagePayload() });
}

function usagePayload() {
  return {
    fiveHour: usage.fiveHour,
    sevenDay: usage.sevenDay,
    updatedAt: usage.updatedAt,
    agents: [...agents.values()].map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      kind: agent.kind,
      model: agent.model || null,
      modelFamily: shortModel(agent.model),
      status: agent.status,
      contextUsedPercentage: agent.contextUsedPercentage ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

function cancelRemoval(agentId) {
  const timer = removalTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    removalTimers.delete(agentId);
  }
}

function scheduleRemoval(agentId, delayMs) {
  cancelRemoval(agentId);
  removalTimers.set(
    agentId,
    setTimeout(() => {
      removalTimers.delete(agentId);
      removeAgent(agentId);
    }, delayMs)
  );
}

function removeAgent(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return;
  agents.delete(agentId);
  if (agent.kind === "session") {
    if (sessionToAgent.get(agent.sessionId) === agentId) sessionToAgent.delete(agent.sessionId);
    for (const child of [...agents.values()]) {
      if (child.parentId === agentId) removeAgent(child.id);
    }
  } else if (agent.subagentId && subagentToAgent.get(agent.subagentId) === agentId) {
    subagentToAgent.delete(agent.subagentId);
  }
  pendingApprovals.delete(agentId);
  log(`removed ${agent.kind} "${agent.name}"`);
  emitPresence();
  scheduleSave();
}

function ensureSessionAgent(input) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;
  const existingId = sessionToAgent.get(sessionId);
  if (existingId && agents.has(existingId)) {
    const agent = agents.get(existingId);
    if (agent.ended) {
      agent.ended = false;
      cancelRemoval(agent.id);
    }
    if (input.cwd && !agent.workspace) agent.workspace = input.cwd;
    return agent;
  }
  const id = `cc-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || randomId().slice(0, 10)}`;
  const agent = {
    id,
    kind: "session",
    sessionId,
    name: uniqueName(projectName(input.cwd)),
    workspace: typeof input.cwd === "string" ? input.cwd : "",
    model: typeof input.model === "string" ? input.model : null,
    status: "idle",
    runId: null,
    currentTool: null,
    createdAt: now(),
    lastActivityAt: now(),
    history: [],
    ended: false,
  };
  agents.set(id, agent);
  sessionToAgent.set(sessionId, id);
  log(`new session "${agent.name}" (${sessionId.slice(0, 8)}) in ${agent.workspace || "?"}`);
  emitPresence();
  scheduleSave();
  return agent;
}

function ensureSubagent(parent, input) {
  const subagentId = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;
  const subagentType = typeof input.agent_type === "string" && input.agent_type ? input.agent_type : "subagent";
  if (subagentId && subagentToAgent.has(subagentId)) {
    const existing = agents.get(subagentToAgent.get(subagentId));
    if (existing) return existing;
  }
  // SubagentStart without an id: reuse an unbound helper of the same type.
  if (subagentId) {
    for (const candidate of agents.values()) {
      if (
        candidate.kind === "subagent" &&
        candidate.parentId === parent.id &&
        !candidate.subagentId &&
        !candidate.ended &&
        candidate.subagentType === subagentType
      ) {
        candidate.subagentId = subagentId;
        subagentToAgent.set(subagentId, candidate.id);
        return candidate;
      }
    }
  }
  const id = `sub-${(subagentId || randomId()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)}`;
  const agent = {
    id,
    kind: "subagent",
    sessionId: parent.sessionId,
    subagentId,
    subagentType,
    parentId: parent.id,
    name: uniqueName(subagentType),
    workspace: parent.workspace,
    model: null,
    status: "idle",
    runId: null,
    currentTool: null,
    createdAt: now(),
    lastActivityAt: now(),
    history: [],
    ended: false,
  };
  agents.set(id, agent);
  if (subagentId) subagentToAgent.set(subagentId, id);
  log(`subagent "${agent.name}" hired by "${parent.name}"`);
  emitPresence();
  return agent;
}

/** Resolve which office worker a hook event belongs to. */
function resolveAgent(input) {
  const parent = ensureSessionAgent(input);
  if (!parent) return null;
  if (typeof input.agent_id === "string" && input.agent_id) {
    return ensureSubagent(parent, input);
  }
  return parent;
}

function touch(agent) {
  agent.lastActivityAt = now();
  cancelRemoval(agent.id);
}

function startRun(agent, runId) {
  if (agent.runId) {
    // Already mid-turn (possibly paused on an approval): keep the same run.
    if (agent.status !== "waiting") agent.status = "running";
    return;
  }
  agent.runId = runId || randomId();
  agent.status = "running";
  emitAgentEvent(agent, "lifecycle", { phase: "start" });
}

function endRun(agent, phase = "end") {
  if (!agent.runId) {
    agent.status = phase === "error" ? "error" : "idle";
    return;
  }
  emitAgentEvent(agent, "lifecycle", { phase });
  agent.status = phase === "error" ? "error" : "idle";
  agent.runId = null;
  agent.currentTool = null;
}

function pushHistory(agent, role, content) {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return;
  agent.history.push({ role, content: text, ts: now() });
  if (agent.history.length > HISTORY_LIMIT) agent.history.splice(0, agent.history.length - HISTORY_LIMIT);
}

function describeTool(toolName, toolInput) {
  const inputRecord = toolInput && typeof toolInput === "object" ? toolInput : {};
  const file = inputRecord.file_path || inputRecord.notebook_path || inputRecord.path;
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      return `${toolName}: ${truncate(inputRecord.command, 120)}`;
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `${toolName} ${file ? projectName(file) : ""}`.trim();
    case "Grep":
    case "Glob":
      return `${toolName} "${truncate(inputRecord.pattern, 60)}"`;
    case "WebFetch":
      return `WebFetch ${truncate(inputRecord.url, 80)}`;
    case "WebSearch":
      return `WebSearch "${truncate(inputRecord.query, 80)}"`;
    case "Agent":
    case "Task":
      return `${toolName}: ${truncate(inputRecord.description || inputRecord.subagent_type, 80)}`;
    default:
      return toolName || "tool";
  }
}

function resolveApproval(agent, decision = "allow-once") {
  const approvalId = pendingApprovals.get(agent.id);
  if (!approvalId) return;
  pendingApprovals.delete(agent.id);
  broadcast({
    type: "event",
    event: "exec.approval.resolved",
    payload: { id: approvalId, decision, resolvedBy: "claude-code", ts: now() },
  });
  if (agent.status === "waiting") agent.status = agent.runId ? "running" : "idle";
}

function requestApproval(agent, summary, cwd) {
  if (pendingApprovals.has(agent.id)) return;
  const approvalId = `cc-approval-${randomId().slice(0, 12)}`;
  pendingApprovals.set(agent.id, approvalId);
  agent.status = "waiting";
  broadcast({
    type: "event",
    event: "exec.approval.requested",
    payload: {
      id: approvalId,
      request: {
        command: summary || "Ruxsat kerak",
        cwd: cwd || agent.workspace || null,
        host: "claude-code",
        security: null,
        ask: "on",
        agentId: agent.id,
        resolvedPath: null,
        sessionKey: sessionKeyFor(agent.id),
      },
      createdAtMs: now(),
      expiresAtMs: now() + APPROVAL_TTL_MS,
    },
  });
  emitSpeech(agent, `✋ Ruxsat kerak: ${summary}`);
}

// ---------------------------------------------------------------------------
// Hook handling
// ---------------------------------------------------------------------------

function handleHook(input) {
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  if (!event) return;
  debug(event, input.session_id, input.agent_id || "", input.tool_name || "");

  if (event === "SessionEnd") {
    const agentId = sessionToAgent.get(input.session_id);
    const agent = agentId ? agents.get(agentId) : null;
    if (!agent) return;
    endRun(agent);
    agent.ended = true;
    // "clear" and "resume" keep the same terminal open, so keep the worker.
    if (input.reason === "clear" || input.reason === "resume") {
      agent.ended = false;
      return;
    }
    emitSpeech(agent, "👋 Sessiya yopildi");
    scheduleRemoval(agent.id, SESSION_END_LINGER_MS);
    return;
  }

  if (event === "SubagentStart") {
    const parent = ensureSessionAgent(input);
    if (!parent) return;
    touch(parent);
    const sub = ensureSubagent(parent, input);
    touch(sub);
    startRun(sub);
    return;
  }

  if (event === "SubagentStop") {
    const parent = ensureSessionAgent(input);
    if (!parent) return;
    let sub = null;
    if (input.agent_id && subagentToAgent.has(input.agent_id)) {
      sub = agents.get(subagentToAgent.get(input.agent_id));
    } else {
      sub = [...agents.values()]
        .filter((a) => a.kind === "subagent" && a.parentId === parent.id && !a.ended)
        .filter((a) => !input.agent_type || a.subagentType === input.agent_type)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
    }
    if (!sub) return;
    if (input.last_assistant_message) {
      pushHistory(sub, "assistant", input.last_assistant_message);
      emitChat(sub, "final", { role: "assistant", content: input.last_assistant_message });
      emitSpeech(sub, input.last_assistant_message);
    }
    endRun(sub);
    sub.ended = true;
    scheduleRemoval(sub.id, SUBAGENT_LINGER_MS);
    return;
  }

  if (event === "PostModelSwitch") {
    const agent = ensureSessionAgent(input);
    if (!agent) return;
    agent.model = input.to_model || agent.model;
    emitPresence();
    emitUsage();
    scheduleSave();
    return;
  }

  const agent = resolveAgent(input);
  if (!agent) return;
  touch(agent);
  if (agent.kind === "session" && typeof input.model === "string" && input.model) agent.model = input.model;

  switch (event) {
    case "SessionStart":
      emitPresence();
      if (agent.kind === "session") emitSpeech(agent, `Salom! ${agent.name} ustida ishlashga tayyorman.`);
      break;

    case "UserPromptSubmit": {
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      pushHistory(agent, "user", prompt);
      if (agent.runId) endRun(agent);
      startRun(agent, input.prompt_id);
      emitChat(agent, "delta", { role: "assistant", content: "…" });
      break;
    }

    case "PreToolUse": {
      resolveApproval(agent);
      startRun(agent, input.prompt_id);
      const summary = describeTool(input.tool_name, input.tool_input);
      agent.currentTool = summary;
      emitAgentEvent(agent, "tool", {
        phase: "start",
        name: input.tool_name || "tool",
        toolCallId: input.tool_use_id || randomId(),
        arguments: input.tool_input ?? null,
      });
      emitChat(agent, "delta", { role: "assistant", content: `🔧 ${summary}` });
      break;
    }

    case "PostToolUse":
    case "PostToolUseFailure": {
      resolveApproval(agent);
      const isError = event === "PostToolUseFailure";
      const response = input.tool_response;
      const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
      emitAgentEvent(agent, "tool", {
        phase: "result",
        name: input.tool_name || "tool",
        toolCallId: input.tool_use_id || randomId(),
        isError,
        result: { text: truncate(text, 400) },
      });
      agent.currentTool = null;
      break;
    }

    case "PermissionRequest":
      requestApproval(agent, describeTool(input.tool_name, input.tool_input), input.cwd);
      break;

    case "PermissionDenied":
      resolveApproval(agent, "deny");
      break;

    case "Notification": {
      const type = input.notification_type;
      if (type === "permission_prompt") {
        requestApproval(agent, truncate(input.message, 120), input.cwd);
      } else if (type === "idle_prompt" || type === "agent_needs_input" || type === "elicitation_dialog") {
        emitSpeech(agent, `💬 ${input.message || "Sizning javobingizni kutyapman"}`);
      }
      break;
    }

    case "Stop": {
      resolveApproval(agent);
      const message = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
      if (message) {
        pushHistory(agent, "assistant", message);
        emitChat(agent, "final", { role: "assistant", content: message });
        emitSpeech(agent, message);
      }
      endRun(agent);
      emitPresence();
      break;
    }

    case "StopFailure":
      resolveApproval(agent, "deny");
      emitChat(agent, "error", null);
      emitSpeech(agent, `⚠️ Xato: ${input.reason || "unknown"}`);
      endRun(agent, "error");
      break;

    case "PreCompact":
      emitSpeech(agent, "🗜️ Kontekstni siqyapman…");
      break;

    default:
      break;
  }
  scheduleSave();
}

function handleStatusLine(input) {
  const rateLimits = input && typeof input.rate_limits === "object" ? input.rate_limits : null;
  const readWindow = (win) =>
    win && typeof win === "object"
      ? {
          usedPercentage: typeof win.used_percentage === "number" ? win.used_percentage : null,
          resetsAt: typeof win.resets_at === "number" ? win.resets_at * 1000 : null,
        }
      : null;
  if (rateLimits) {
    usage.fiveHour = readWindow(rateLimits.five_hour) || usage.fiveHour;
    usage.sevenDay = readWindow(rateLimits.seven_day) || usage.sevenDay;
    usage.updatedAt = now();
    usage.sessionId = input.session_id || null;
  }
  const agent = input && input.session_id ? ensureSessionAgent(input) : null;
  if (agent) {
    const model = input.model && typeof input.model === "object" ? input.model.id || input.model.display_name : input.model;
    const modelChanged = model && model !== agent.model;
    if (model) agent.model = model;
    const context = input.context_window && typeof input.context_window === "object" ? input.context_window : null;
    if (context && typeof context.used_percentage === "number") agent.contextUsedPercentage = context.used_percentage;
    if (modelChanged) emitPresence();
  }
  emitUsage();
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Gateway protocol (subset of what server/demo-gateway-adapter.js serves)
// ---------------------------------------------------------------------------

const resOk = (id, payload) => ({ type: "res", id, ok: true, payload: payload ?? {} });
const resErr = (id, code, message) => ({ type: "res", id, ok: false, error: { code, message } });

function agentListPayload() {
  return [...agents.values()].map((agent) => ({
    id: agent.id,
    name: agent.name,
    workspace: agent.workspace,
    identity: { name: agent.name, emoji: emojiFor(agent) },
    role: roleFor(agent),
  }));
}

function defaultAgentId() {
  const sessions = [...agents.values()]
    .filter((agent) => agent.kind === "session")
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return sessions[0]?.id || null;
}

function modelsPayload() {
  const seen = new Map();
  for (const agent of agents.values()) {
    if (agent.model && !seen.has(agent.model)) {
      seen.set(agent.model, { id: agent.model, name: shortModel(agent.model), provider: "anthropic" });
    }
  }
  return [...seen.values()];
}

const READ_ONLY_MESSAGE =
  "Men Claude Code terminalida ishlayapman. Ofisdan menga yozib bo'lmaydi — vazifani terminal yoki Claude ilovasi orqali bering.";

async function handleMethod(method, params, id) {
  const p = params || {};
  switch (method) {
    case "agents.list":
      return resOk(id, { defaultId: defaultAgentId(), mainKey: MAIN_KEY, agents: agentListPayload() });

    case "agents.create":
      return resErr(id, "unsupported_method", "Yangi xodim Claude Code sessiyasini ochganingizda o'zi paydo bo'ladi.");

    case "agents.update": {
      const agent = agents.get(typeof p.agentId === "string" ? p.agentId.trim() : "");
      if (!agent) return resErr(id, "not_found", "Agent not found");
      if (typeof p.name === "string" && p.name.trim()) agent.name = p.name.trim();
      scheduleSave();
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.delete": {
      const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
      if (agents.has(agentId)) removeAgent(agentId);
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.files.get":
      return resOk(id, { file: { missing: true } });
    case "agents.files.set":
      return resOk(id, {});

    case "config.get":
      return resOk(id, {
        config: { gateway: { reload: { mode: "hot" } } },
        hash: "claude-gateway",
        exists: true,
        path: STATE_FILE,
      });
    case "config.patch":
    case "config.set":
      return resOk(id, { hash: "claude-gateway" });

    case "exec.approvals.get":
      return resOk(id, {
        path: "",
        exists: true,
        hash: "claude-approvals",
        file: { version: 1, defaults: { security: "full", ask: "on", autoAllowSkills: true }, agents: {} },
      });
    case "exec.approvals.set":
      return resOk(id, { hash: "claude-approvals" });
    case "exec.approval.resolve":
      // Approvals are answered in the Claude Code terminal; the office only mirrors them.
      return resOk(id, { ok: true });

    case "models.list":
      return resOk(id, { models: modelsPayload() });

    case "skills.status":
      return resOk(id, { skills: [] });

    case "cron.list":
      return resOk(id, { jobs: [] });
    case "cron.add":
    case "cron.run":
    case "cron.remove":
      return resErr(id, "unsupported_method", `Claude gateway does not support ${method}.`);

    case "sessions.list":
      return resOk(id, {
        sessions: [...agents.values()].map((agent) => ({
          key: sessionKeyFor(agent.id),
          agentId: agent.id,
          updatedAt: agent.lastActivityAt,
          displayName: agent.kind === "subagent" ? agent.subagentType : "Main",
          origin: { label: agent.name, provider: "claude-code" },
          model: agent.model || null,
          modelProvider: "anthropic",
        })),
      });

    case "sessions.preview": {
      const keys = Array.isArray(p.keys) ? p.keys : [];
      const limit = typeof p.limit === "number" ? p.limit : 8;
      const maxChars = typeof p.maxChars === "number" ? p.maxChars : 240;
      const previews = keys.map((key) => {
        const agent = agents.get(String(key).split(":")[1] || "");
        if (!agent || agent.history.length === 0) return { key, status: "empty", items: [] };
        return {
          key,
          status: "ok",
          items: agent.history.slice(-limit).map((msg) => ({
            role: msg.role,
            text: msg.content.slice(0, maxChars),
            timestamp: msg.ts,
          })),
        };
      });
      return resOk(id, { ts: now(), previews });
    }

    case "sessions.patch": {
      const key = typeof p.key === "string" ? p.key : "";
      const agent = agents.get(key.split(":")[1] || "");
      return resOk(id, {
        ok: true,
        key,
        entry: {},
        resolved: { model: agent?.model || null, modelProvider: "anthropic" },
      });
    }

    case "sessions.reset":
      return resOk(id, { ok: true });

    case "chat.send": {
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : "";
      const agent = agents.get(sessionKey.split(":")[1] || "");
      const runId = typeof p.idempotencyKey === "string" && p.idempotencyKey ? p.idempotencyKey : randomId();
      if (agent) {
        setTimeout(() => {
          broadcast({
            type: "event",
            event: "chat",
            payload: {
              runId,
              sessionKey,
              state: "final",
              stopReason: "end_turn",
              message: { role: "assistant", content: READ_ONLY_MESSAGE },
            },
          });
        }, 50);
      }
      return resOk(id, { status: "started", runId });
    }

    case "chat.abort":
      return resOk(id, { ok: true, aborted: 0 });

    case "chat.history": {
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : "";
      const agent = agents.get(sessionKey.split(":")[1] || "");
      return resOk(id, {
        sessionKey,
        messages: agent ? agent.history.map((msg) => ({ role: msg.role, content: msg.content })) : [],
      });
    }

    case "agent.wait":
      return resOk(id, { status: "done" });

    case "status":
      return resOk(id, {
        sessions: {
          recent: [...agents.values()].map((agent) => ({ key: sessionKeyFor(agent.id), updatedAt: agent.lastActivityAt })),
          byAgent: [...agents.values()].map((agent) => ({
            agentId: agent.id,
            recent: [{ key: sessionKeyFor(agent.id), updatedAt: agent.lastActivityAt }],
          })),
        },
      });

    case "usage.get":
      return resOk(id, usagePayload());

    case "wake":
      return resOk(id, { ok: true });

    default:
      return resOk(id, {});
  }
}

const METHODS = [
  "agents.list",
  "agents.update",
  "agents.delete",
  "sessions.list",
  "sessions.preview",
  "sessions.patch",
  "sessions.reset",
  "chat.send",
  "chat.abort",
  "chat.history",
  "agent.wait",
  "status",
  "config.get",
  "config.set",
  "config.patch",
  "agents.files.get",
  "agents.files.set",
  "exec.approvals.get",
  "exec.approvals.set",
  "exec.approval.resolve",
  "wake",
  "skills.status",
  "models.list",
  "cron.list",
  "usage.get",
];

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function isLocalRequest(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || HOST !== "127.0.0.1";
}

function createServer() {
  const httpServer = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: "forbidden" });

    if (req.method === "POST" && (url === "/hook" || url === "/statusline")) {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      // Answer first: Claude Code must never wait on the office.
      sendJson(res, 200, {});
      try {
        if (url === "/hook") handleHook(body);
        else handleStatusLine(body);
      } catch (error) {
        log(`${url} handling failed:`, error.stack || error.message);
      }
      return;
    }

    if (req.method === "GET" && url === "/state") {
      return sendJson(res, 200, {
        agents: [...agents.values()].map(({ history, ...rest }) => ({ ...rest, historyLength: history.length })),
        usage,
        clients: sendFns.size,
      });
    }
    if (req.method === "GET" && url === "/usage") return sendJson(res, 200, usagePayload());

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Agent Office — Claude Code gateway adapter\n");
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    let connected = false;
    const send = (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const sendEvent = (frame) => {
      if (connected) send(frame);
    };
    sendFns.add(sendEvent);
    send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (!frame || frame.type !== "req" || typeof frame.id !== "string" || typeof frame.method !== "string") return;
      const { id, method, params } = frame;

      if (method === "connect") {
        connected = true;
        send(
          resOk(id, {
            type: "hello-ok",
            protocol: 3,
            // "demo" keeps Studio's auto-connect path; the office UI needs no changes.
            adapterType: "demo",
            features: {
              methods: METHODS,
              events: ["chat", "agent", "presence", "heartbeat", "exec.approval.requested", "exec.approval.resolved", "office.speech", "claude.usage"],
            },
            snapshot: {
              health: {
                agents: [...agents.values()].map((agent) => ({
                  agentId: agent.id,
                  name: agent.name,
                  isDefault: agent.id === defaultAgentId(),
                })),
                defaultAgentId: defaultAgentId(),
              },
              sessionDefaults: { mainKey: MAIN_KEY },
            },
            auth: { role: "operator", scopes: ["operator.admin"] },
            policy: { tickIntervalMs: 30000 },
          })
        );
        setTimeout(emitUsage, 200);
        return;
      }

      if (!connected) {
        send(resErr(id, "not_connected", "Send connect first."));
        return;
      }
      try {
        send(await handleMethod(method, params, id));
      } catch (error) {
        send(resErr(id, "internal_error", error instanceof Error ? error.message : "Internal error"));
      }
    });

    const drop = () => sendFns.delete(sendEvent);
    ws.on("close", drop);
    ws.on("error", drop);
  });

  return httpServer;
}

function sweepStaleAgents() {
  for (const agent of [...agents.values()]) {
    if (agent.status === "running" || agent.status === "waiting") continue;
    if (now() - agent.lastActivityAt > STALE_AGENT_MS) removeAgent(agent.id);
  }
}

function startAdapter() {
  loadState();
  const server = createServer();
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      log(`port ${PORT} is busy — stop the demo gateway (or another adapter) first.`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(PORT, HOST, () => {
    log(`listening on ws://localhost:${PORT}`);
    log(`Claude Code hooks  -> POST http://localhost:${PORT}/hook`);
    log(`status line        -> POST http://localhost:${PORT}/statusline`);
    log(`debug snapshot     -> GET  http://localhost:${PORT}/state`);
  });
  setInterval(sweepStaleAgents, 5 * 60_000).unref();
  setInterval(() => broadcast({ type: "event", event: "heartbeat", payload: { ts: now() } }), 30_000).unref();
  return server;
}

if (require.main === module) {
  startAdapter();
}

module.exports = { startAdapter, handleHook, handleStatusLine, handleMethod, agents, usage };
