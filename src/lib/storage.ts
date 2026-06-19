// Typed chrome.storage.local wrapper. All Job Autopilot state lives here:
// profile, resume, preferences, settings (including the Claude API key), and
// the applied-jobs log. We use .local (not .sync) because (a) the resume can
// be a few KB which would burn through .sync's quota fast, and (b) Claude
// API keys are user-secrets — better not to round-trip them through Google.

import type { Profile, Resume, Preferences, Settings, AppliedJob } from "@/shared/types";

const KEYS = {
  profile: "profile",
  resume: "resume",
  prefs: "preferences",
  settings: "settings",
  applied: "appliedJobs",
} as const;

export const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: "",
  model: "claude-sonnet-4-6",
  autoFillEnabled: true,
  stopAtSubmit: true,
};

export const DEFAULT_PROFILE: Profile = {
  fullName: "",
  email: "",
  phone: "",
  location: "",
};

export const DEFAULT_PREFS: Preferences = {
  targetTitles: [],
  targetLocations: [],
  remoteOk: true,
};

async function get<T>(key: string, fallback: T): Promise<T> {
  const r = await chrome.storage.local.get(key);
  return (r[key] as T | undefined) ?? fallback;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export const storage = {
  // ---- Profile ----
  getProfile: () => get<Profile>(KEYS.profile, DEFAULT_PROFILE),
  setProfile: (p: Profile) => set(KEYS.profile, p),

  // ---- Resume ----
  getResume: () => get<Resume | null>(KEYS.resume, null),
  setResume: (text: string) => set(KEYS.resume, { text, updatedAt: Date.now() } satisfies Resume),

  // ---- Preferences ----
  getPrefs: () => get<Preferences>(KEYS.prefs, DEFAULT_PREFS),
  setPrefs: (p: Preferences) => set(KEYS.prefs, p),

  // ---- Settings ----
  getSettings: () => get<Settings>(KEYS.settings, DEFAULT_SETTINGS),
  setSettings: (s: Settings) => set(KEYS.settings, s),

  // ---- Applied jobs (capped at 500 to avoid runaway storage) ----
  getApplied: () => get<AppliedJob[]>(KEYS.applied, []),
  addApplied: async (job: AppliedJob): Promise<void> => {
    const list = await get<AppliedJob[]>(KEYS.applied, []);
    // Dedupe by jobId — re-apply just updates the row.
    const filtered = list.filter((j) => j.id !== job.id);
    filtered.unshift(job);
    await set(KEYS.applied, filtered.slice(0, 500));
  },
  clearApplied: () => set(KEYS.applied, []),
};
