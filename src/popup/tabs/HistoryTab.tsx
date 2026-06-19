import type { AppliedJob } from "@/shared/types";

function timeAgo(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const h = Math.floor(diff / 3.6e6);
  if (h < 1) {
    const m = Math.floor(diff / 60_000);
    return m < 1 ? "just now" : `${m}m ago`;
  }
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

const STATUS_LABEL: Record<AppliedJob["status"], string> = {
  filled: "Filled (not submitted)",
  submitted: "Submitted",
  skipped: "Skipped",
};
const STATUS_TONE: Record<AppliedJob["status"], "ok" | "warn" | "bad"> = {
  filled: "warn",
  submitted: "ok",
  skipped: "bad",
};

export default function HistoryTab({
  applied,
  onClear,
}: {
  applied: AppliedJob[];
  onClear: () => Promise<void>;
}) {
  if (applied.length === 0) {
    return (
      <div className="empty">
        <div style={{ fontSize: 22, marginBottom: 8 }}>📭</div>
        No applications yet.
        <div style={{ marginTop: 6 }}>
          Open any LinkedIn Easy Apply job and click the purple 🚀 Autopilot button.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="section-title">
        Applied jobs
        <button
          className="btn-ghost"
          style={{ padding: "4px 9px", fontSize: 11 }}
          onClick={() => {
            if (confirm("Clear all application history? This can't be undone.")) onClear();
          }}
        >
          Clear all
        </button>
      </h3>

      {applied.map((j) => (
        <div key={j.id} className="job-row">
          <div className="job-title">
            <a
              href={j.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--text)", textDecoration: "none" }}
            >
              {j.title || "Untitled role"}
            </a>
          </div>
          <div className="job-meta">
            <strong style={{ color: "var(--text)" }}>{j.company || "Unknown company"}</strong>
            {j.location && ` · ${j.location}`}
            {" · "}{timeAgo(j.appliedAt)}
          </div>
          <div>
            <span className={`pill ${STATUS_TONE[j.status]}`} style={{ marginTop: 2 }}>
              {STATUS_LABEL[j.status]}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
