import { useState } from "react";
import type { Settings, Platform, SubmitMode } from "@/shared/types";
import { ALL_PLATFORMS } from "@/shared/types";

const MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (recommended — fast + smart)" },
  { id: "claude-opus-5-5", label: "Opus 5.5 (best quality, slower)" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5 (cheapest, fastest)" },
];

const PLATFORM_LABELS: Record<Platform, string> = {
  linkedin: "LinkedIn",
  naukri: "Naukri (beta)",
  indeed: "Indeed (beta)",
};
const LIVE_PLATFORMS: Platform[] = ["linkedin", "naukri", "indeed"];

export default function SettingsTab({
  settings,
  onSave,
  onShowToast,
}: {
  settings: Settings;
  onSave: (s: Settings) => Promise<void>;
  onShowToast: (msg: string, tone?: "ok" | "bad") => void;
}) {
  const [s, setS] = useState<Settings>(settings);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const handleSave = async () => {
    const trimmed = s.anthropicApiKey.trim();
    if (trimmed && !trimmed.startsWith("sk-ant-")) {
      onShowToast("API key should start with sk-ant-", "bad");
      return;
    }
    if (s.minDelayMs > s.maxDelayMs) {
      onShowToast("Min delay can't exceed max delay.", "bad");
      return;
    }
    setSaving(true);
    try {
      await onSave({ ...s, anthropicApiKey: trimmed });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const trimmed = s.anthropicApiKey.trim();
    if (!trimmed.startsWith("sk-ant-")) {
      onShowToast("Add your sk-ant- key first", "bad");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": trimmed,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: s.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with: pong" }] }),
      });
      if (res.ok) onShowToast("API key works ✓", "ok");
      else {
        const txt = await res.text().catch(() => res.statusText);
        onShowToast(`API ${res.status}: ${txt.slice(0, 80)}`, "bad");
      }
    } catch (e) {
      onShowToast(`Network error: ${(e as Error).message}`, "bad");
    } finally {
      setTesting(false);
    }
  };

  const togglePlatform = (pf: Platform) => {
    if (!LIVE_PLATFORMS.includes(pf)) return;
    const on = s.enabledPlatforms.includes(pf);
    setS({ ...s, enabledPlatforms: on ? s.enabledPlatforms.filter((x) => x !== pf) : [...s.enabledPlatforms, pf] });
  };

  const secs = (ms: number) => Math.round(ms / 1000);

  return (
    <div>
      <h3 className="section-title">Anthropic Claude</h3>
      <div className="field">
        <label>API key</label>
        <div className="row" style={{ gap: 6 }}>
          <input type={showKey ? "text" : "password"} value={s.anthropicApiKey} onChange={(e) => setS({ ...s, anthropicApiKey: e.target.value })} placeholder="sk-ant-..." style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={() => setShowKey(!showKey)} style={{ padding: "8px 10px" }}>{showKey ? "Hide" : "Show"}</button>
        </div>
        <div className="hint">
          From <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>console.anthropic.com</a>.
          Stored locally — sent only to api.anthropic.com.
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Tailoring model</label>
          <select value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Resume-parsing model</label>
        <select value={s.parseModel} onChange={(e) => setS({ ...s, parseModel: e.target.value })}>
          {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>

      <button className="btn-ghost" onClick={handleTest} disabled={testing} style={{ width: "100%", marginBottom: 16 }}>
        {testing ? "Testing…" : "Test API key"}
      </button>

      <div className="divider" />
      <h3 className="section-title">Autopilot behavior</h3>

      <div className="field">
        <label>Submit mode</label>
        <select value={s.submitMode} onChange={(e) => setS({ ...s, submitMode: e.target.value as SubmitMode })}>
          <option value="auto">Full-auto — submit unattended</option>
          <option value="assisted">Assisted — fill, I click Submit</option>
        </select>
        <div className="hint">
          {s.submitMode === "auto"
            ? "Submits for you, throttled, up to the daily cap. Pauses on CAPTCHAs/unknowns. Against platform ToS — your account, your call."
            : "Fills every field and stops at Submit for your review."}
        </div>
      </div>

      <div className="field">
        <label>Platforms</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {ALL_PLATFORMS.map((pf) => {
            const live = LIVE_PLATFORMS.includes(pf);
            return (
              <label key={pf} style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 13, color: live ? "var(--text)" : "var(--muted)", marginBottom: 0 }}>
                <input type="checkbox" checked={s.enabledPlatforms.includes(pf)} disabled={!live} onChange={() => togglePlatform(pf)} style={{ width: "auto", margin: 0 }} />
                {PLATFORM_LABELS[pf]}
              </label>
            );
          })}
        </div>
      </div>

      <div className="field">
        <label>Daily cap ({s.dailyCap} applications)</label>
        <input type="range" min={1} max={100} value={s.dailyCap} onChange={(e) => setS({ ...s, dailyCap: Number(e.target.value) })} style={{ width: "100%" }} />
        <div className="hint">Autopilot stops for the day at this many submitted applications. Lower = safer.</div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Min delay (sec)</label>
          <input type="number" min={5} max={600} value={secs(s.minDelayMs)} onChange={(e) => setS({ ...s, minDelayMs: Math.max(5, Number(e.target.value)) * 1000 })} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Max delay (sec)</label>
          <input type="number" min={5} max={900} value={secs(s.maxDelayMs)} onChange={(e) => setS({ ...s, maxDelayMs: Math.max(5, Number(e.target.value)) * 1000 })} />
        </div>
      </div>
      <div className="hint" style={{ marginTop: -4, marginBottom: 10 }}>Random wait between applications. Longer looks more human.</div>

      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--text)", marginBottom: 0 }}>
          <input type="checkbox" checked={s.pauseOnUnknownRequired} onChange={(e) => setS({ ...s, pauseOnUnknownRequired: e.target.checked })} style={{ width: "auto", margin: 0 }} />
          Pause on questions I can&apos;t answer
        </label>
        <div className="hint">On (recommended): stops and asks you rather than guessing a required field. Off: skips that job and moves on.</div>
      </div>

      <button className="btn" onClick={handleSave} disabled={saving} style={{ width: "100%" }}>
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}
