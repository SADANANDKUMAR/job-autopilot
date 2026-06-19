// Background service worker — MV3 entry point.
//
// Responsibilities:
//   • Listen for messages from popup + content script (chrome.runtime.onMessage)
//   • Proxy Claude API calls (so the API key never reaches the LinkedIn page)
//   • Read/write chrome.storage on behalf of callers
//   • Maintain the applied-jobs log
//
// MV3 service workers are NOT long-lived — Chrome can shut us down between
// events. Don't hold mutable state in module scope; reach for chrome.storage
// instead.

import { tailorResume, ClaudeError } from "@/lib/claude";
import { storage } from "@/lib/storage";
import type { Msg, MsgResponse, TailorResult, Profile, Settings } from "@/shared/types";

// Welcome page on first install
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.action.openPopup().catch(() => {/* popup might not be allowed to auto-open */});
  }
});

// Single message dispatcher. We return `true` from the listener to keep the
// channel open for the async response — required by chrome.runtime.
chrome.runtime.onMessage.addListener((rawMsg: unknown, _sender, sendResponse) => {
  handleMessage(rawMsg as Msg)
    .then((response) => sendResponse(response))
    .catch((err: Error) => {
      console.error("[Job Autopilot] message handler error", err);
      sendResponse({ ok: false, error: err.message } satisfies MsgResponse);
    });
  return true;
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
      const settings = await storage.getSettings();
      // NEVER ship the raw API key over chrome.runtime messaging to the
      // content script (which lives in LinkedIn's page context). Mask it.
      return { ok: true, data: { ...settings, anthropicApiKey: settings.anthropicApiKey ? "•".repeat(12) : "" } };
    }

    case "tailor": {
      const [profile, resume, prefs, settings] = await Promise.all([
        storage.getProfile(),
        storage.getResume(),
        storage.getPrefs(),
        storage.getSettings(),
      ]);

      if (!resume) {
        throw new Error("No resume saved. Open Job Autopilot popup → Profile → paste your resume.");
      }
      if (!profileLooksComplete(profile)) {
        throw new Error("Profile incomplete. Open the popup and fill in name + email + phone + location.");
      }
      if (!settingsLookValid(settings)) {
        throw new Error("Anthropic API key not set. Open the popup → Settings → paste your sk-ant-... key.");
      }

      try {
        const result: TailorResult = await tailorResume({
          job: msg.job,
          profile,
          resume,
          prefs,
          apiKey: settings.anthropicApiKey,
          model: settings.model,
        });
        return { ok: true, data: result };
      } catch (e) {
        if (e instanceof ClaudeError) {
          throw new Error(e.message);
        }
        throw e;
      }
    }

    case "save-applied":
      await storage.addApplied(msg.job);
      return { ok: true, data: { saved: true } };
  }
}

function profileLooksComplete(p: Profile): boolean {
  return !!(p.fullName.trim() && p.email.trim() && p.phone.trim() && p.location.trim());
}

function settingsLookValid(s: Settings): boolean {
  return !!(s.anthropicApiKey && s.anthropicApiKey.startsWith("sk-ant-"));
}
