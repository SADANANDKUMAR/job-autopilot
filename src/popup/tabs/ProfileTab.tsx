import { useState } from "react";
import type { Profile, Resume } from "@/shared/types";

export default function ProfileTab({
  profile,
  resume,
  onSave,
}: {
  profile: Profile;
  resume: Resume | null;
  onSave: (p: Profile, r: string | null) => Promise<void>;
}) {
  const [p, setP] = useState<Profile>(profile);
  const [resumeText, setResumeText] = useState<string>(resume?.text || "");
  const [saving, setSaving] = useState(false);

  const update = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setP((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      // Only persist resume text if it changed
      const newResume = resumeText !== (resume?.text || "") ? resumeText : null;
      await onSave(p, newResume);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h3 className="section-title">Your details</h3>

      <div className="field">
        <label>Full name *</label>
        <input
          type="text"
          value={p.fullName}
          onChange={(e) => update("fullName", e.target.value)}
          placeholder="Hithesh Aiyanna"
        />
      </div>

      <div className="field">
        <label>Email *</label>
        <input
          type="email"
          value={p.email}
          onChange={(e) => update("email", e.target.value)}
          placeholder="you@email.com"
        />
      </div>

      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Phone *</label>
          <input
            type="tel"
            value={p.phone}
            onChange={(e) => update("phone", e.target.value)}
            placeholder="+91 98xxx xxxxx"
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Years exp.</label>
          <input
            type="number"
            min={0}
            max={50}
            value={p.yearsExperience ?? ""}
            onChange={(e) => update("yearsExperience", e.target.value ? Number(e.target.value) : undefined)}
            placeholder="3"
          />
        </div>
      </div>

      <div className="field">
        <label>Location *</label>
        <input
          type="text"
          value={p.location}
          onChange={(e) => update("location", e.target.value)}
          placeholder="Bangalore, India"
        />
      </div>

      <div className="field">
        <label>LinkedIn URL</label>
        <input
          type="url"
          value={p.linkedinUrl || ""}
          onChange={(e) => update("linkedinUrl", e.target.value)}
          placeholder="https://www.linkedin.com/in/your-handle"
        />
      </div>

      <div className="field">
        <label>Portfolio / website</label>
        <input
          type="url"
          value={p.portfolioUrl || ""}
          onChange={(e) => update("portfolioUrl", e.target.value)}
          placeholder="https://yourname.dev"
        />
      </div>

      <div className="divider" />

      <h3 className="section-title">
        Base resume
        {resumeText.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>
            {resumeText.length.toLocaleString()} chars
          </span>
        )}
      </h3>

      <div className="field">
        <label>Paste your full resume (plain text)</label>
        <textarea
          value={resumeText}
          onChange={(e) => setResumeText(e.target.value)}
          placeholder={`SUMMARY\nSenior software engineer with 5 years building...\n\nEXPERIENCE\nCompany — Senior SWE, 2022-present\n• Built X that scaled to Y users\n• Led migration from Z to ...\n\nSKILLS\nTypeScript, React, PostgreSQL...\n\nEDUCATION\nB.Tech CS, IIT Bombay, 2018`}
          rows={10}
        />
        <div className="hint">
          Plain text only for now — PDF upload coming in v0.2. Copy from your existing resume.
          Claude will tailor this per job, but never fabricate beyond what you've written here.
        </div>
      </div>

      <button className="btn" onClick={handleSave} disabled={saving} style={{ width: "100%" }}>
        {saving ? "Saving…" : "Save profile"}
      </button>
    </div>
  );
}
