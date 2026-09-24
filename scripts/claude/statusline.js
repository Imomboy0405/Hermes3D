#!/usr/bin/env node
"use strict";

/**
 * Claude Code status line for Agent Office.
 *
 * Claude Code pipes a JSON blob (model, rate_limits, context_window, ...) into
 * this script on every refresh. We forward it to the office adapter without
 * waiting on it, optionally run the status line you had before, and print a
 * compact line for the terminal.
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const PORT = parseInt(process.env.CLAUDE_ADAPTER_PORT || "18789", 10);
const CONFIG_FILE = path.join(process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), ".agent-office"), "config.json");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function forward(body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/statusline",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 300,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", resolve);
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

function chainedOutput(raw) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const command = config && typeof config.chainStatusLine === "string" ? config.chainStatusLine.trim() : "";
    if (!command) return "";
    return execSync(command, { input: raw, timeout: 2000, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function formatReset(resetsAtSec) {
  if (typeof resetsAtSec !== "number") return "";
  const minutes = Math.max(0, Math.round((resetsAtSec * 1000 - Date.now()) / 60000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} kun ${Math.floor((minutes % 1440) / 60)} soat`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  return `${minutes} daq`;
}

function dot(percent) {
  if (typeof percent !== "number") return "⚪";
  if (percent >= 80) return "🔴";
  if (percent >= 50) return "🟡";
  return "🟢";
}

function render(input) {
  const parts = [];
  const model = input.model && (input.model.display_name || input.model.id);
  if (model) parts.push(model);
  const five = input.rate_limits && input.rate_limits.five_hour;
  const week = input.rate_limits && input.rate_limits.seven_day;
  if (five && typeof five.used_percentage === "number") {
    const reset = formatReset(five.resets_at);
    parts.push(`${dot(five.used_percentage)} 5 soat ${Math.round(five.used_percentage)}%${reset ? ` ↻${reset}` : ""}`);
  }
  if (week && typeof week.used_percentage === "number") {
    parts.push(`${dot(week.used_percentage)} hafta ${Math.round(week.used_percentage)}%`);
  }
  const ctx = input.context_window && input.context_window.used_percentage;
  if (typeof ctx === "number") parts.push(`ctx ${Math.round(ctx)}%`);
  return parts.join(" │ ");
}

(async () => {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {}
  const forwarding = raw ? forward(raw) : Promise.resolve();
  const chained = chainedOutput(raw);
  await forwarding;
  const line = render(input);
  process.stdout.write([chained, line].filter(Boolean).join("  ") || "Agent Office");
})();
