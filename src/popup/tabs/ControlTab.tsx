import { useEffect, useState } from "react";
import type { AutopilotState, Settings, Preferences, Profile, Resume } from "@/shared/types";

type Readiness = { ok: boolean; items: Array<{ label: string; done: boolean }> };

const SUPPORTED = /linkedin\.com\/jobs\/|naukri\.com\/|indeed\.com\//;

function openUrl(platform: "linkedin" | "naukri" | "indeed", title: string, loc: string): string {
  if (platform === "naukri") {
    const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const kw = slug(title) || "jobs";
    return loc ? `https://www.naukri.com/${kw}-jobs-in-${slug(loc)}` : `https://www.naukri.com/${kw}-jobs`;
  }
  if (platform === "indeed") {
    return `https://in.indeed.com/jobs?q=${encodeURIComponent(title)}&l=${encodeURIComponent(loc)}`;
  }
  return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(title)}&location=${encodeURIComponent(loc)}&f_AL=true`;
}

const LABELS: Record<"linkedin" | "naukri" | "indeed", string> = { linkedin: "LinkedIn", naukri: "Naukri", indeed: "Indeed" };

export default function ControlTab({
  profile,
  resume,
  prefs,
  settings,
  onGoto,
}: {
  profile: Profile;
  resume: Resume | null;
  prefs: Preferences;
  settings: Settings;
  onGoto: (tab: "profile" | "prefs" | "settings") => void;
}) {
  const [state, setState] = useState<AutopilotState | null>(null);
  const [activeUrl, setActiveUrl] = useState<string>("");

  // Live autopilot state (updated by the engine via chrome.storage).
  useEffect(() => {
    const load = async () => {
      const r = await chrome.storage.local.get("autopilotState");
      setState((r.autopilotState as AutopilotState) ?? null);
    };
    load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes.autopilotState) setState(changes.autopilotState.newValue as AutopilotState);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setActiveUrl(t?.url || ""));
  }, []);

  const readiness = computeReadiness(profile, resume, prefs, settings);
  const running = !!state?.running;
  const paused = state?.phase === "paused";
  const onSupported = SUPPORTED.test(activeUrl);
  const launchPlatform: "linkedin" | "naukri" | "indeed" =
    (["linkedin", "naukri", "indeed"] as const).find((p) => settings.enabledPlatforms.includes(p)) || "linkedin";

  const sendCommand = async (command: "start" | "stop") => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && SUPPORTED.test(tab.url || "")) {
      try {
        await chrome.tabs.sendMessage(tab.id, { kind: "autopilot-command", command });
        return;
      } catch {
        /* content script not ready — fall through */
      }
    }
    if (command === "start") {
      // Not on a supported jobs tab: open one and auto-start on boot.
      await chrome.storage.local.set({ pendingStart: true });
      await chrome.tabs.create({ url: openUrl(launchPlatform, prefs.targetTitles[0] || "", prefs.targetLocations[0] || "") });
    }
  };

  return (
    <div>
      <h3 className="section-title">Autopilot</h3>

      {/* Live status card */}
      <div
        style={{
          background: "var(--panel-2)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: running ? (paused ? "#f6b73c" : "#19c37d") : "#8a93a6",
              boxShadow: running ? `0 0 8px ${paused ? "#f6b73c" : "#19c37d"}` : "none",
            }}
          />
          <strong style={{ flex: 1, textTransform: "capitalize" }}>{state?.phase ?? "idle"}</strong>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {state?.appliedToday ?? 0}/{settings.dailyCap} today
          </span>
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, minHeight: 20, color: "var(--text)" }}>
          {state?.lastMessage || "Idle. Press Start to begin applying."}
        </div>
        {state?.currentJob && (
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>
            ▸ {state.currentJob.title} · {state.currentJob.company}
          </div>
        )}
        {paused && state?.pauseReason && (
          <div
            style={{
              marginTop: 10,
              background: "rgba(246,183,60,.08)",
              border: "1px solid rgba(246,183,60,.3)",
              borderRadius: 7,
              padding: "9px 11px",
              fontSize: 11.5,
              color: "#f6b73c",
              lineHeight: 1.45,
            }}
          >
            {state.pauseReason}
          </div>
        )}
      </div>

      {/* Readiness checklist */}
      {!readiness.ok && (
        <div style={{ marginBottom: 14 }}>
          {readiness.items.map((it) => (
            <div
              key={it.label}
              onClick={() => {
                if (it.label.includes("resume") || it.label.includes("Profile")) onGoto("profile");
                else if (it.label.includes("target")) onGoto("prefs");
                else onGoto("settings");
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12.5,
                padding: "6px 0",
                cursor: it.done ? "default" : "pointer",
                color: it.done ? "var(--muted)" : "var(--text)",
              }}
            >
              <span style={{ color: it.done ? "#19c37d" : "#f0556d" }}>{it.done ? "✓" : "○"}</span>
              {it.label}
              {!it.done && <span style={{ marginLeft: "auto", color: "var(--accent)", fontSize: 11 }}>fix →</span>}
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: 8 }}>
        {running && !paused ? (
          <button className="btn" style={{ width: "100%", background: "#f0556d" }} onClick={() => sendCommand("stop")}>
            Stop autopilot
          </button>
        ) : paused ? (
          <>
            <button className="btn" style={{ flex: 1 }} onClick={() => sendCommand("start")}>
              Resume
            </button>
            <button className="btn-ghost" style={{ flex: 1 }} onClick={() => sendCommand("stop")}>
              Stop
            </button>
          </>
        ) : (
          <button
            className="btn"
            style={{ width: "100%" }}
            disabled={!readiness.ok}
            onClick={() => sendCommand("start")}
          >
            {onSupported ? "Start autopilot" : `Open ${LABELS[launchPlatform]} & start`}
          </button>
        )}
      </div>

      <div className="hint" style={{ marginTop: 12, lineHeight: 1.5 }}>
        {settings.submitMode === "auto" ? (
          <>
            <strong style={{ color: "#f6b73c" }}>Full-auto:</strong> submits applications unattended, throttled, up to
            your daily cap. It pauses for CAPTCHAs or questions it can&apos;t answer. Automating applications is against
            LinkedIn&apos;s terms — your account, your call.
          </>
        ) : (
          <>
            <strong>Assisted:</strong> fills every field and stops at Submit for your click.
          </>
        )}
      </div>
    </div>
  );
}

function computeReadiness(p: Profile, r: Resume | null, prefs: Preferences, s: Settings): Readiness {
  const items = [
    { label: "Anthropic API key", done: !!(s.anthropicApiKey && s.anthropicApiKey.startsWith("sk-ant-")) },
    { label: "Resume added", done: !!(r && r.text.length >= 100) },
    { label: "Profile (name, email, phone)", done: !!(p.fullName && p.email && p.phone) },
    { label: "At least one target title", done: prefs.targetTitles.length > 0 },
  ];
  return { ok: items.every((i) => i.done), items };
}
