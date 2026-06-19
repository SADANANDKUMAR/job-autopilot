// Content script — injects the "🚀 Autopilot Apply" button next to LinkedIn's
// native "Easy Apply" button on job detail pages. When the user clicks it:
//   1. Scrape the JD off the page
//   2. Ask the background worker to tailor the resume via Claude
//   3. Render an overlay panel with the tailored output + match score + cover
//   4. On "Fill form" click → click LinkedIn's Easy Apply → walk modal fields
//   5. STOP at the Submit button. User reviews + submits manually.
//
// LinkedIn is a SPA — job pages load via client-side navigation, not full
// page reloads. We watch URL changes and re-inject when needed.

import {
  isJobDetailUrl,
  findEasyApplyButton,
  scrapeJob,
  findEasyApplyModal,
  scanFormFields,
  setInputValue,
  setSelectValue,
  findModalAdvanceButton,
  type ScrapedJob,
  type FormField,
} from "@/lib/linkedin";
import type { Msg, MsgResponse, TailorResult, AppliedJob } from "@/shared/types";

console.log("[Job Autopilot] content script loaded");

const BTN_ID = "ja-autopilot-btn";
const OVERLAY_ID = "ja-autopilot-overlay";

// ---------- URL change watcher (LinkedIn SPA navigation) ------------------

let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(maybeInject, 600); // wait for LinkedIn's React render
  } else {
    // Easy Apply button can appear after initial render
    maybeInject();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

setTimeout(maybeInject, 800);

function maybeInject() {
  if (!isJobDetailUrl()) {
    removeButton();
    return;
  }
  if (document.getElementById(BTN_ID)) return; // already injected
  const easyApplyBtn = findEasyApplyButton();
  if (!easyApplyBtn) return;
  injectAutopilotButton(easyApplyBtn);
}

function removeButton() {
  document.getElementById(BTN_ID)?.remove();
}

// ---------- Inject the purple Autopilot button ----------------------------

function injectAutopilotButton(easyApplyBtn: HTMLButtonElement) {
  const wrapper = easyApplyBtn.parentElement;
  if (!wrapper) return;

  const btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.type = "button";
  btn.textContent = "🚀 Autopilot Apply";
  Object.assign(btn.style, {
    background: "linear-gradient(135deg, #6d5efc, #4096ff)",
    color: "#fff",
    border: "none",
    padding: "0 18px",
    height: "32px",
    borderRadius: "16px",
    fontWeight: "600",
    fontSize: "14px",
    marginLeft: "8px",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(109,94,252,0.35)",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    transition: "transform 0.08s, filter 0.08s",
  } satisfies Partial<CSSStyleDeclaration>);
  btn.onmouseenter = () => (btn.style.filter = "brightness(1.1)");
  btn.onmouseleave = () => (btn.style.filter = "");
  btn.onmousedown = () => (btn.style.transform = "translateY(1px)");
  btn.onmouseup = () => (btn.style.transform = "");

  btn.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    handleAutopilotClick().catch((e) => {
      console.error("[Job Autopilot] click handler error", e);
      showOverlay({ kind: "error", message: (e as Error).message });
    });
  };

  wrapper.insertBefore(btn, easyApplyBtn.nextSibling);
}

// ---------- Main flow on click --------------------------------------------

async function handleAutopilotClick() {
  const job = scrapeJob();
  if (!job) {
    showOverlay({ kind: "error", message: "Couldn't read the job description from this page. Try reloading." });
    return;
  }

  showOverlay({ kind: "loading", job });

  const res = await sendMessage<TailorResult>({
    kind: "tailor",
    job: {
      jobId: job.jobId,
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
    },
  });
  if (!res.ok) {
    showOverlay({ kind: "error", message: res.error });
    return;
  }

  showOverlay({ kind: "result", job, result: res.data });
}

// ---------- Overlay UI (built with raw DOM — no React in content script) --

type OverlayState =
  | { kind: "loading"; job: ScrapedJob }
  | { kind: "error"; message: string }
  | { kind: "result"; job: ScrapedJob; result: TailorResult };

