"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, Gauge } from "lucide-react";
import { readUiLang, UI_LANG_KEY } from "@/components/UiTranslator";

/**
 * Claude plan limits and per-worker models, read from the Claude Code
 * adapter (server/claude-gateway-adapter.js, GET /usage). Renders nothing
 * when the adapter is not running, so the stock Hermes backends are unaffected.
 */

type UsageWindow = { usedPercentage: number | null; resetsAt: number | null } | null;

type UsageAgent = {
  agentId: string;
  name: string;
  kind: "session" | "subagent" | "roster";
  model: string | null;
  modelFamily: string | null;
  status: "idle" | "running" | "waiting" | "error";
  parentId: string | null;
  currentTool: string | null;
  contextUsedPercentage: number | null;
};

type UsagePayload = {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  updatedAt: number | null;
  agents: UsageAgent[];
};

const POLL_MS = 4_000;
const ADAPTER_PORT = process.env.NEXT_PUBLIC_CLAUDE_ADAPTER_PORT || "18789";
const COLLAPSE_KEY = "agent-office:usage-hud-collapsed";

const FAMILY_STYLE: Record<string, string> = {
  Opus: "border-violet-400/40 bg-violet-500/15 text-violet-200",
  Sonnet: "border-sky-400/40 bg-sky-500/15 text-sky-200",
  Haiku: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200",
  Fable: "border-orange-400/40 bg-orange-500/15 text-orange-200",
  Mythos: "border-orange-400/40 bg-orange-500/15 text-orange-200",
};

const STATUS_DOT: Record<UsageAgent["status"], string> = {
  running: "bg-green-400",
  waiting: "bg-orange-400 animate-pulse",
  error: "bg-red-400",
  idle: "bg-yellow-400/70",
};

const STATUS_LABEL: Record<UsageAgent["status"], string> = {
  running: "ishlayapti",
  waiting: "ruxsat kutyapti",
  error: "xato",
  idle: "bo'sh",
};

function barColor(percent: number) {
  if (percent >= 80) return "bg-red-400";
  if (percent >= 50) return "bg-amber-400";
  return "bg-emerald-400";
}

function formatReset(resetsAt: number | null, nowMs: number) {
  if (!resetsAt) return "";
  const minutes = Math.max(0, Math.round((resetsAt - nowMs) / 60_000));
  if (minutes >= 1440) {
    return `${Math.floor(minutes / 1440)} kun ${Math.floor((minutes % 1440) / 60)} soat`;
  }
  if (minutes >= 60) return `${Math.floor(minutes / 60)} soat ${minutes % 60} daq`;
  return `${minutes} daq`;
}

function formatAgo(ts: number | null, nowMs: number) {
  if (!ts) return "";
  const minutes = Math.floor((nowMs - ts) / 60_000);
  if (minutes < 1) return "hozirgina";
  if (minutes < 60) return `${minutes} daq oldin`;
  return `${Math.floor(minutes / 60)} soat oldin`;
}

function readCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function LimitBar({ label, window: win, nowMs }: { label: string; window: UsageWindow; nowMs: number }) {
  const percent = typeof win?.usedPercentage === "number" ? Math.min(100, Math.max(0, win.usedPercentage)) : null;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.14em]">
        <span className="text-amber-100/80">{label}</span>
        <span className="text-amber-50">{percent === null ? "—" : `${Math.round(percent)}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-700 ${percent === null ? "" : barColor(percent)}`}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      {win?.resetsAt ? (
        <div className="text-right font-mono text-[9px] text-amber-100/45">
          ↻ yangilanishiga {formatReset(win.resetsAt, nowMs)}
        </div>
      ) : null}
    </div>
  );
}

