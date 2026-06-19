// Types shared across popup / background / content script.

export type Profile = {
  fullName: string;
  email: string;
  phone: string;
  location: string;     // "Bangalore, India"
  linkedinUrl?: string;
  portfolioUrl?: string;
  yearsExperience?: number;
};

export type Resume = {
  text: string;         // Plain-text resume (paste or PDF-extracted)
  updatedAt: number;    // epoch ms
};

export type Preferences = {
  targetTitles: string[];        // ["Software Engineer", "Full Stack Developer"]
  targetLocations: string[];     // ["Bangalore", "Remote"]
  remoteOk: boolean;
  minSalaryLpa?: number;         // India: lakhs per annum
  skipPostedBeforeDays?: number; // skip jobs older than N days
};

export type Settings = {
  anthropicApiKey: string;       // sk-ant-... — stays in chrome.storage.local
  model: string;                 // default "claude-sonnet-4-6"
  autoFillEnabled: boolean;      // master kill-switch
  stopAtSubmit: boolean;         // ALWAYS true in v1 — TOS-safe
};

export type AppliedJob = {
  id: string;                    // linkedin job id
  url: string;
  title: string;
  company: string;
  location: string;
  appliedAt: number;             // epoch ms
  tailoredResume?: string;       // what we sent
  status: "filled" | "submitted" | "skipped";
};

export type JobContext = {
  jobId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;           // full JD text
};

export type TailorResult = {
  tailoredResume: string;        // full rewritten resume
  matchScore: number;            // 0-100 how well user fits this JD
  keyHighlights: string[];       // 3-5 bullets to emphasize verbally
  coverLetter: string;           // short 3-paragraph
  screeningAnswers: Array<{
    question: string;
    answer: string;
  }>;                            // common LinkedIn Easy Apply screening qs
};

// ============================================================================
// chrome.runtime message protocol — typed for the discriminated union below
// ============================================================================

export type Msg =
  | { kind: "tailor"; job: JobContext }
  | { kind: "save-applied"; job: AppliedJob }
  | { kind: "get-profile" }
  | { kind: "get-settings" }
  | { kind: "ping" };

export type MsgResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };
