// PlatformDriver — the per-site contract the autopilot engine drives.
//
// LinkedIn, Naukri and Indeed each ship a module implementing this interface.
// The engine (src/lib/engine.ts) is 100% site-agnostic: it only ever talks to
// a driver. Adding a new job board = writing one new driver, no engine change.
//
// Every method is written to FAIL SOFT: return null / false / "unknown"
// instead of throwing, so a broken selector pauses the run rather than
// crashing the host page.

import type { JobCard, JobPosting, Platform } from "@/shared/types";

/** A form control the filler recognizes, normalized across sites. */
export type FieldType =
  | "text"
  | "email"
  | "tel"
  | "number"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "file"
  | "unknown";

export type FormField = {
  key: string;            // stable-ish id for dedupe/logging
  label: string;          // accessible label text
  type: FieldType;
  element: HTMLElement;
  required: boolean;
  currentValue: string;
  options?: string[];     // select / radio-group option labels
};

/** What advance() reports after trying to move the application forward. */
export type AdvanceResult =
  | { status: "next" }               // moved to the next step, keep filling
  | { status: "submit-ready"; button: HTMLButtonElement } // at final submit
  | { status: "submitted" }          // we already submitted (site auto-closed)
  | { status: "done" }               // flow finished / confirmation shown
  | { status: "blocked"; reason: string }; // unknown step, needs a human

/** Opaque per-application handle (usually the modal/root element). */
export type ApplyHandle = {
  root: HTMLElement;
  step: number;
};

export interface PlatformDriver {
  readonly platform: Platform;

  // ---- page classification -------------------------------------------------
  /** True when the current page is this site's search-results page. */
  isSearchPage(): boolean;
  /** True when the current page is a single-job detail view. */
  isJobPage(): boolean;

  // ---- searching -----------------------------------------------------------
  /** URL for a search given keyword + location (+ remote flag). */
  buildSearchUrl(keyword: string, location: string, remoteOk: boolean): string;
  /** Harvest the job cards currently rendered on the results page. */
  collectJobCards(): JobCard[];
  /** Reveal more results (scroll / click "next"). Resolves false when exhausted. */
  loadMoreResults(): Promise<boolean>;

  // ---- a single job --------------------------------------------------------
  /**
   * Open the given card's detail view.
   *  - "opened": rendered in-place (SPA) — the engine applies now.
   *  - "navigating": a hard navigation was triggered — this content-script
   *    lifetime ends; the engine persists the pending job and resumes the
   *    apply on the next boot (see isJobPage / scrapeJob on the new page).
   *  - "failed": couldn't open it; the engine skips.
   */
  openJob(card: JobCard): Promise<"opened" | "navigating" | "failed">;
  /** Scrape the open job detail page into a full posting (with JD text). */
  scrapeJob(): JobPosting | null;
  /** Can we auto-apply here (Easy Apply / quick-apply), vs external redirect? */
  canAutoApply(): boolean;
  /** Does the site already show this job as applied? */
  alreadyApplied(): boolean;

  // ---- the apply flow ------------------------------------------------------
  /** Click the site's apply button and wait for the form/modal. */
  startApply(): Promise<ApplyHandle | null>;
  /** Scan the current step's fillable fields. */
  scanFields(handle: ApplyHandle): FormField[];
  /** Attach the resume PDF to any resume file-input in the current step. */
  attachResume(handle: ApplyHandle, file: File): Promise<number>;
  /** Set a text/number/select/radio/checkbox field's value. */
  setFieldValue(field: FormField, value: string): Promise<boolean>;
  /** Try to move forward; reports whether we're at submit, blocked, or done. */
  advance(handle: ApplyHandle): Promise<AdvanceResult>;
  /** Click the final submit button (auto mode only). */
  submit(button: HTMLButtonElement): Promise<boolean>;
  /** Best-effort: is a CAPTCHA / bot-check on screen right now? */
  detectCaptcha(): boolean;
  /** Dismiss/close an open apply modal (e.g. after assisted fill or a skip). */
  closeApply(handle: ApplyHandle): void;
}

// ---------------------------------------------------------------------------
// Shared DOM helpers every driver reuses.
// ---------------------------------------------------------------------------

export function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function textOf(el: Element | null | undefined): string {
  return el?.textContent?.trim() || "";
}

export function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/(["\\[\]])/g, "\\$1");
}

/** Fire React-compatible input events so controlled inputs commit the value. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function setSelect(el: HTMLSelectElement, value: string): boolean {
  const wanted = value.trim().toLowerCase();
  const opt =
    Array.from(el.options).find((o) => o.text.trim().toLowerCase() === wanted) ||
    Array.from(el.options).find((o) => o.value.trim().toLowerCase() === wanted) ||
    // fuzzy: option contains the wanted text or vice-versa (yes/no, country…)
    Array.from(el.options).find(
      (o) => o.text.trim().toLowerCase().includes(wanted) || (wanted.length > 2 && wanted.includes(o.text.trim().toLowerCase())),
    );
  if (!opt) return false;
  el.value = opt.value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Attach a File to an <input type=file> the way drag-drop does (React-safe). */
export function attachFile(input: HTMLInputElement, file: File): boolean {
  if (input.type !== "file") return false;
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  } catch (e) {
    console.warn("[Autopilot] file attach failed", e);
    return false;
  }
}

export function inferType(el: HTMLElement): FieldType {
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLInputElement) {
    const t = (el.type || "text").toLowerCase();
    if (t === "email") return "email";
    if (t === "tel") return "tel";
    if (t === "number") return "number";
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "file") return "file";
    if (t === "hidden" || t === "submit" || t === "button" || t === "search") return "unknown";
    return "text";
  }
  return "unknown";
}

export function labelFor(ctrl: HTMLElement, wrapperSelectors: string): string {
  const aria = ctrl.getAttribute("aria-label");
  if (aria) return cleanText(aria);

  const labelledby = ctrl.getAttribute("aria-labelledby");
  if (labelledby) {
    const parts = labelledby.split(/\s+/).map((id) => textOf(document.getElementById(id)));
    const joined = cleanText(parts.join(" "));
    if (joined) return joined;
  }

  const id = ctrl.id;
  if (id) {
    const lbl = document.querySelector(`label[for="${cssEscape(id)}"]`);
    if (lbl) return cleanText(lbl.textContent || "");
  }

  const wrapping = ctrl.closest("label");
  if (wrapping) return cleanText(wrapping.textContent || "");

  const wrapper = ctrl.closest(wrapperSelectors);
  if (wrapper) {
    const lbl = wrapper.querySelector("label, legend, .label, [class*='label']");
    if (lbl) return cleanText(lbl.textContent || "");
  }

  const ph = ctrl.getAttribute("placeholder");
  if (ph) return cleanText(ph);

  return "";
}

export function waitFor<T>(predicate: () => T | null | undefined, timeoutMs: number, intervalMs = 120): Promise<T | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      let v: T | null | undefined = null;
      try {
        v = predicate();
      } catch {
        v = null;
      }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A visible, clickable button whose text/aria matches any needle. */
export function findButton(root: ParentNode, needles: string[]): HTMLButtonElement | null {
  const btns = root.querySelectorAll<HTMLButtonElement>("button, [role='button']");
  for (const b of Array.from(btns)) {
    if (b.getAttribute("disabled") !== null || b.getAttribute("aria-disabled") === "true") continue;
    const hay = `${b.getAttribute("aria-label") || ""} ${b.textContent || ""}`.toLowerCase();
    if (needles.some((n) => hay.includes(n))) return b;
  }
  return null;
}

/** True if the element is on-screen (has layout + not display:none). */
export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}