function showOverlay(state: OverlayState) {
  document.getElementById(OVERLAY_ID)?.remove();

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  Object.assign(root.style, {
    position: "fixed",
    top: "0",
    right: "0",
    width: "440px",
    height: "100vh",
    background: "#14171f",
    color: "#e5e8ef",
    borderLeft: "1px solid #232838",
    zIndex: "99999",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    fontSize: "13px",
    lineHeight: "1.5",
    boxShadow: "-8px 0 32px rgba(0,0,0,0.35)",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  } satisfies Partial<CSSStyleDeclaration>);

  // Header
  const header = document.createElement("div");
  Object.assign(header.style, {
    padding: "14px 16px",
    borderBottom: "1px solid #232838",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  });
  header.innerHTML = `
    <div style="font-weight:700;font-size:14px;flex:1;">🚀 Job Autopilot</div>
    <button id="ja-close" style="background:transparent;border:none;color:#8a93a6;font-size:18px;cursor:pointer;padding:0 4px;">✕</button>
  `;
  root.appendChild(header);

  // Body
  const body = document.createElement("div");
  body.style.padding = "16px";
  body.style.flex = "1";
  root.appendChild(body);

  if (state.kind === "loading") {
    body.innerHTML = `
      <div style="text-align:center;padding:40px 0;color:#8a93a6;">
        <div style="font-size:32px;margin-bottom:14px;animation:spin 1.4s linear infinite;display:inline-block;">⚙️</div>
        <div style="font-weight:600;color:#e5e8ef;margin-bottom:6px;">Tailoring your resume…</div>
        <div style="font-size:12px;">${escapeHtml(state.job.title)} · ${escapeHtml(state.job.company)}</div>
        <div style="font-size:11px;margin-top:18px;">Claude is rewriting your resume to match this JD. ~10s.</div>
      </div>
      <style>@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }</style>
    `;
  } else if (state.kind === "error") {
    body.innerHTML = `
      <div style="background:rgba(240,85,109,0.08);border:1px solid rgba(240,85,109,0.3);border-radius:8px;padding:14px;">
        <div style="font-weight:600;color:#f0556d;margin-bottom:6px;">Something went wrong</div>
        <div style="font-size:12px;line-height:1.55;">${escapeHtml(state.message)}</div>
      </div>
      <button id="ja-open-popup" style="margin-top:14px;background:transparent;border:1px solid #232838;color:#e5e8ef;padding:9px 14px;border-radius:6px;cursor:pointer;font-weight:500;font-size:13px;width:100%;">
        Open extension popup
      </button>
    `;
  } else {
    renderResult(body, state.job, state.result);
  }

  // Wire up close button
  header.querySelector("#ja-close")?.addEventListener("click", () => root.remove());
  body.querySelector("#ja-open-popup")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ kind: "ping" } satisfies Msg); // wakes service worker
    alert("Click the Job Autopilot icon in your Chrome toolbar to open settings.");
  });

  document.body.appendChild(root);
}

