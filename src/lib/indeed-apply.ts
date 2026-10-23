// Indeed Apply iframe helper.
//
// Runs INSIDE the Indeed Apply form (a cross-origin *.indeed.com iframe, or the
// standalone smartapply tab) — the one place that can read and fill that form.
// The top-frame engine published the apply context to chrome.storage
// ("activeApply"); this helper reads it, walks the form's steps, and reports
// progress back under "indeedApplyStatus" so the top-frame driver can advance.
//
// It re-executes on every iframe load (Indeed navigates between steps), so each
// run fills whatever step is currently visible and clicks Continue/Submit —
// the next load handles the next step. A short in-run loop also covers steps
// that transition without a reload.

import {
  attachFile,
  cleanText,
  findButton,
  isVisible,
  sleep,
  textOf,
  waitFor,
} from "@/shared/driver";
import { scanGenericFields, resolveFieldValue, applyFieldValue } from "@/lib/formfill";
import type { ActiveApply, IframeApplyStatus, MsgResponse, StoredPdf } from "@/shared/types";

const WRAPPERS = "fieldset, [class*='FormField'], [class*='field'], [data-testid], label";
const STATUS_KEY = "indeedApplyStatus";
const MAX_INRUN_STEPS = 6;

let busy = false;

export async function runIndeedApplyHelper(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const active = await read<ActiveApply>("activeApply");
    if (!active) return; // no apply in progress — not our job
    // Ignore a stale context (> 20 min old).
    if (Date.now() - active.createdAt > 20 * 60_000) return;

    const prior = await read<IframeApplyStatus>(STATUS_KEY);
    if (prior && prior.applyId === active.applyId && prior.status !== "working") return; // already settled

    await setStatus(active.applyId, "working");
    await drive(active);
  } catch (e) {
    const active = await read<ActiveApply>("activeApply");
    if (active) await setStatus(active.applyId, "error", (e as Error).message);
  } finally {
    busy = false;
  }
}

async function drive(active: ActiveApply): Promise<void> {
  const file = await loadResumeFile();

  for (let step = 0; step < MAX_INRUN_STEPS; step++) {
    await sleep(700); // let the step render

    if (detectCaptcha()) {
      await setStatus(active.applyId, "paused", "A CAPTCHA/security check appeared in Indeed Apply.");
      return;
    }
    if (isSuccess()) {
      await setStatus(active.applyId, "submitted");
      return;
    }

    // Attach resume if this step has a file input.
    if (file) {
      for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("input[type=file]"))) {
        if (isVisible(input) && (!input.files || input.files.length === 0)) attachFile(input, file);
      }
    }

    // Fill every recognizable field on this step.
    const fields = scanGenericFields(document.body, WRAPPERS);
    for (const field of fields) {
      const value = await resolveFieldValue(field, active.profile, active.tailor, active.job);
      if (value === null) {
        if (field.required && active.pauseOnUnknownRequired) {
          await setStatus(active.applyId, "paused", `Couldn't answer required field: "${field.label || "(unlabeled)"}".`);
          return;
        }
        continue;
      }
      applyFieldValue(field, value, document);
      await sleep(120);
    }

    await sleep(300);

    // Submit (final step).
    const submit = findButton(document, ["submit your application", "submit application", "submit"]);
    if (submit) {
      if (active.submitMode === "auto") {
        submit.click();
        await waitFor(() => (isSuccess() ? true : null), 6000);
        await setStatus(active.applyId, isSuccess() ? "submitted" : "submitted"); // assume sent
        return;
      }
      await setStatus(active.applyId, "done", "Filled — review and submit in the Indeed window.");
      return;
    }

    // Otherwise advance: Continue / Review.
    const next = findButton(document, ["continue", "review your application", "review", "next"]);
    if (!next) {
      // Nothing to do on this step — maybe it's a confirmation or an unknown UI.
      if (isSuccess()) {
        await setStatus(active.applyId, "submitted");
      } else {
        await setStatus(active.applyId, "paused", "Reached an Indeed Apply step I couldn't complete.");
      }
      return;
    }
    next.click();
    // If this triggers an iframe navigation, this lifetime ends and the next
    // load re-runs the helper for the following step.
    await sleep(900);
  }
  // Ran out of in-run steps without finishing; the next load continues.
}

// ---------------------------------------------------------------------------

function isSuccess(): boolean {
  const txt = (document.body.textContent || "").toLowerCase();
  if (/your application has been submitted|application submitted|you(?:'ve| have) applied|successfully applied|application sent/.test(txt)) {
    return true;
  }
  return !!document.querySelector("[data-testid='post-apply-screen'], [class*='PostApply'], [class*='applied-success']");
}

function detectCaptcha(): boolean {
  return !!document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], [class*='captcha'], #px-captcha");
}

/** True when this frame actually contains an Indeed Apply form. */
export function looksLikeIndeedApply(): boolean {
  if (/smartapply|apply\.indeed\.com|\/apply/i.test(location.href)) return true;
  const txt = cleanText(textOf(document.querySelector("h1, h2"))).toLowerCase();
  if (/add your|application|resume|contact information/.test(txt) && document.querySelector("input, textarea, [role='button'], button")) {
    return true;
  }
  return !!document.querySelector("[class*='ia-container'], [data-testid='indeedApplyButton'], form[action*='apply']");
}

async function loadResumeFile(): Promise<File | null> {
  const res = (await chrome.runtime.sendMessage({ kind: "get-resume-pdf" })) as MsgResponse<StoredPdf>;
  if (!res.ok || !res.data) return null;
  try {
    const bin = atob(res.data.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], res.data.filename, { type: "application/pdf" });
  } catch {
    return null;
  }
}

async function read<T>(key: string): Promise<T | null> {
  try {
    const r = await chrome.storage.local.get(key);
    return (r[key] as T) ?? null;
  } catch {
    return null;
  }
}

async function setStatus(applyId: string, status: IframeApplyStatus["status"], reason?: string): Promise<void> {
  const payload: IframeApplyStatus = { applyId, status, reason, updatedAt: Date.now() };
  try {
    await chrome.storage.local.set({ [STATUS_KEY]: payload });
  } catch {
    /* ignore */
  }
}
