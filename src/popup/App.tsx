import { useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import type { Profile, Resume, Preferences, Settings, AppliedJob } from "@/shared/types";
import ControlTab from "./tabs/ControlTab";
import ProfileTab from "./tabs/ProfileTab";
import PreferencesTab from "./tabs/PreferencesTab";
import SettingsTab from "./tabs/SettingsTab";
import HistoryTab from "./tabs/HistoryTab";

type TabKey = "control" | "profile" | "prefs" | "settings" | "history";

export default function App() {
  const [tab, setTab] = useState<TabKey>("control");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [resume, setResume] = useState<Resume | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [applied, setApplied] = useState<AppliedJob[]>([]);
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "bad" } | null>(null);

  useEffect(() => {
    (async () => {
      const [p, r, pf, s, a] = await Promise.all([
        storage.getProfile(),
        storage.getResume(),
        storage.getPrefs(),
        storage.getSettings(),
        storage.getApplied(),
      ]);
      setProfile(p);
      setResume(r);
      setPrefs(pf);
      setSettings(s);
      setApplied(a);
      if (!s.anthropicApiKey) setTab("settings");
      else if (!p.fullName) setTab("profile");
    })();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (msg: string, tone: "ok" | "bad" = "ok") => setToast({ msg, tone });

  if (!profile || !prefs || !settings) {
    return <div style={{ padding: 24, color: "var(--muted)", textAlign: "center" }}>Loading…</div>;
  }

  return (
    <>
      <div className="header">
        <div className="logo">🚀</div>
        <div style={{ flex: 1 }}>
          <div className="title">Job Autopilot</div>
          <div className="subtitle">Auto-search · tailor · apply</div>
        </div>
        <span className={`pill ${settings.submitMode === "auto" ? "warn" : "ok"}`}>
          {settings.submitMode === "auto" ? "Full-auto" : "Assisted"}
        </span>
      </div>

      <div className="tabs">
        <button className={tab === "control" ? "active" : ""} onClick={() => setTab("control")}>Control</button>
        <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>Profile</button>
        <button className={tab === "prefs" ? "active" : ""} onClick={() => setTab("prefs")}>Targets</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          History{applied.length > 0 && <span style={{ marginLeft: 4, color: "var(--accent)" }}>· {applied.length}</span>}
        </button>
      </div>

      <div className="body">
        {tab === "control" && (
          <ControlTab profile={profile} resume={resume} prefs={prefs} settings={settings} onGoto={setTab} />
        )}
        {tab === "profile" && (
          <ProfileTab
            profile={profile}
            resume={resume}
            onSave={async (p, r, pdf) => {
              await storage.setProfile(p);
              if (r !== null) await storage.setResume(r, pdf || undefined);
              setProfile(p);
              setResume(await storage.getResume());
              showToast("Profile saved", "ok");
            }}
            onParsed={(merged) => setProfile(merged)}
            onClearPdf={async () => {
              await storage.clearResumePdf();
              setResume(await storage.getResume());
              showToast("Stored PDF removed", "ok");
            }}
            onShowToast={showToast}
          />
        )}
        {tab === "prefs" && (
          <PreferencesTab
            prefs={prefs}
            onSave={async (p) => {
              await storage.setPrefs(p);
              setPrefs(p);
              showToast("Targets saved", "ok");
            }}
          />
        )}
        {tab === "settings" && (
          <SettingsTab
            settings={settings}
            onSave={async (s) => {
              await storage.setSettings(s);
              setSettings(s);
              showToast("Settings saved", "ok");
            }}
            onShowToast={showToast}
          />
        )}
        {tab === "history" && (
          <HistoryTab
            applied={applied}
            onClear={async () => {
              await storage.clearApplied();
              setApplied([]);
              showToast("History cleared", "ok");
            }}
          />
        )}
      </div>

      {toast && <div className={`toast ${toast.tone}`}>{toast.msg}</div>}
    </>
  );
}
