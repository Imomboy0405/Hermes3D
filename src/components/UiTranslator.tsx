"use client";

import { useEffect } from "react";
import { UZ_PATTERNS, UZ_STRINGS } from "@/lib/i18n/uz";

/**
 * Runtime UI translation for Agent Office.
 *
 * Watches the DOM and replaces English text nodes and a few attributes that
 * match src/lib/i18n/uz.ts. It only rewrites a node's text in place (never
 * adds or removes nodes), so React keeps working normally: when React writes
 * a new value the observer sees it and translates it again.
 *
 * Skipped on purpose: agent replies (.agent-markdown), code, inputs, and any
 * subtree marked data-no-translate.
 *
 * Language: localStorage "agent-office:lang" = "uz" (default) | "en".
 */

export const UI_LANG_KEY = "agent-office:lang";

const ATTRIBUTES = ["placeholder", "title", "aria-label"] as const;
const SKIP_SELECTOR =
  "script,style,code,pre,textarea,.agent-markdown,[contenteditable='true'],[data-no-translate]";

const lowerMap = new Map<string, string>();
for (const [key, value] of Object.entries(UZ_STRINGS)) lowerMap.set(key.toLowerCase(), value);

export const readUiLang = (): "uz" | "en" => {
  try {
    return window.localStorage.getItem(UI_LANG_KEY) === "en" ? "en" : "uz";
  } catch {
    return "uz";
  }
};

const isAllCaps = (text: string) => /[A-Z]/.test(text) && text === text.toUpperCase();

function lookup(text: string): string | null {
  const exact = UZ_STRINGS[text];
  if (exact !== undefined) return exact;
  const loose = lowerMap.get(text.toLowerCase());
  if (loose !== undefined) return isAllCaps(text) ? loose.toLocaleUpperCase("uz") : loose;
  for (const [pattern, template] of UZ_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const result = template.replace(/\$(\d)/g, (_, index: string) => {
      const group = match[Number(index)] ?? "";
      return lookup(group) ?? group;
    });
    return isAllCaps(text) ? result.toLocaleUpperCase("uz") : result;
  }
  return null;
}

function translateString(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 200) return null;
  const translated = lookup(trimmed);
  if (translated === null || translated === trimmed) return null;
  const start = value.indexOf(trimmed);
  return value.slice(0, start) + translated + value.slice(start + trimmed.length);
}

const shouldSkip = (element: Element | null) => !element || element.closest(SKIP_SELECTOR) !== null;

function translateTextNode(node: Text) {
  if (shouldSkip(node.parentElement)) return;
  const next = translateString(node.nodeValue ?? "");
  if (next !== null && next !== node.nodeValue) node.nodeValue = next;
}

function translateAttributes(element: Element) {
  if (shouldSkip(element)) return;
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (!value) continue;
    const next = translateString(value);
    if (next !== null && next !== value) element.setAttribute(name, next);
  }
}

function translateTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const element = root as Element;
  if (shouldSkip(element)) return;
  translateAttributes(element);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) translateTextNode(current as Text);
    else translateAttributes(current as Element);
    current = walker.nextNode();
  }
}

export function UiTranslator() {
  useEffect(() => {
    if (readUiLang() !== "uz") return;
    document.documentElement.lang = "uz";

    // Server-rendered text must stay untouched until React has hydrated every
    // boundary, or hydration fails and the tree is re-rendered. Start once the
    // page has loaded and settled; client renders before then are covered by
    // the full pass.
    let ready = false;
    let timer: number | null = null;
    const start = () => {
      timer = window.setTimeout(() => {
        ready = true;
        translateTree(document.body);
      }, 1500);
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });

    const observer = new MutationObserver((mutations) => {
      if (!ready) return;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          translateTextNode(mutation.target as Text);
        } else if (mutation.type === "attributes") {
          translateAttributes(mutation.target as Element);
        } else {
          mutation.addedNodes.forEach(translateTree);
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRIBUTES],
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("load", start);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return null;
}
