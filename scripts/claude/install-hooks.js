#!/usr/bin/env node
"use strict";

/**
 * Connects Claude Code to Agent Office.
 *
 *   node scripts/claude/install-hooks.js            install / update
 *   node scripts/claude/install-hooks.js --uninstall remove everything it added
 *   node scripts/claude/install-hooks.js --dry-run  print the result, write nothing
 *
 * It edits your USER settings (~/.claude/settings.json), so every Claude Code
 * session — the desktop app, Android Studio's terminal, any terminal — shows
 * up in the office. A timestamped backup is written before any change.
 *
 * Hooks are "http" hooks: Claude Code posts the event JSON straight to the
 * adapter, so there is no shell script to run and nothing Windows-specific.
 * If the office is not running, the POST simply fails and Claude carries on.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = parseInt(process.env.CLAUDE_ADAPTER_PORT || "18789", 10);
const HOOK_URL = `http://127.0.0.1:${PORT}/hook`;
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");
const OFFICE_DIR = process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), ".agent-office");
const OFFICE_CONFIG = path.join(OFFICE_DIR, "config.json");
const STATUSLINE_SCRIPT = path.join(__dirname, "statusline.js").replace(/\\/g, "/");
const STATUSLINE_COMMAND = `node "${STATUSLINE_SCRIPT}"`;

const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostModelSwitch",
];

const args = new Set(process.argv.slice(2));
const uninstall = args.has("--uninstall");
const dryRun = args.has("--dry-run");

const isOurHook = (hook) =>
  hook && hook.type === "http" && typeof hook.url === "string" && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/hook$/.test(hook.url);
const isOurStatusLine = (statusLine) =>
  statusLine && typeof statusLine.command === "string" && statusLine.command.includes("scripts/claude/statusline.js");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    console.error(`✖ ${file} o'qib bo'lmadi (${error.message}). Hech narsa o'zgartirilmadi.`);
    process.exit(1);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function stripOurHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => ({ ...group, hooks: Array.isArray(group.hooks) ? group.hooks.filter((hook) => !isOurHook(hook)) : group.hooks }))
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

function main() {
  const original = readJson(SETTINGS_FILE, {});
  const settings = JSON.parse(JSON.stringify(original));
  const officeConfig = readJson(OFFICE_CONFIG, {});

  stripOurHooks(settings);

  if (uninstall) {
    if (isOurStatusLine(settings.statusLine)) {
      if (officeConfig.previousStatusLine) settings.statusLine = officeConfig.previousStatusLine;
      else delete settings.statusLine;
    }
  } else {
    settings.hooks = settings.hooks || {};
    for (const event of EVENTS) {
      const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      groups.push({ hooks: [{ type: "http", url: HOOK_URL, timeout: 3 }] });
      settings.hooks[event] = groups;
    }
    if (settings.statusLine && !isOurStatusLine(settings.statusLine)) {
      // Keep the status line you already had: ours runs it and prints its output first.
      officeConfig.previousStatusLine = settings.statusLine;
      officeConfig.chainStatusLine = settings.statusLine.command || "";
    }
    settings.statusLine = { type: "command", command: STATUSLINE_COMMAND, padding: 0 };
  }

  if (dryRun) {
    console.log(JSON.stringify(settings, null, 2));
    return;
  }

  if (fs.existsSync(SETTINGS_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${SETTINGS_FILE}.agent-office-backup-${stamp}`;
    fs.copyFileSync(SETTINGS_FILE, backup);
    console.log(`• Zaxira nusxa: ${backup}`);
  }
  writeJson(SETTINGS_FILE, settings);
  if (!uninstall) writeJson(OFFICE_CONFIG, officeConfig);

  if (uninstall) {
    console.log("✔ Agent Office hook'lari va status line olib tashlandi.");
  } else {
    console.log(`✔ ${EVENTS.length} ta hook qo'shildi -> ${HOOK_URL}`);
    console.log(`✔ Status line -> ${STATUSLINE_COMMAND}`);
    if (officeConfig.chainStatusLine) console.log(`• Oldingi status line saqlandi va birga ishlaydi: ${officeConfig.chainStatusLine}`);
    console.log("");
    console.log("Endi Claude Code'ni qayta ishga tushiring (hook'lar sessiya boshida o'qiladi).");
  }
}

main();
