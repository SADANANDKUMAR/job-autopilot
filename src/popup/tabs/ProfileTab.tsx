import { useRef, useState } from "react";
import type { Profile, Resume, MsgResponse } from "@/shared/types";

type SavedPdf = { base64: string; filename: string; bytes: number };

// pdf.js is ~1.2MB — lazy-load it so the popup opens fast on first click.
async function loadPdfLib() {
  return await import("@/lib/pdf");
}

export default function ProfileTab({
  profile,
  resume,
  onSave,
  onParsed,
  onClearPdf,
  onShowToast,
}: {
  profile: Profile;
  resume: Resume | null;
  onSave: (p: Profile, r: string | null, pdf: SavedPdf | null) => Promise<void>;
  onParsed: (merged: Profile) => void;
  onClearPdf: () => Promise<void>;
  onShowToast: (msg: string, tone?: "ok" | "bad") => void;
}) {
  const [p, setP] = useState<Profile>(profile);
  const [resumeText, setResumeText] = useState<string>(resume?.text || "");
  const [pendingPdf, setPendingPdf] = useState<SavedPdf | null>(null);
  const [parsing, setParsing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [skillsInput, setSkillsInput] = useState((profile.skills || []).join(", "));
  const fileInputRef = useRef<HTMLInputElement>(null);

  const update = <K extends keyof Profile>(key: K, value: Profile[K]) => setP((prev) => ({ ...prev, [key]: value }));

  const handlePdfFile = async (file: File) => {
    setExtracting(true);
    try {
      const { parsePdf, fileToBase64 } = await loadPdfLib();
      const { text, pages, bytes } = await parsePdf(file);
      if (text.length < 80) {
        onShowToast("Couldn't extract readable text — scanned PDF? Paste manually.", "bad");
        return;
      }
      const base64 = await fileToBase64(file);
      setResumeText(text);
      setPendingPdf({ base64, filename: file.name, bytes });
      onShowToast(`Extracted ${pages} page${pages === 1 ? "" : "s"} — now click “Autofill from resume”.`, "ok");
    } catch (e) {
      onShowToast(`PDF parse failed: ${(e as Error).message}`, "bad");
    } finally {
      setExtracting(false);
    }
  };

  // Ask Claude (background) to turn the resume text into structured fields.
  const handleParse = async () => {
    if (resumeText.trim().length < 80) {
      onShowToast("Add resume text first (drop a PDF or paste).", "bad");
      return;
    }
    setParsing(true);
    try {
      // Persist the resume text first so the saved profile and resume agree.
      await onSave({ ...p }, resumeText !== (resume?.text || "") ? resumeText : null, pendingPdf);
      setPendingPdf(null);
      const res = (await chrome.runtime.sendMessage({ kind: "parse-resume", resumeText })) as MsgResponse<{ profile: Profile }>;
      if (!res.ok) {
        onShowToast(res.error, "bad");
        return;
      }
      const merged = res.data.profile;
      setP(merged);
      setSkillsInput((merged.skills || []).join(", "));
      onParsed(merged);
      onShowToast("Fields autofilled from your resume ✓", "ok");
    } catch (e) {
      onShowToast(`Parse failed: ${(e as Error).message}`, "bad");
    } finally {
      setParsing(false);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await handlePdfFile(file);
  };

  const onFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await handlePdfFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const skills = skillsInput.split(",").map((s) => s.trim()).filter(Boolean);
      const parts = p.fullName.trim().split(/\s+/);
      const next: Profile = {
        ...p,
        skills,
        firstName: p.firstName || parts[0] || "",
        lastName: p.lastName || parts.slice(1).join(" ") || "",
      };
      const newText = resumeText !== (resume?.text || "") ? resumeText : null;
      await onSave(next, newText, pendingPdf);
      setP(next);
      setPendingPdf(null);
    } finally {
      setSaving(false);
    }
  };

  const hasStoredPdf = !!resume?.pdfBase64;

  return (
    <div>
      {/* ===== Resume first — it drives everything ====================== */}
      <h3 className="section-title">
        Resume
        {resumeText.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>{resumeText.length.toLocaleString()} chars</span>
        )}
      </h3>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `1px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
          background: dragOver ? "rgba(109,94,252,0.06)" : "var(--panel-2)",
          borderRadius: 8,
          padding: "16px 14px",
          textAlign: "center",
          cursor: "pointer",
          marginBottom: 10,
          transition: "border-color 0.12s, background 0.12s",
        }}
      >
        {extracting ? (
          <div style={{ color: "var(--accent)", fontWeight: 600 }}>⚙️ Extracting text…</div>
        ) : pendingPdf ? (
          <div>
            <div style={{ color: "var(--accent-2)", fontWeight: 600, marginBottom: 4 }}>✓ {pendingPdf.filename}</div>
            <div className="hint" style={{ marginTop: 0 }}>{(pendingPdf.bytes / 1024).toFixed(0)} KB · click “Autofill from resume” below</div>
          </div>
        ) : hasStoredPdf ? (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>📄 {resume?.pdfFilename || "resume.pdf"} stored</div>
            <div className="hint" style={{ marginTop: 0 }}>
              {((resume?.pdfBytes || 0) / 1024).toFixed(0)} KB · auto-attached to upload fields ·{" "}
              <span
                onClick={(e) => { e.stopPropagation(); if (confirm("Remove the stored PDF? Extracted text stays.")) onClearPdf(); }}
                style={{ color: "var(--danger)", textDecoration: "underline" }}
              >
                remove
              </span>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>Click or drop a new PDF to replace it.</div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 22, marginBottom: 4 }}>📄</div>
            <div style={{ fontWeight: 600 }}>Drop a PDF resume here</div>
            <div className="hint" style={{ marginTop: 4 }}>We extract the text, keep the file to auto-attach, and let Claude fill your details.</div>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" onChange={onFileInput} style={{ display: "none" }} />
      </div>

      <details style={{ marginBottom: 10 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--muted)" }}>Or paste / edit resume text</summary>
        <textarea
          value={resumeText}
          onChange={(e) => setResumeText(e.target.value)}
          placeholder={`SUMMARY\nSenior engineer with 5 years...\n\nEXPERIENCE\nCompany — Senior SWE, 2022-present\n• Built X that scaled to Y\n\nSKILLS\nTypeScript, React, PostgreSQL\n\nEDUCATION\nB.Tech CS, 2018`}
          rows={8}
          style={{ marginTop: 8 }}
        />
      </details>

      <button className="btn" onClick={handleParse} disabled={parsing || extracting} style={{ width: "100%", marginBottom: 6 }}>
        {parsing ? "Reading your resume…" : "✨ Autofill fields from resume"}
      </button>
      <div className="hint" style={{ marginBottom: 14 }}>Claude reads the resume and fills the fields below. Review before you run — it never invents data, so blanks mean it wasn&apos;t in the resume.</div>

      <div className="divider" />

      {/* ===== Identity ================================================= */}
      <h3 className="section-title">Your details</h3>
      <div className="field">
        <label>Full name *</label>
        <input type="text" value={p.fullName} onChange={(e) => update("fullName", e.target.value)} placeholder="Jordan Rivera" />
      </div>
      <div className="field">
        <label>Email *</label>
        <input type="email" value={p.email} onChange={(e) => update("email", e.target.value)} placeholder="you@email.com" />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Phone *</label>
          <input type="tel" value={p.phone} onChange={(e) => update("phone", e.target.value)} placeholder="+91 98xxx xxxxx" />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Years exp.</label>
          <input type="number" min={0} max={50} value={p.yearsExperience ?? ""} onChange={(e) => update("yearsExperience", e.target.value ? Number(e.target.value) : undefined)} placeholder="3" />
        </div>
      </div>
      <div className="field">
        <label>Location *</label>
        <input type="text" value={p.location} onChange={(e) => update("location", e.target.value)} placeholder="Bangalore, India" />
      </div>
      <div className="field">
        <label>LinkedIn URL</label>
        <input type="url" value={p.linkedinUrl || ""} onChange={(e) => update("linkedinUrl", e.target.value)} placeholder="https://www.linkedin.com/in/you" />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>GitHub</label>
          <input type="url" value={p.githubUrl || ""} onChange={(e) => update("githubUrl", e.target.value)} placeholder="github.com/you" />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Portfolio</label>
          <input type="url" value={p.portfolioUrl || ""} onChange={(e) => update("portfolioUrl", e.target.value)} placeholder="yourname.dev" />
        </div>
      </div>

      <div className="field">
        <label>Skills</label>
        <input type="text" value={skillsInput} onChange={(e) => setSkillsInput(e.target.value)} placeholder="TypeScript, React, PostgreSQL" />
        <div className="hint">Comma-separated.</div>
      </div>

      {/* ===== Screening answers (what forms ask) ====================== */}
      <div style={{ marginBottom: 10 }}>
        <span onClick={() => setShowMore(!showMore)} style={{ cursor: "pointer", fontSize: 12.5, color: "var(--accent)" }}>
          {showMore ? "▾" : "▸"} Screening answers (CTC, notice period, visa…)
        </span>
      </div>
      {showMore && (
        <>
          <div className="row" style={{ gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Current CTC (LPA)</label>
              <input type="number" value={p.currentCtcLpa ?? ""} onChange={(e) => update("currentCtcLpa", e.target.value ? Number(e.target.value) : undefined)} placeholder="18" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Expected CTC (LPA)</label>
              <input type="number" value={p.expectedCtcLpa ?? ""} onChange={(e) => update("expectedCtcLpa", e.target.value ? Number(e.target.value) : undefined)} placeholder="28" />
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Notice period (days)</label>
              <input type="number" value={p.noticePeriodDays ?? ""} onChange={(e) => update("noticePeriodDays", e.target.value ? Number(e.target.value) : undefined)} placeholder="30" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Current title</label>
              <input type="text" value={p.currentTitle || ""} onChange={(e) => update("currentTitle", e.target.value)} placeholder="Senior Engineer" />
            </div>
          </div>
          <div className="field">
            <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--text)", marginBottom: 6 }}>
              <input type="checkbox" checked={!!p.willingToRelocate} onChange={(e) => update("willingToRelocate", e.target.checked)} style={{ width: "auto", margin: 0 }} />
              Willing to relocate
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--text)", marginBottom: 0 }}>
              <input type="checkbox" checked={!!p.requiresVisaSponsorship} onChange={(e) => update("requiresVisaSponsorship", e.target.checked)} style={{ width: "auto", margin: 0 }} />
              I need visa sponsorship
            </label>
          </div>
        </>
      )}

      <button className="btn" onClick={handleSave} disabled={saving || parsing} style={{ width: "100%", marginTop: 6 }}>
        {saving ? "Saving…" : "Save profile"}
      </button>
    </div>
  );
}
