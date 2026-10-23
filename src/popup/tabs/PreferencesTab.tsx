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
  const [exKw, setExKw] = useState((prefs.excludeKeywords || []).join(", "));
  const [exCo, setExCo] = useState((prefs.excludeCompanies || []).join(", "));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
      await onSave({
        ...p,
        targetTitles: csv(titlesInput),
        targetLocations: csv(locsInput),
        excludeKeywords: csv(exKw),
        excludeCompanies: csv(exCo),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h3 className="section-title">What you&apos;re hunting for</h3>

      <div className="field">
        <label>Target job titles *</label>
        <input type="text" value={titlesInput} onChange={(e) => setTitlesInput(e.target.value)} placeholder="Senior Software Engineer, Full Stack Developer" />
        <div className="hint">Comma-separated. Autopilot runs one search per title × location.</div>
      </div>

      <div className="field">
        <label>Target locations</label>
        <input type="text" value={locsInput} onChange={(e) => setLocsInput(e.target.value)} placeholder="Bangalore, Remote, Dubai" />
        <div className="hint">Comma-separated. Leave blank for anywhere.</div>
      </div>

      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--text)", marginBottom: 0 }}>
          <input type="checkbox" checked={p.remoteOk} onChange={(e) => setP({ ...p, remoteOk: e.target.checked })} style={{ width: "auto", margin: 0 }} />
          Prefer remote roles
        </label>
      </div>

      <div className="divider" />
      <h3 className="section-title">Filters</h3>

      <div className="field">
        <label>Min match score to apply ({p.minMatchScore ?? 55})</label>
        <input
          type="range"
          min={0}
          max={95}
          step={5}
          value={p.minMatchScore ?? 55}
          onChange={(e) => setP({ ...p, minMatchScore: Number(e.target.value) })}
          style={{ width: "100%" }}
        />
        <div className="hint">Autopilot skips jobs Claude scores below this. Higher = pickier, fewer applications.</div>
      </div>

      <div className="field">
        <label>Exclude JD keywords</label>
        <input type="text" value={exKw} onChange={(e) => setExKw(e.target.value)} placeholder="unpaid, clearance, PhD required" />
        <div className="hint">Comma-separated. Any job whose description contains one is skipped.</div>
      </div>

      <div className="field">
        <label>Exclude companies</label>
        <input type="text" value={exCo} onChange={(e) => setExCo(e.target.value)} placeholder="Acme Corp, Globex" />
      </div>

      <div className="field">
        <label>Min salary (LPA)</label>
        <input type="number" min={0} max={200} value={p.minSalaryLpa ?? ""} onChange={(e) => setP({ ...p, minSalaryLpa: e.target.value ? Number(e.target.value) : undefined })} placeholder="25" />
        <div className="hint">Lakhs per annum (India). Optional.</div>
      </div>

      <button className="btn" onClick={handleSave} disabled={saving} style={{ width: "100%" }}>
        {saving ? "Saving…" : "Save targets"}
      </button>
    </div>
  );
}
