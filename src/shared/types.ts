// Types shared across popup / background / content scripts.
//
// v0.3 — "Autopilot": a rich resume-derived profile, multi-platform drivers
// (LinkedIn / Naukri / Indeed), and an autonomous search-and-apply engine.

// ===========================================================================
// Profile — the structured candidate record Claude extracts from the resume.
// Everything the form-filler and the tailoring prompt need lives here, so the
// user drops a resume once and never types fields by hand.
// ===========================================================================

export type WorkItem = {
  company: string;
  title: string;
  startDate: string;      // free text, e.g. "Jan 2022"
  endDate: string;        // "Present" allowed
  location?: string;
  bullets: string[];      // achievement/impact lines
};

export type EducationItem = {
  institution: string;
  degree: string;         // "B.Tech Computer Science"
  startDate?: string;
  endDate?: string;
  grade?: string;         // GPA / % / class
};

export type Profile = {
  // --- identity / contact ---
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;          // digits + country code if known
  phoneCountryCode?: string; // "+91"
  location: string;       // "Bangalore, India"
  city?: string;
  country?: string;

  // --- links ---
  linkedinUrl?: string;
  portfolioUrl?: string;
  githubUrl?: string;

  // --- headline facts the screening questions ask for ---
  headline?: string;      // "Senior Full-Stack Engineer"
  summary?: string;       // 2-3 line professional summary
  yearsExperience?: number;
  currentCompany?: string;
  currentTitle?: string;
  currentCtcLpa?: number;       // India: lakhs per annum
  expectedCtcLpa?: number;
  noticePeriodDays?: number;
  willingToRelocate?: boolean;
  requiresVisaSponsorship?: boolean;
  authorizedCountries?: string[]; // ["India", "UAE"]

  // --- structured history ---
  skills: string[];
  work: WorkItem[];
  education: EducationItem[];
  certifications?: string[];
  languages?: string[];
};

export type Resume = {
  text: string;           // plain-text resume (PDF-extracted or pasted)
  updatedAt: number;      // epoch ms
  // Original PDF bytes (base64) so content scripts can re-create a File and
  // drop it into site upload fields.
  pdfBase64?: string;
  pdfFilename?: string;
  pdfBytes?: number;
};

// ===========================================================================
// Preferences — what the autopilot searches for.
// ===========================================================================

export type Preferences = {
  targetTitles: string[];        // search keywords: ["Software Engineer", ...]
  targetLocations: string[];     // ["Bangalore", "Remote", "Dubai"]
  remoteOk: boolean;
  minSalaryLpa?: number;
  skipPostedBeforeDays?: number; // skip jobs older than N days
  minMatchScore?: number;        // skip jobs Claude scores below this (0-100)
  excludeKeywords?: string[];    // skip a JD containing any of these
  excludeCompanies?: string[];
};

// ===========================================================================
// Settings — API key, model, and the autopilot run config / kill-switch.
// ===========================================================================

export type Platform = "linkedin" | "naukri" | "indeed";

export const ALL_PLATFORMS: Platform[] = ["linkedin", "naukri", "indeed"];

export type SubmitMode = "assisted" | "auto";
// assisted = fill everything, stop at Submit for the user's click.
// auto     = fill AND submit unattended (pauses only when it physically can't
//            proceed: a CAPTCHA, or a required field it has no answer for).

export type Settings = {
  anthropicApiKey: string;       // sk-ant-... — stays in chrome.storage.local
  model: string;                 // tailoring model
  parseModel: string;            // resume-parsing model (can be cheaper)
  submitMode: SubmitMode;
  enabledPlatforms: Platform[];

  // Autopilot run controls
  dailyCap: number;              // max applications per UTC-local day across all sites
  minDelayMs: number;            // min pause between applications
  maxDelayMs: number;            // max pause between applications (randomized)
  pauseOnUnknownRequired: boolean; // pause run if a required field can't be answered
};

// ===========================================================================
// Jobs — scraped postings, the apply queue, and the applied log.
// ===========================================================================

export type ApplyKind = "easy" | "external" | "unknown";

/** A job card harvested from a search-results page (cheap, pre-scrape). */
export type JobCard = {
  platform: Platform;
  jobId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  applyKind: ApplyKind;
};

/** A fully scraped job posting (detail page, with JD text). */
export type JobPosting = JobCard & {
  description: string;
};

export type JobContext = {
  platform: Platform;
  jobId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
};

export type ApplyStatus =
  | "queued"
  | "tailoring"
  | "filling"
  | "submitted"     // auto mode: we clicked Submit
  | "filled"        // assisted mode: filled, waiting on user
  | "skipped"       // below match score / excluded / already applied
  | "paused"        // CAPTCHA or unknown-required blocked it
  | "error";

export type AppliedJob = {
  id: string;                    // `${platform}:${jobId}`
  platform: Platform;
  jobId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  appliedAt: number;             // epoch ms
  matchScore?: number;
  status: ApplyStatus;
  note?: string;                 // e.g. pause reason, error message
  tailoredResume?: string;
};

// ===========================================================================
// Claude outputs.
// ===========================================================================

export type TailorResult = {
  tailoredResume: string;
  matchScore: number;            // 0-100
  keyHighlights: string[];
  coverLetter: string;
  screeningAnswers: Array<{ question: string; answer: string }>;
};

// ===========================================================================
// Autopilot live state (persisted so popup + content agree, survives SW death)
// ===========================================================================

export type AutopilotPhase =
  | "idle"
  | "searching"
  | "applying"
  | "waiting"       // between-application delay
  | "paused"        // blocked, needs human
  | "capReached"
  | "stopped";

export type AutopilotState = {
  running: boolean;
  phase: AutopilotPhase;
  platform?: Platform;
  currentJob?: { title: string; company: string; url: string };
  appliedToday: number;
  queuedCount: number;
  lastMessage: string;
  pauseReason?: string;          // set when phase === "paused"
  updatedAt: number;
};

// ===========================================================================
// chrome.runtime message protocol.
// ===========================================================================

export type Msg =
  | { kind: "ping" }
  | { kind: "parse-resume"; resumeText: string }
  | { kind: "tailor"; job: JobContext }
  | { kind: "answer-question"; question: string; job: JobContext; options?: string[] }
  | { kind: "get-profile" }
  | { kind: "get-settings" }
  | { kind: "get-resume-pdf" }
  | { kind: "save-applied"; job: AppliedJob }
  | { kind: "already-applied"; id: string }
  | { kind: "get-autopilot-state" }
  | { kind: "set-autopilot-state"; patch: Partial<AutopilotState> }
  | { kind: "bump-applied-count" }
  | { kind: "autopilot-command"; command: "start" | "stop"; platform?: Platform };

export type StoredPdf = {
  base64: string;
  filename: string;
  bytes: number;
} | null;

// Cross-frame apply handoff (top-frame engine ↔ apply-iframe helper, e.g.
// Indeed Apply). Written to chrome.storage.local under "activeApply"; the
// iframe helper reports progress under "indeedApplyStatus".
export type ActiveApply = {
  applyId: string;
  job: JobContext;
  profile: Profile;
  tailor: TailorResult;
  submitMode: SubmitMode;
  pauseOnUnknownRequired: boolean;
  createdAt: number;
};

export type IframeApplyStatus = {
  applyId: string;
  status: "working" | "submitted" | "done" | "paused" | "error";
  reason?: string;
  updatedAt: number;
};

export type MsgResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };
