// Typed chrome.storage.local wrapper. All Autopilot state lives here: profile,
// resume, preferences, settings (incl. the Claude API key), the applied log,
// a per-day application counter, and live autopilot run state.
//
// We use .local (not .sync): resumes are a few KB and API keys are secrets we
// don't want round-tripping through Google's sync servers.

import type {
  Profile,
  Resume,
  Preferences,
  Settings,
  AppliedJob,
  AutopilotState,
} from "@/shared/types";
import { ALL_PLATFORMS } from "@/shared/types";

const KEYS = {
  profile: "profile",
  resume: "resume",
  prefs: "preferences",
  settings: "settings",
  applied: "appliedJobs",
  counter: "dailyCounter",
  autopilot: "autopilotState",
} as const;

export const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: "",
  model: "claude-sonnet-5-5",
  parseModel: "claude-haiku-5-5",
  submitMode: "auto",
  enabledPlatforms: [...ALL_PLATFORMS],
  dailyCap: 25,
  minDelayMs: 20_000,
  maxDelayMs: 55_000,
  pauseOnUnknownRequired: true,
};

export const DEFAULT_PROFILE: Profile = {
  fullName: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  location: "",
  skills: [],
  work: [],
  education: [],
};

export const DEFAULT_PREFS: Preferences = {
  targetTitles: [],
  targetLocations: [],
  remoteOk: true,
  minMatchScore: 55,
  excludeKeywords: [],
  excludeCompanies: [],
};

export const DEFAULT_AUTOPILOT_STATE: AutopilotState = {
  running: false,
  phase: "idle",
  appliedToday: 0,
  queuedCount: 0,
  lastMessage: "Idle",
  updatedAt: 0,
};

async function get<T>(key: string, fallback: T): Promise<T> {
  const r = await chrome.storage.local.get(key);
  return (r[key] as T | undefined) ?? fallback;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/** Local calendar day key (YYYY-MM-DD) so the cap resets at the user's midnight. */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

type DailyCounter = { day: string; count: number };

export const storage = {
  // ---- Profile ----
  getProfile: () => get<Profile>(KEYS.profile, DEFAULT_PROFILE),
  setProfile: (p: Profile) => set(KEYS.profile, p),
  mergeProfile: async (patch: Partial<Profile>): Promise<Profile> => {
    const prev = await get<Profile>(KEYS.profile, DEFAULT_PROFILE);
    const next = { ...prev, ...patch } as Profile;
    await set(KEYS.profile, next);
    return next;
  },

  // ---- Resume ----
  getResume: () => get<Resume | null>(KEYS.resume, null),
  setResume: async (text: string, pdf?: { base64: string; filename: string; bytes: number }): Promise<void> => {
    const prev = await get<Resume | null>(KEYS.resume, null);
    const next: Resume = {
      text,
      updatedAt: Date.now(),
      pdfBase64: pdf ? pdf.base64 : prev?.pdfBase64,
      pdfFilename: pdf ? pdf.filename : prev?.pdfFilename,
      pdfBytes: pdf ? pdf.bytes : prev?.pdfBytes,
    };
    await set(KEYS.resume, next);
  },
  clearResumePdf: async (): Promise<void> => {
    const prev = await get<Resume | null>(KEYS.resume, null);
    if (!prev) return;
    await set(KEYS.resume, { text: prev.text, updatedAt: prev.updatedAt } satisfies Resume);
  },

  // ---- Preferences ----
  getPrefs: () => get<Preferences>(KEYS.prefs, DEFAULT_PREFS),
  setPrefs: (p: Preferences) => set(KEYS.prefs, p),

  // ---- Settings ----
  getSettings: async (): Promise<Settings> => {
    // Merge over defaults so new knobs added across versions aren't undefined.
    const stored = await get<Partial<Settings>>(KEYS.settings, {});
    return { ...DEFAULT_SETTINGS, ...stored, enabledPlatforms: stored.enabledPlatforms ?? DEFAULT_SETTINGS.enabledPlatforms };
  },
  setSettings: (s: Settings) => set(KEYS.settings, s),

  // ---- Applied jobs (capped at 1000) ----
  getApplied: () => get<AppliedJob[]>(KEYS.applied, []),
  addApplied: async (job: AppliedJob): Promise<void> => {
    const list = await get<AppliedJob[]>(KEYS.applied, []);
    const filtered = list.filter((j) => j.id !== job.id);
    filtered.unshift(job);
    await set(KEYS.applied, filtered.slice(0, 1000));
  },
  hasApplied: async (id: string): Promise<boolean> => {
    const list = await get<AppliedJob[]>(KEYS.applied, []);
    return list.some((j) => j.id === id && (j.status === "submitted" || j.status === "filled"));
  },
  clearApplied: () => set(KEYS.applied, []),

  // ---- Per-day counter (for the daily cap) ----
  getAppliedToday: async (): Promise<number> => {
    const c = await get<DailyCounter>(KEYS.counter, { day: todayKey(), count: 0 });
    return c.day === todayKey() ? c.count : 0;
  },
  bumpAppliedToday: async (): Promise<number> => {
    const today = todayKey();
    const c = await get<DailyCounter>(KEYS.counter, { day: today, count: 0 });
    const next: DailyCounter = c.day === today ? { day: today, count: c.count + 1 } : { day: today, count: 1 };
    await set(KEYS.counter, next);
    return next.count;
  },

  // ---- Live autopilot state ----
  getAutopilotState: () => get<AutopilotState>(KEYS.autopilot, DEFAULT_AUTOPILOT_STATE),
  setAutopilotState: async (patch: Partial<AutopilotState>): Promise<AutopilotState> => {
    const prev = await get<AutopilotState>(KEYS.autopilot, DEFAULT_AUTOPILOT_STATE);
    const next = { ...prev, ...patch, updatedAt: Date.now() } as AutopilotState;
    await set(KEYS.autopilot, next);
    return next;
  },
};