export function ClaudeUsageHud() {
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  useEffect(() => {
    let cancelled = false;
    const url = `${window.location.protocol === "https:" ? "https" : "http"}://${window.location.hostname}:${ADAPTER_PORT}/usage`;
    const poll = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as UsagePayload;
        if (!cancelled) setUsage(payload);
      } catch {
        if (!cancelled) setUsage(null);
      } finally {
        if (!cancelled) setNowMs(Date.now());
      }
    };
    void poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const toggle = () => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  const sessions = useMemo(() => {
    if (!usage) return [];
    const byParent = new Map<string, UsageAgent[]>();
    for (const agent of usage.agents) {
      if (agent.kind === "subagent" && agent.parentId) {
        byParent.set(agent.parentId, [...(byParent.get(agent.parentId) ?? []), agent]);
      }
    }
    return usage.agents
      .filter((agent) => agent.kind === "session")
      .map((agent) => ({ agent, helpers: byParent.get(agent.agentId) ?? [] }));
  }, [usage]);

  const team = useMemo(() => (usage ? usage.agents.filter((agent) => agent.kind === "roster") : []), [usage]);
  const sessionNameById = useMemo(
    () => new Map((usage?.agents ?? []).map((agent) => [agent.agentId, agent.name])),
    [usage],
  );

  if (!usage) return null;

  const hasLimits = usage.fiveHour !== null || usage.sevenDay !== null;
  const fivePercent = usage.fiveHour?.usedPercentage ?? null;

  return (
    <div className="pointer-events-auto absolute right-12 top-14 z-30 w-[260px] select-none rounded-2xl border border-amber-900/30 bg-[#120e08]/92 text-amber-50 shadow-2xl backdrop-blur-sm">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={!collapsed}
      >
        <Gauge className="h-3.5 w-3.5 text-amber-300/80" />
        <span className="flex-1 font-mono text-[10px] uppercase tracking-[0.18em] text-amber-300/90">Claude limit</span>
        {collapsed && typeof fivePercent === "number" ? (
          <span className="font-mono text-[10px] text-amber-50">{Math.round(fivePercent)}%</span>
        ) : null}
        {collapsed ? <ChevronDown className="h-3.5 w-3.5 text-amber-200/70" /> : <ChevronUp className="h-3.5 w-3.5 text-amber-200/70" />}
      </button>

      {collapsed ? null : (
        <div className="space-y-3 border-t border-amber-900/25 px-3 pb-3 pt-2.5">
          {hasLimits ? (
            <>
              <LimitBar label="5 soatlik" window={usage.fiveHour} nowMs={nowMs} />
              <LimitBar label="Haftalik" window={usage.sevenDay} nowMs={nowMs} />
              <div className="font-mono text-[9px] text-amber-100/40">
                Yangilandi: {formatAgo(usage.updatedAt, nowMs)}
              </div>
            </>
          ) : (
            <p className="text-[11px] leading-snug text-amber-100/60">
              Limit ma&apos;lumoti Claude Code terminalidagi status line orqali keladi. Terminalda bitta so&apos;rov yuboring.
            </p>
          )}

          <div className="space-y-1.5 border-t border-amber-900/25 pt-2.5">
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber-500/70">
              Sessiyalar · {sessions.length}
            </div>
            {sessions.length === 0 ? (
              <p className="text-[11px] text-amber-100/50">Hozircha ochiq Claude Code sessiyasi yo&apos;q.</p>
            ) : (
              sessions.map(({ agent, helpers }) => (
                <div key={agent.agentId} className="space-y-1">
                  <AgentRow agent={agent} />
                  {helpers.map((helper) => (
                    <div key={helper.agentId} className="pl-4">
                      <AgentRow agent={helper} />
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          {team.length > 0 ? (
            <div className="space-y-1.5 border-t border-amber-900/25 pt-2.5">
              <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber-500/70">
                Jamoa · {team.filter((member) => member.status === "running").length}/{team.length} band
              </div>
              {team.map((member) => (
                <AgentRow
                  key={member.agentId}
                  agent={member}
                  hint={member.parentId ? sessionNameById.get(member.parentId) : undefined}
                />
              ))}
            </div>
          ) : null}
          <LanguageSwitch />
        </div>
      )}
    </div>
  );
}

function AgentRow({ agent, hint }: { agent: UsageAgent; hint?: string }) {
  const family = agent.modelFamily;
  return (
    <div className="flex items-center gap-2" title={agent.currentTool ?? STATUS_LABEL[agent.status]}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[agent.status]}`} />
      <span className="min-w-0 flex-1 truncate text-[11px] text-amber-50/90" data-no-translate>
        {agent.kind === "subagent" ? "↳ " : ""}
        {agent.name}
        {hint ? <span className="text-amber-100/40"> → {hint}</span> : null}
      </span>
      {typeof agent.contextUsedPercentage === "number" ? (
        <span className="font-mono text-[9px] text-amber-100/45">ctx {Math.round(agent.contextUsedPercentage)}%</span>
      ) : null}
      {family ? (
        <span
          className={`rounded-full border px-1.5 py-px font-mono text-[9px] ${FAMILY_STYLE[family] ?? "border-amber-400/30 text-amber-100"}`}
        >
          {family}
        </span>
      ) : null}
    </div>
  );
}

function LanguageSwitch() {
  const lang = useSyncExternalStore(
    () => () => {},
    readUiLang,
    () => "uz" as const,
  );
  const choose = (next: "uz" | "en") => {
    if (next === lang) return;
    try {
      window.localStorage.setItem(UI_LANG_KEY, next);
    } catch {}
    window.location.reload();
  };
  return (
    <div className="flex items-center justify-between border-t border-amber-900/25 pt-2.5" data-no-translate>
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber-500/70">Til</span>
      <div className="flex gap-1">
        {(["uz", "en"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => choose(option)}
            className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase transition-colors ${
              lang === option
                ? "border-amber-400/60 bg-amber-500/20 text-amber-50"
                : "border-amber-900/40 text-amber-100/50 hover:text-amber-50"
            }`}
          >
            {option === "uz" ? "O'zbekcha" : "English"}
          </button>
        ))}
      </div>
    </div>
  );
}
