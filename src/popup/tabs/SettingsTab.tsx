import { useState } from "react";
import type { Settings } from "@/shared/types";

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 (recommended — fast + smart)" },
  { id: "claude-opus-4-7", label: "Opus 4.7 (slower, best quality)" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (cheapest)" },
];

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
        body: JSON.stringify({
          model: s.model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
        }),
      });
      if (res.ok) {
        onShowToast("API key works ✓", "ok");
      } else {
        const txt = await res.text().catch(() => res.statusText);
        onShowToast(`API ${res.status}: ${txt.slice(0, 80)}`, "bad");
      }
    } catch (e) {
      onShowToast(`Network error: ${(e as Error).message}`, "bad");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <h3 className="section-title">Anthropic Claude</h3>

      <div className="field">
        <label>API key</label>
        <div className="row" style={{ gap: 6 }}>
          <input
            type={showKey ? "text" : "password"}
            value={s.anthropicApiKey}
            onChange={(e) => setS({ ...s, anthropicApiKey: e.target.value })}
            placeholder="sk-ant-..."
            style={{ flex: 1 }}
          />
          <button className="btn-ghost" onClick={() => setShowKey(!showKey)} style={{ padding: "8px 10px" }}>
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
        <div className="hint">
          Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>console.anthropic.com</a>.
          Stored locally in chrome.storage — never sent anywhere except api.anthropic.com.
        </div>
      </div>

      <div className="field">
        <label>Model</label>
        <select
          value={s.model}
          onChange={(e) => setS({ ...s, model: e.target.value })}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      <button className="btn-ghost" onClick={handleTest} disabled={testing} style={{ width: "100%", marginBottom: 16 }}>
        {testing ? "Testing…" : "Test API key"}
      </button>

      <div className="divider" />

      <h3 className="section-title">Auto-apply behavior</h3>

      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--text)", marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={s.autoFillEnabled}
            onChange={(e) => setS({ ...s, autoFillEnabled: e.target.checked })}
            style={{ width: "auto", margin: 0 }}
          />
          Enable autopilot button on LinkedIn
        </label>
        <div className="hint">
          Master kill-switch. Turn off if LinkedIn flags your account or you just want to browse without the overlay.
        </div>
      </div>

      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--text)", marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={s.stopAtSubmit}
            disabled
            style={{ width: "auto", margin: 0 }}
          />
          Always stop at Submit (LinkedIn-safe)
        </label>
        <div className="hint">
          Locked on in v1. The extension fills the form — you review and click Submit yourself.
          This keeps your account safe from LinkedIn&apos;s anti-bot detection.
        </div>
      </div>

      <button className="btn" onClick={handleSave} disabled={saving} style={{ width: "100%" }}>
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}
