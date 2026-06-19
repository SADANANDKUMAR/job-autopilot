import { useState } from "react";
import type { Preferences } from "@/shared/types";

export default function PreferencesTab({
  prefs,
  onSave,
}: {
  prefs: Preferences;
  onSave: (p: Preferences) => Promise<void>;
}) {
  const [p, setP] = useState<Preferences>(prefs);
  const [titlesInput, setTitlesInput] = useState(prefs.targetTitles.join(", "));
  const [locsInput, setLocsInput] = useState(prefs.targetLocations.join(", "));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const finalPrefs: Preferences = {
        ...p,
        targetTitles: titlesInput.split(",").map((s) => s.trim()).filter(Boolean),
        targetLocations: locsInput.split(",").map((s) => s.trim()).filter(Boolean),
      };
      await onSave(finalPrefs);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h3 className="section-title">What you&apos;re hunting for</h3>

      <div className="field">
        <label>Target job titles</label>
        <input
          type="text"
          value={titlesInput}
          onChange={(e) => setTitlesInput(e.target.value)}
          placeholder="Senior Software Engineer, Full Stack Developer, Backend Engineer"
        />
        <div className="hint">Comma-separated. Claude uses these to score how well a JD matches what you want.</div>
      </div>

      <div className="field">
        <label>Target locations</label>
        <input
          type="text"
          value={locsInput}
          onChange={(e) => setLocsInput(e.target.value)}
          placeholder="Bangalore, Mumbai, Remote"
        />
        <div className="hint">Comma-separated. Used to flag location-mismatched jobs.</div>
      </div>

      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--text)", marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={p.remoteOk}
            onChange={(e) => setP({ ...p, remoteOk: e.target.checked })}
            style={{ width: "auto", margin: 0 }}
          />
          Open to remote roles
        </label>
      </div>

      <div className="field">
        <label>Min salary (LPA)</label>
        <input
          type="number"
          min={0}
          max={200}
          value={p.minSalaryLpa ?? ""}
          onChange={(e) => setP({ ...p, minSalaryLpa: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="25"
        />
        <div className="hint">Lakhs per annum (India). Optional — leave blank to ignore.</div>
      </div>

      <div className="field">
        <label>Skip jobs older than (days)</label>
        <input
          type="number"
          min={1}
          max={90}
          value={p.skipPostedBeforeDays ?? ""}
          onChange={(e) => setP({ ...p, skipPostedBeforeDays: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="14"
        />
        <div className="hint">Optional. Stale postings are often already filled.</div>
      </div>

      <button className="btn" onClick={handleSave} disabled={saving} style={{ width: "100%" }}>
        {saving ? "Saving…" : "Save targets"}
      </button>
    </div>
  );
}
