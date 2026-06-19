import { useRef, useState } from "react";
import type { Profile, Resume } from "@/shared/types";

type SavedPdf = { base64: string; filename: string; bytes: number };

// pdf.js is ~1.2MB — lazy-load it so the popup opens fast on first click
async function loadPdfLib() {
  return await import("@/lib/pdf");
}

export default function ProfileTab({
  profile,
  resume,
  onSave,
  onClearPdf,
  onShowToast,
}: {
  profile: Profile;
  resume: Resume | null;
  onSave: (p: Profile, r: string | null, pdf: SavedPdf | null) => Promise<void>;
  onClearPdf: () => Promise<void>;
  onShowToast: (msg: string, tone?: "ok" | "bad") => void;
}) {
  const [p, setP] = useState<Profile>(profile);
  const [resumeText, setResumeText] = useState<string>(resume?.text || "");
  const [pendingPdf, setPendingPdf] = useState<SavedPdf | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const update = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setP((prev) => ({ ...prev, [key]: value }));

  const handlePdfFile = async (file: File) => {
    setParsing(true);
    try {
      const { parsePdf, fileToBase64 } = await loadPdfLib();
      const { text, pages, bytes } = await parsePdf(file);
      if (text.length < 80) {
        onShowToast("Couldn't extract readable text — is this a scanned PDF? Paste manually.", "bad");
        return;
      }
      const base64 = await fileToBase64(file);
      setResumeText(text);
      setPendingPdf({ base64, filename: file.name, bytes });
      onShowToast(`Extracted ${pages} page${pages === 1 ? "" : "s"} · ${(bytes / 1024).toFixed(0)} KB`, "ok");
    } catch (e) {
      onShowToast(`PDF parse failed: ${(e as Error).message}`, "bad");
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
    if (fileInputRef.current) fileInputRef.current.value = ""; // allow re-upload of same file
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const newText = resumeText !== (resume?.text || "") ? resumeText : null;
      await onSave(p, newText, pendingPdf);
      setPendingPdf(null);
    } finally {
      setSaving(false);
    }
  };

  const hasStoredPdf = !!resume?.pdfBase64;

  return (
    <div>
      <h3 className="section-title">Your details</h3>

      <div className="field">
        <label>Full name *</label>
        <input type="text" value={p.fullName} onChange={(e) => update("fullName", e.target.value)} placeholder="Hithesh Aiyanna" />
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
        <input type="url" value={p.linkedinUrl || ""} onChange={(e) => update("linkedinUrl", e.target.value)} placeholder="https://www.linkedin.com/in/your-handle" />
      </div>

      <div className="field">
        <label>Portfolio / website</label>
        <input type="url" value={p.portfolioUrl || ""} onChange={(e) => update("portfolioUrl", e.target.value)} placeholder="https://yourname.dev" />
      </div>

      <div className="divider" />

      <h3 className="section-title">
        Resume
        {resumeText.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>
            {resumeText.length.toLocaleString()} chars
          </span>
        )}
      </h3>

      {/* ===== PDF drop zone ============================================= */}
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
        {parsing ? (
          <div style={{ color: "var(--accent)", fontWeight: 600 }}>⚙️ Extracting text…</div>
        ) : pendingPdf ? (
          <div>
            <div style={{ color: "var(--accent-2)", fontWeight: 600, marginBottom: 4 }}>
              ✓ {pendingPdf.filename}
            </div>
            <div className="hint" style={{ marginTop: 0 }}>
              {(pendingPdf.bytes / 1024).toFixed(0)} KB · click <strong>Save profile</strong> below to store it
            </div>
          </div>
        ) : hasStoredPdf ? (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              📄 {resume?.pdfFilename || "resume.pdf"} stored
            </div>
            <div className="hint" style={{ marginTop: 0 }}>
              {((resume?.pdfBytes || 0) / 1024).toFixed(0)} KB · auto-attached to LinkedIn upload fields ·{" "}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm("Remove the stored PDF? The extracted text will stay.")) onClearPdf();
                }}
                style={{ color: "var(--danger)", textDecoration: "underline" }}
              >
                remove
              </span>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Click or drop a new PDF to replace it.
            </div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 22, marginBottom: 4 }}>📄</div>
            <div style={{ fontWeight: 600 }}>Drop a PDF resume here</div>
            <div className="hint" style={{ marginTop: 4 }}>
              We extract the text for Claude tailoring + keep the file so we can auto-attach it to LinkedIn upload fields.
            </div>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" onChange={onFileInput} style={{ display: "none" }} />
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label>Or paste / edit resume text</label>
        <textarea
          value={resumeText}
          onChange={(e) => setResumeText(e.target.value)}
          placeholder={`SUMMARY\nSenior software engineer with 5 years building...\n\nEXPERIENCE\nCompany — Senior SWE, 2022-present\n• Built X that scaled to Y users\n\nSKILLS\nTypeScript, React, PostgreSQL...\n\nEDUCATION\nB.Tech CS, IIT Bombay, 2018`}
          rows={8}
        />
        <div className="hint">
          Claude uses this text to tailor per job — never fabricates beyond what&apos;s here.
          Edit freely after PDF upload if extraction missed anything.
        </div>
      </div>

      <button className="btn" onClick={handleSave} disabled={saving || parsing} style={{ width: "100%" }}>
        {saving ? "Saving…" : "Save profile"}
      </button>
    </div>
  );
}
