// Shared content bootstrap for every platform.
//
// Each platform's content entry just does:
//   import { initContent } from "@/content/dock";
//   import { XDriver } from "@/platforms/x/driver";
//   initContent(new XDriver());
//
// This wires: boot (honor a popup "start here" request, else resume a run),
// SPA-navigation re-render, popup Start/Stop commands, and the floating
// control dock with live status.

import type { PlatformDriver } from "@/shared/driver";
import { startAutopilot, stopAutopilot, resumeIfRunning } from "@/lib/engine";
import type { AutopilotState, Msg } from "@/shared/types";

const DOCK_ID = "ja-dock";

export function initContent(driver: PlatformDriver): void {
  console.log(`[Autopilot] ${driver.platform} content script loaded`);

  // Boot: a popup "start here" beats resuming.
  (async () => {
    try {
      const { pendingStart } = await chrome.storage.local.get("pendingStart");
      if (pendingStart) {
        await chrome.storage.local.remove("pendingStart");
        await startAutopilot(driver);
        return;
      }
    } catch {
      /* fall through */
    }
    resumeIfRunning(driver).catch((e) => console.error("[Autopilot] resume failed", e));
  })();

  // Re-render the dock on SPA navigation.
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      renderDock(driver);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Popup commands.
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const msg = raw as Msg;
    if (msg?.kind === "autopilot-command") {
      if (msg.command === "start") startAutopilot(driver).catch((e) => console.error("[Autopilot] start failed", e));
      else stopAutopilot().catch(() => {});
      sendResponse({ ok: true, data: { acked: true } });
      return true;
    }
    return false;
  });

  // Live state → dock.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.autopilotState) renderDock(driver);
  });

  setTimeout(() => renderDock(driver), 1200);
}

async function getState(): Promise<AutopilotState | null> {
  try {
    const r = await chrome.storage.local.get("autopilotState");
    return (r.autopilotState as AutopilotState) ?? null;
  } catch {
    return null;
  }
}

async function renderDock(driver: PlatformDriver) {
  const state = await getState();
  let dock = document.getElementById(DOCK_ID);
  if (!dock) {
    dock = document.createElement("div");
    dock.id = DOCK_ID;
    Object.assign(dock.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      width: "300px",
      background: "#14171f",
      color: "#e5e8ef",
      border: "1px solid #232838",
      borderRadius: "12px",
      zIndex: "2147483646",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      fontSize: "13px",
      boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
      overflow: "hidden",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(dock);
  }

  const running = !!state?.running;
  const phase = state?.phase ?? "idle";
  const paused = phase === "paused";
  const dot = running ? (paused ? "#f6b73c" : "#19c37d") : "#8a93a6";
  const applied = state?.appliedToday ?? 0;

  dock.innerHTML = `
    <div style="display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid #232838;" id="ja-dock-head">
      <span style="width:9px;height:9px;border-radius:50%;background:${dot};box-shadow:0 0 8px ${dot};"></span>
      <strong style="flex:1;font-size:13px;">🚀 Autopilot</strong>
      <span style="font-size:11px;color:#8a93a6;">${applied} today</span>
      <span id="ja-dock-min" style="color:#8a93a6;cursor:pointer;padding:0 4px;">—</span>
    </div>
    <div id="ja-dock-body" style="padding:12px 14px;">
      <div style="font-size:11px;color:#8a93a6;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">${esc(phase)} · ${esc(driver.platform)}</div>
      <div style="font-size:12.5px;line-height:1.5;margin-bottom:10px;min-height:34px;">${esc(state?.lastMessage || "Idle. Press Start to begin.")}</div>
      ${state?.currentJob ? `<div style="font-size:11.5px;color:#9aa3b5;margin-bottom:10px;">▸ ${esc(state.currentJob.title)} · ${esc(state.currentJob.company)}</div>` : ""}
      ${paused ? `<div style="background:rgba(246,183,60,.08);border:1px solid rgba(246,183,60,.3);border-radius:7px;padding:9px 11px;font-size:11.5px;line-height:1.45;margin-bottom:10px;color:#f6b73c;">${esc(state?.pauseReason || "Paused — needs you.")}</div>` : ""}
      <div style="display:flex;gap:8px;">
        ${
          running && !paused
            ? `<button id="ja-stop" style="${btn("#f0556d")}">Stop</button>`
            : paused
            ? `<button id="ja-resume" style="${btn("#19c37d")}">Resume</button><button id="ja-stop" style="${btn("#2a3042")}">Stop</button>`
            : `<button id="ja-start" style="${btn("linear-gradient(135deg,#6d5efc,#4096ff)")}">Start autopilot</button>`
        }
      </div>
    </div>
  `;

  dock.querySelector("#ja-start")?.addEventListener("click", () => startAutopilot(driver).catch((e) => console.error(e)));
  dock.querySelector("#ja-stop")?.addEventListener("click", () => stopAutopilot().catch(() => {}));
  dock.querySelector("#ja-resume")?.addEventListener("click", () => resumeIfRunning(driver).catch((e) => console.error(e)));

  const body = dock.querySelector<HTMLElement>("#ja-dock-body");
  dock.querySelector("#ja-dock-min")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (body) body.style.display = body.style.display === "none" ? "block" : "none";
  });
}

function btn(bg: string): string {
  return `flex:1;background:${bg};color:#fff;border:none;padding:9px 12px;border-radius:7px;cursor:pointer;font-weight:600;font-size:12.5px;`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