function renderResult(body: HTMLElement, job: ScrapedJob, result: TailorResult) {
  const scoreColor =
    result.matchScore >= 80 ? "#19c37d" : result.matchScore >= 60 ? "#f6b73c" : "#f0556d";

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;">
      <div style="width:60px;height:60px;border-radius:50%;background:conic-gradient(${scoreColor} ${result.matchScore * 3.6}deg, #1a1e29 0deg);display:grid;place-items:center;flex-shrink:0;">
        <div style="width:46px;height:46px;border-radius:50%;background:#14171f;display:grid;place-items:center;">
          <div style="font-size:16px;font-weight:700;color:${scoreColor};">${result.matchScore}</div>
        </div>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:650;font-size:13.5px;margin-bottom:2px;">${escapeHtml(job.title)}</div>
        <div style="font-size:11.5px;color:#8a93a6;">${escapeHtml(job.company)}${job.location ? " · " + escapeHtml(job.location) : ""}</div>
        <div style="font-size:11px;color:${scoreColor};margin-top:4px;font-weight:600;">Match score: ${result.matchScore}/100</div>
      </div>
    </div>

    ${section("Key highlights to mention", `
      <ul style="margin:0;padding-left:16px;font-size:12.5px;line-height:1.6;">
        ${result.keyHighlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}
      </ul>
    `)}

    ${section("Tailored resume", `
      <textarea id="ja-resume" style="width:100%;height:200px;background:#1a1e29;color:#e5e8ef;border:1px solid #232838;border-radius:6px;padding:10px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11.5px;line-height:1.5;resize:vertical;">${escapeHtml(result.tailoredResume)}</textarea>
      <button id="ja-copy-resume" style="margin-top:8px;background:transparent;border:1px solid #232838;color:#e5e8ef;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">📋 Copy resume</button>
    `)}

    ${section("Cover letter", `
      <textarea id="ja-cover" style="width:100%;height:120px;background:#1a1e29;color:#e5e8ef;border:1px solid #232838;border-radius:6px;padding:10px;font-size:12.5px;line-height:1.55;resize:vertical;">${escapeHtml(result.coverLetter)}</textarea>
      <button id="ja-copy-cover" style="margin-top:8px;background:transparent;border:1px solid #232838;color:#e5e8ef;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">📋 Copy cover letter</button>
    `)}

    ${result.screeningAnswers.length > 0 ? section("Screening answers (prepared)", `
      <div style="display:flex;flex-direction:column;gap:9px;">
        ${result.screeningAnswers.map((q) => `
          <div style="background:#1a1e29;border:1px solid #232838;border-radius:6px;padding:9px 11px;font-size:12px;">
            <div style="color:#8a93a6;font-size:11px;margin-bottom:3px;">${escapeHtml(q.question)}</div>
            <div>${escapeHtml(q.answer)}</div>
          </div>
        `).join("")}
      </div>
    `) : ""}

    <div style="display:flex;gap:8px;margin-top:16px;">
      <button id="ja-fill" style="flex:1;background:linear-gradient(135deg,#6d5efc,#4096ff);color:#fff;border:none;padding:11px 16px;border-radius:7px;cursor:pointer;font-weight:600;font-size:13px;">
        Fill the form →
      </button>
      <button id="ja-skip" style="background:transparent;color:#8a93a6;border:1px solid #232838;padding:11px 14px;border-radius:7px;cursor:pointer;font-size:13px;">
        Skip
      </button>
    </div>

    <div style="margin-top:14px;padding:10px 12px;background:rgba(246,183,60,0.06);border:1px solid rgba(246,183,60,0.2);border-radius:6px;font-size:11px;color:#8a93a6;line-height:1.5;">
      <strong style="color:#f6b73c;">You always click Submit yourself.</strong> Job Autopilot fills the form and stops at the final step. You review and submit manually — LinkedIn-TOS-safe.
    </div>
  `;

  body.querySelector("#ja-copy-resume")?.addEventListener("click", async () => {
    const t = (body.querySelector("#ja-resume") as HTMLTextAreaElement)?.value || "";
    await navigator.clipboard.writeText(t);
    toast("Resume copied");
  });
  body.querySelector("#ja-copy-cover")?.addEventListener("click", async () => {
    const t = (body.querySelector("#ja-cover") as HTMLTextAreaElement)?.value || "";
    await navigator.clipboard.writeText(t);
    toast("Cover letter copied");
  });
  body.querySelector("#ja-skip")?.addEventListener("click", () => {
    document.getElementById(OVERLAY_ID)?.remove();
    void saveApplied({
      id: job.jobId,
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location,
      appliedAt: Date.now(),
      status: "skipped",
    });
  });
  body.querySelector("#ja-fill")?.addEventListener("click", () => {
    void handleFillClick(job, result);
  });
}

function section(title: string, inner: string): string {
  return `
    <div style="margin-bottom:16px;">
      <div style="font-weight:600;font-size:12px;color:#8a93a6;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.4px;">${escapeHtml(title)}</div>
      ${inner}
    </div>
  `;
}

// ---------- Fill flow: click Easy Apply → walk modal ----------------------

async function handleFillClick(job: ScrapedJob, result: TailorResult) {
  const easyApply = findEasyApplyButton();
  if (!easyApply) {
    toast("Easy Apply button not found", "bad");
    return;
  }
  easyApply.click();

  // Wait for modal to mount (LinkedIn fades it in)
  const modal = await waitFor(() => findEasyApplyModal(), 5000);
  if (!modal) {
    toast("Easy Apply modal didn't open", "bad");
    return;
  }

  // Walk multi-step modal
  const profileRes = await sendMessage<{ profile: import("@/shared/types").Profile; resume: import("@/shared/types").Resume; prefs: import("@/shared/types").Preferences }>({
    kind: "get-profile",
  });
  if (!profileRes.ok) {
    toast("Couldn't load profile", "bad");
    return;
  }
  const { profile } = profileRes.data;

  let safetyCounter = 0;
  while (safetyCounter < 8) {
    safetyCounter++;
    const currentModal = findEasyApplyModal();
    if (!currentModal) break;

    const fields = scanFormFields(currentModal);
    fillFields(fields, profile, result);

    // Brief pause so LinkedIn's React processes our input events
    await sleep(350);

    const advance = findModalAdvanceButton(currentModal);
    if (!advance) {
      toast("Reached an unknown modal step — review manually", "warn");
      break;
    }
    if (advance.isSubmit) {
      // STOP. We do NOT click Submit. User reviews + clicks themselves.
      toast("Form filled. Review and click Submit when ready.", "ok");
      void saveApplied({
        id: job.jobId,
        url: job.url,
        title: job.title,
        company: job.company,
        location: job.location,
        appliedAt: Date.now(),
        tailoredResume: result.tailoredResume,
        status: "filled",
      });
      // Close our overlay so the user can see LinkedIn's modal
      document.getElementById(OVERLAY_ID)?.remove();
      break;
    }
    advance.btn.click();
    await sleep(700);
  }
}

function fillFields(fields: FormField[], profile: import("@/shared/types").Profile, result: TailorResult) {
  for (const f of fields) {
    const labelLower = f.label.toLowerCase();
    const valueToSet = pickValueForField(f, labelLower, profile, result);
    if (valueToSet === null) continue;

    if (f.type === "text" || f.type === "email" || f.type === "tel" || f.type === "number" || f.type === "textarea") {
      setInputValue(f.element as HTMLInputElement | HTMLTextAreaElement, valueToSet);
    } else if (f.type === "select") {
      setSelectValue(f.element as HTMLSelectElement, valueToSet);
    }
  }
}

function pickValueForField(
  f: FormField,
  labelLower: string,
  profile: import("@/shared/types").Profile,
  result: TailorResult,
): string | null {
  // Skip if already filled — don't clobber user edits
  if (f.currentValue && f.currentValue.trim().length > 0) return null;

  // Profile basics
  if (matches(labelLower, ["first name"])) return firstWord(profile.fullName);
  if (matches(labelLower, ["last name", "surname", "family name"])) return restWords(profile.fullName);
  if (matches(labelLower, ["full name", "your name", "name"])) return profile.fullName;
  if (matches(labelLower, ["email"]) || f.type === "email") return profile.email;
  if (matches(labelLower, ["phone", "mobile", "contact"]) || f.type === "tel") return profile.phone;
  if (matches(labelLower, ["city", "location", "where are you based"])) return profile.location;
  if (matches(labelLower, ["linkedin"])) return profile.linkedinUrl || "";
  if (matches(labelLower, ["portfolio", "website", "github"])) return profile.portfolioUrl || "";

  // Years of experience
  if (matches(labelLower, ["years of experience", "years experience", "how many years"])) {
    if (profile.yearsExperience !== undefined) return String(profile.yearsExperience);
  }

  // Cover-letter-shaped textareas
  if (f.type === "textarea" && matches(labelLower, ["cover letter", "why are you interested", "tell us about yourself", "anything else", "summary"])) {
    return result.coverLetter;
  }

  // Screening answers — match by label-fragment overlap
  for (const sa of result.screeningAnswers) {
    if (similarLabel(labelLower, sa.question.toLowerCase())) return sa.answer;
  }

  return null;
}

function matches(label: string, needles: string[]): boolean {
  return needles.some((n) => label.includes(n));
}

function similarLabel(a: string, b: string): boolean {
  // Cheap similarity: 3+ overlapping content words means probably the same Q
  const wordsA = new Set(a.split(/\W+/).filter((w) => w.length > 3));
  const wordsB = b.split(/\W+/).filter((w) => w.length > 3);
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return overlap >= 3 || (wordsB.length <= 4 && overlap >= 2);
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0] || "";
}
function restWords(s: string): string {
  return s.trim().split(/\s+/).slice(1).join(" ") || s.trim();
}

// ---------- Plumbing -------------------------------------------------------

async function sendMessage<T>(msg: Msg): Promise<MsgResponse<T>> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as MsgResponse<T>;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function saveApplied(job: AppliedJob) {
  await sendMessage({ kind: "save-applied", job });
}

function waitFor<T>(predicate: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = predicate();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(msg: string, tone: "ok" | "bad" | "warn" = "ok") {
  const existing = document.getElementById("ja-toast");
  existing?.remove();
  const t = document.createElement("div");
  t.id = "ja-toast";
  const colors = { ok: "#19c37d", bad: "#f0556d", warn: "#f6b73c" };
  Object.assign(t.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    background: "#14171f",
    color: "#e5e8ef",
    border: `1px solid ${colors[tone]}`,
    borderRadius: "7px",
    padding: "10px 14px",
    fontSize: "12.5px",
    fontWeight: "500",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    zIndex: "100000",
    boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
  } satisfies Partial<CSSStyleDeclaration>);
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
