// Background service worker — MV3 entry point.
//
// Owns everything that must not live in a page context:
//   • Claude API calls (resume parsing, tailoring, live question answering) —
//     the API key never leaves this worker.
//   • chrome.storage reads/writes on behalf of popup + content scripts.
//   • The applied log, the per-day counter, and live autopilot state.
//
// MV3 workers are not long-lived; we keep no mutable module state — everything
// durable goes through chrome.storage (via storage.ts).

import { parseResume, tailorResume, answerQuestion, ClaudeError } from "@/lib/claude";
import { storage } from "@/lib/storage";
import type { Msg, MsgResponse, Profile, Settings } from "@/shared/types";

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.action.openPopup().catch(() => {/* can't always auto-open */});
  }
});

chrome.runtime.onMessage.addListener((rawMsg: unknown, _sender, sendResponse) => {
  handleMessage(rawMsg as Msg)
    .then((response) => sendResponse(response))
    .catch((err: Error) => {
      console.error("[Autopilot] message handler error", err);
      sendResponse({ ok: false, error: err.message } satisfies MsgResponse);
    });
  return true; // keep the channel open for the async response
});

async function handleMessage(msg: Msg): Promise<MsgResponse> {
  switch (msg.kind) {
    case "ping":
      return { ok: true, data: { pong: Date.now() } };

    case "get-profile": {
      const [profile, resume, prefs] = await Promise.all([
        storage.getProfile(),
        storage.getResume(),
        storage.getPrefs(),
      ]);
      return { ok: true, data: { profile, resume, prefs } };
    }

    case "get-settings": {
      // The key stays in the worker; callers get it masked.
      const s = await storage.getSettings();
      return { ok: true, data: { ...s, anthropicApiKey: s.anthropicApiKey ? "•".repeat(12) : "" } };
    }

    case "get-resume-pdf": {
      const r = await storage.getResume();
      if (!r?.pdfBase64) return { ok: true, data: null };
      return { ok: true, data: { base64: r.pdfBase64, filename: r.pdfFilename || "resume.pdf", bytes: r.pdfBytes || 0 } };
    }

    case "parse-resume": {
      const settings = await requireKey();
      const parsed = await guardClaude(() => parseResume(msg.resumeText, settings.anthropicApiKey, settings.parseModel));
      const merged = await storage.mergeProfile(parsed);
      return { ok: true, data: { profile: merged } };
    }

    case "tailor": {
      const [profile, resume, prefs, settings] = await Promise.all([
        storage.getProfile(),
        storage.getResume(),
        storage.getPrefs(),
        storage.getSettings(),
      ]);
      if (!resume) throw new Error("No resume saved. Open the popup → Profile.");
      if (!profileLooksComplete(profile)) throw new Error("Profile incomplete — name, email and phone are required.");
      if (!keyValid(settings)) throw new Error("Anthropic API key not set. Open the popup → Settings.");
      const result = await guardClaude(() =>
        tailorResume({ job: msg.job, profile, resume, prefs, apiKey: settings.anthropicApiKey, model: settings.model }),
      );
      return { ok: true, data: result };
    }

    case "answer-question": {
      const [profile, settings] = await Promise.all([storage.getProfile(), storage.getSettings()]);
      if (!keyValid(settings)) throw new Error("Anthropic API key not set.");
      const result = await guardClaude(() =>
        answerQuestion(msg.question, msg.options, profile, msg.job, settings.anthropicApiKey, settings.model),
      );
      return { ok: true, data: result };
    }

    case "save-applied":
      await storage.addApplied(msg.job);
      return { ok: true, data: { saved: true } };

    case "already-applied": {
      const applied = await storage.hasApplied(msg.id);
      return { ok: true, data: { applied } };
    }

    case "get-autopilot-state": {
      // Refresh the live count from the authoritative daily counter.
      const [state, count] = await Promise.all([storage.getAutopilotState(), storage.getAppliedToday()]);
      const synced = state.appliedToday === count ? state : await storage.setAutopilotState({ appliedToday: count });
      return { ok: true, data: synced };
    }

    case "set-autopilot-state": {
      const next = await storage.setAutopilotState(msg.patch);
      return { ok: true, data: next };
    }

    case "bump-applied-count": {
      const count = await storage.bumpAppliedToday();
      await storage.setAutopilotState({ appliedToday: count });
      return { ok: true, data: { count } };
    }

    case "autopilot-command":
      // Autopilot commands are delivered by the popup straight to the tab's
      // content script; the worker has nothing to do here.
      return { ok: true, data: { ignored: true } };

    default:
      return { ok: false, error: `Unknown message: ${(msg as { kind?: string }).kind}` };
  }
}

async function requireKey(): Promise<Settings> {
  const s = await storage.getSettings();
  if (!keyValid(s)) throw new Error("Anthropic API key not set. Open the popup → Settings.");
  return s;
}

async function guardClaude<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ClaudeError) throw new Error(e.message);
    throw e;
  }
}

function profileLooksComplete(p: Profile): boolean {
  return !!(p.fullName.trim() && p.email.trim() && p.phone.trim());
}

function keyValid(s: Settings): boolean {
  return !!(s.anthropicApiKey && s.anthropicApiKey.startsWith("sk-ant-"));
}
