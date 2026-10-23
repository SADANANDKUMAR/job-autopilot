// Autopilot engine — the site-agnostic search-and-apply loop.
//
// It only ever talks to a PlatformDriver, so LinkedIn / Naukri / Indeed share
// this exact code. It runs inside a content script.
//
// RESUMABILITY: content scripts die on full-page navigation. The run plan,
// harvested queue and "seen" set are persisted in chrome.storage.local, so if
// the page reloads mid-run (e.g. hopping to the next search keyword) the next
// content-script boot calls resumeIfRunning() and picks up where it left off.
// Claude + the API key stay in the background worker; the engine reaches them
// only through messages.

import type { PlatformDriver } from "@/shared/driver";
import { sleep } from "@/shared/driver";
import { resolveFieldValue } from "@/lib/formfill";
import type {
  Msg,
  MsgResponse,
  TailorResult,
  Profile,
  Preferences,
  Settings,
  JobCard,
  JobContext,
  JobPosting,
  AppliedJob,
  AutopilotState,
  ActiveApply,
  Platform,
} from "@/shared/types";

const RUN_KEY = "autopilotRun";
const ACTIVE_APPLY_KEY = "activeApply";

type PlanItem = { keyword: string; location: string };
type RunState = {
  plan: PlanItem[];
  planIndex: number;
  queue: JobCard[];
  seen: string[];              // ids processed this run (apply/skip) — avoid loops
  pendingApply?: JobCard;      // a job we navigated to and must apply to on resume
};

const MAX_MODAL_STEPS = 12;

// Module-scoped cooperative stop flag for the current content-script lifetime.
let STOP = false;

// ===========================================================================
// Public entry points (called from the per-platform content entry)
// ===========================================================================

/** Begin a fresh run (from the popup's Start command). */
export async function startAutopilot(driver: PlatformDriver): Promise<void> {
  const [profile, prefs] = await Promise.all([getProfile(), getPrefs()]);
  const plan = buildPlan(prefs);
  if (plan.length === 0) {
    await setState({ running: false, phase: "idle", lastMessage: "Add target titles in the popup first." });
    return;
  }
  if (!profileReady(profile)) {
    await setState({ running: false, phase: "idle", lastMessage: "Finish your profile (drop a resume) first." });
    return;
  }
  await saveRun({ plan, planIndex: 0, queue: [], seen: [] });
  await setState({
    running: true,
    phase: "searching",
    platform: driver.platform,
    appliedToday: await getAppliedToday(),
    lastMessage: `Starting on ${driver.platform}…`,
  });
  STOP = false;
  await drive(driver);
}

/** Resume an in-progress run after a content-script boot (page load). */
export async function resumeIfRunning(driver: PlatformDriver): Promise<void> {
  const state = await getState();
  if (!state.running) return;
  if (state.platform && state.platform !== driver.platform) return; // different site tab
  STOP = false;
  await setState({ lastMessage: `Resuming on ${driver.platform}…` });
  await drive(driver);
}

/** Stop the run (from the popup's Stop command or a kill-switch). */
export async function stopAutopilot(): Promise<void> {
  STOP = true;
  await setState({ running: false, phase: "stopped", lastMessage: "Stopped by you." });
}

// ===========================================================================
// The loop
// ===========================================================================

async function drive(driver: PlatformDriver): Promise<void> {
  let settings: Settings;
  let prefs: Preferences;
  let profile: Profile;
  try {
    [settings, prefs, profile] = await Promise.all([getSettings(), getPrefs(), getProfile()]);
  } catch (e) {
    await finish("stopped", `Could not load settings: ${(e as Error).message}`);
    return;
  }

  // Safety guard before we touch any page.
  if (driver.detectCaptcha()) {
    await pause("A CAPTCHA / security check is on screen. Solve it, then press Resume.");
    return;
  }

  try {
    // One "chunk" per drive() call; we loop in-page, and return on any hard
    // navigation (the next boot resumes).
    while (true) {
      if (STOP || !(await isRunning())) return;

      const appliedToday = await getAppliedToday();
      if (appliedToday >= settings.dailyCap) {
        await finish("capReached", `Daily cap reached (${settings.dailyCap}). Resets tomorrow.`);
        return;
      }

      const run = await getRun();
      if (!run) {
        await finish("stopped", "Run state lost — stopped.");
        return;
      }

      // 0) Resume an apply we navigated into before a reload (MPA sites).
      if (run.pendingApply) {
        const card = run.pendingApply;
        if (driver.isJobPage()) {
          const outcome = await applyCurrent(driver, card, settings, prefs, profile);
          run.pendingApply = undefined;
          await saveRun(run);
          if (outcome === "paused" || outcome === "stopped") return;
          if (outcome === "applied" && !(await throttle(settings))) return;
          continue;
        }
        // Navigation didn't land on the job page — drop it and carry on.
        run.pendingApply = undefined;
        await saveRun(run);
      }

      const item = run.plan[run.planIndex];
      if (!item) {
        await finish("stopped", "All searches done. 🎉");
        return;
      }

      // 1) Make sure we're on the right search page.
      if (!driver.isSearchPage()) {
        await setState({ phase: "searching", lastMessage: `Searching "${item.keyword}" · ${item.location}` });
        const url = driver.buildSearchUrl(item.keyword, item.location, prefs.remoteOk);
        location.assign(url); // hard nav → this lifetime ends; boot resumes
        return;
      }

      // 1b) Signed out? Pause with a clear message instead of looping forever.
      await sleep(800); // let the page settle before judging auth state
      if (driver.isLoggedOut()) {
        await pause(`You're not signed in to ${platformName(driver.platform)}. Sign in in this tab, then press Resume.`);
        return;
      }

      // 2) Harvest cards into the queue if empty.
      if (run.queue.length === 0) {
        await sleep(1200); // let results render
        const cards = driver.collectJobCards();
        const fresh = cards.filter((c) => !run.seen.includes(cardId(c)) && !excluded(c, prefs));
        if (fresh.length > 0) {
          run.queue.push(...fresh);
          await saveRun(run);
          await setState({ queuedCount: run.queue.length, lastMessage: `Found ${fresh.length} new jobs.` });
        } else {
          const more = await driver.loadMoreResults();
          if (!more) {
            // Exhausted this keyword → next plan item.
            run.planIndex += 1;
            run.queue = [];
            await saveRun(run);
            if (run.plan[run.planIndex]) {
              const next = run.plan[run.planIndex];
              const url = driver.buildSearchUrl(next.keyword, next.location, prefs.remoteOk);
              location.assign(url);
              return;
            }
            await finish("stopped", "All searches done. 🎉");
            return;
          }
          continue; // re-harvest after loading more
        }
      }

      // 3) Pop a job, open it, and apply.
      const card = run.queue.shift()!;
      run.seen.push(cardId(card));
      run.pendingApply = card;
      await saveRun(run);
      await setState({
        phase: "applying",
        queuedCount: run.queue.length,
        currentJob: { title: card.title, company: card.company, url: card.url },
        lastMessage: `Opening ${card.title} · ${card.company}`,
      });

      const opened = await driver.openJob(card);
      if (opened === "navigating") return; // boot resumes via run.pendingApply
      if (opened === "failed") {
        run.pendingApply = undefined;
        await saveRun(run);
        await skip(card, "Couldn't open the job.");
        continue;
      }

      // 4) Opened in-place → apply now.
      const outcome = await applyCurrent(driver, card, settings, prefs, profile);
      run.pendingApply = undefined;
      await saveRun(run);
      if (outcome === "paused") return; // pause() already set state; wait for human
      if (outcome === "stopped") return;
      if (outcome === "applied" && !(await throttle(settings))) return;
    }
  } catch (e) {
    await pause(`Unexpected error: ${(e as Error).message}. Press Resume to continue.`);
  }
}

type Outcome = "applied" | "skipped" | "paused" | "stopped";

/** Apply to the job already open on the current page. */
async function applyCurrent(
  driver: PlatformDriver,
  card: JobCard,
  settings: Settings,
  prefs: Preferences,
  profile: Profile,
): Promise<Outcome> {
  await setState({
    phase: "applying",
    currentJob: { title: card.title, company: card.company, url: card.url },
    lastMessage: `${card.title} · ${card.company}`,
  });

  await sleep(600);
  if (driver.detectCaptcha()) {
    await pause("A CAPTCHA appeared. Solve it, then press Resume.");
    return "paused";
  }
  if (driver.isLoggedOut()) {
    await pause(`Signed out of ${platformName(card.platform)} mid-run. Sign in, then press Resume.`);
    return "paused";
  }
  if (driver.alreadyApplied() || (await hasApplied(cardId(card)))) {
    return skip(card, "Already applied.");
  }
  if (!driver.canAutoApply()) {
    return skip(card, "External apply — can't auto-fill, skipped.");
  }

  const posting = driver.scrapeJob();
  if (!posting || !posting.description) return skip(card, "Couldn't read the job description.");

  if (excludedByJd(posting, prefs)) return skip(card, "Excluded by your keyword/company filters.");

  // ---- tailor ----
  await setState({ phase: "applying", lastMessage: `Tailoring resume for ${card.company}…` });
  const jobCtx = toJobContext(posting);
  const tailorRes = await bg<TailorResult>({ kind: "tailor", job: jobCtx });
  if (!tailorRes.ok) {
    // API/transient error — pause rather than silently skip, so the user sees it.
    await pause(`Claude error: ${tailorRes.error}`);
    return "paused";
  }
  const tailor = tailorRes.data;
  const minScore = prefs.minMatchScore ?? 0;
  if (tailor.matchScore < minScore) {
    return skip(card, `Match ${tailor.matchScore} < ${minScore} — skipped.`, tailor.matchScore);
  }

  // ---- fill ----
  await setState({ phase: "applying", lastMessage: `Filling application (match ${tailor.matchScore})…` });
  const file = await loadResumeFile();
  // Publish the apply context so a cross-frame helper (e.g. Indeed Apply's
  // iframe) can fill a form this top-frame engine can't reach. Harmless for
  // same-frame drivers (LinkedIn/Naukri), which ignore it.
  await publishApplyContext(jobCtx, profile, tailor, settings);
  const handle = await driver.startApply();
  if (!handle) return skip(card, "Apply form didn't open.");

  for (let step = 0; step < MAX_MODAL_STEPS; step++) {
    if (STOP || !(await isRunning())) return "stopped";
    if (driver.detectCaptcha()) {
      await pause("A CAPTCHA appeared during apply. Solve it, then press Resume.");
      return "paused";
    }

    handle.step = step;
    if (file) await driver.attachResume(handle, file);

    const fields = driver.scanFields(handle);
    for (const field of fields) {
      if (field.type === "file") continue; // handled by attachResume
      const value = await resolveFieldValue(field, profile, tailor, jobCtx);
      if (value === null) {
        if (field.required && settings.pauseOnUnknownRequired) {
          driver.closeApply(handle);
          await pause(`Couldn't answer required field: "${field.label || "(unlabeled)"}". Fill it, then Resume.`);
          return "paused";
        }
        continue;
      }
      await driver.setFieldValue(field, value);
      await sleep(120);
    }

    await sleep(350);
    const adv = await driver.advance(handle);
    if (adv.status === "next") {
      await sleep(600);
      continue;
    }
    if (adv.status === "submit-ready") {
      if (settings.submitMode === "auto") {
        const ok = await driver.submit(adv.button);
        await record(card, "submitted", tailor, ok ? "Submitted ✅" : "Submit click failed");
        driver.closeApply(handle);
        if (ok) {
          await bumpCount();
          return "applied";
        }
        return "skipped";
      }
      // assisted: leave it for the user, stop the run so they can review.
      await record(card, "filled", tailor, "Filled — review & submit.");
      await pause("Filled and ready. Review and click Submit, then Resume for the next job.");
      return "paused";
    }
    if (adv.status === "submitted" || adv.status === "done") {
      await record(card, "submitted", tailor, "Submitted ✅");
      driver.closeApply(handle);
      await bumpCount();
      return "applied";
    }
    // blocked
    driver.closeApply(handle);
    if (settings.pauseOnUnknownRequired) {
      await pause(`Hit a step I can't handle: ${adv.reason}. Finish it, then Resume.`);
      return "paused";
    }
    await record(card, "skipped", tailor, `Skipped: ${adv.reason}`);
    return "skipped";
  }

  driver.closeApply(handle);
  return skip(card, "Too many steps — skipped.");
}

// ===========================================================================
// Plan / filters
// ===========================================================================

function buildPlan(prefs: Preferences): PlanItem[] {
  const titles = prefs.targetTitles.length ? prefs.targetTitles : [];
  const locs = prefs.targetLocations.length ? prefs.targetLocations : [""];
  const plan: PlanItem[] = [];
  for (const keyword of titles) {
    for (const location of locs) plan.push({ keyword, location });
  }
  return plan;
}

function excluded(card: JobCard, prefs: Preferences): boolean {
  const hay = `${card.title} ${card.company}`.toLowerCase();
  if ((prefs.excludeCompanies ?? []).some((c) => c && card.company.toLowerCase().includes(c.toLowerCase()))) return true;
  if ((prefs.excludeKeywords ?? []).some((k) => k && hay.includes(k.toLowerCase()))) return true;
  return false;
}

function excludedByJd(posting: JobPosting, prefs: Preferences): boolean {
  const jd = posting.description.toLowerCase();
  if ((prefs.excludeKeywords ?? []).some((k) => k && jd.includes(k.toLowerCase()))) return true;
  if ((prefs.excludeCompanies ?? []).some((c) => c && posting.company.toLowerCase().includes(c.toLowerCase()))) return true;
  return false;
}

// ===========================================================================
// State transitions
// ===========================================================================

async function pause(reason: string): Promise<void> {
  STOP = true;
  await setState({ running: true, phase: "paused", pauseReason: reason, lastMessage: reason });
}

async function finish(phase: AutopilotState["phase"], message: string): Promise<void> {
  STOP = true;
  await setState({ running: false, phase, lastMessage: message });
}

async function skip(card: JobCard, note: string, matchScore?: number): Promise<Outcome> {
  await record(card, "skipped", undefined, note, matchScore);
  await setState({ lastMessage: `Skipped ${card.company}: ${note}` });
  return "skipped";
}

async function record(
  card: JobCard,
  status: AppliedJob["status"],
  tailor?: TailorResult,
  note?: string,
  matchScore?: number,
): Promise<void> {
  const job: AppliedJob = {
    id: cardId(card),
    platform: card.platform,
    jobId: card.jobId,
    url: card.url,
    title: card.title,
    company: card.company,
    location: card.location,
    appliedAt: Date.now(),
    matchScore: matchScore ?? tailor?.matchScore,
    status,
    note,
    tailoredResume: tailor?.tailoredResume,
  };
  await bg({ kind: "save-applied", job });
}

// ===========================================================================
// Small helpers
// ===========================================================================

function toJobContext(p: JobPosting): JobContext {
  return {
    platform: p.platform,
    jobId: p.jobId,
    url: p.url,
    title: p.title,
    company: p.company,
    location: p.location,
    description: p.description,
  };
}

function cardId(c: JobCard): string {
  return `${c.platform}:${c.jobId}`;
}

function platformName(p: Platform): string {
  return p === "linkedin" ? "LinkedIn" : p === "naukri" ? "Naukri" : "Indeed";
}

/** Randomized between-application pause. Returns false if the run stopped. */
async function throttle(settings: Settings): Promise<boolean> {
  const wait = randBetween(settings.minDelayMs, settings.maxDelayMs);
  await setState({ phase: "waiting", lastMessage: `Applied. Next in ${Math.round(wait / 1000)}s…` });
  return interruptibleSleep(wait);
}

function randBetween(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.round(lo + Math.random() * (hi - lo));
}

/** Sleep that bails early (returns false) if the run is stopped. */
async function interruptibleSleep(ms: number): Promise<boolean> {
  const step = 500;
  let waited = 0;
  while (waited < ms) {
    await sleep(Math.min(step, ms - waited));
    waited += step;
    if (STOP || !(await isRunning())) return false;
  }
  return true;
}

function profileReady(p: Profile): boolean {
  return !!(p.fullName.trim() && p.email.trim() && p.phone.trim());
}

async function loadResumeFile(): Promise<File | null> {
  const res = await bg<{ base64: string; filename: string; bytes: number } | null>({ kind: "get-resume-pdf" });
  if (!res.ok || !res.data) return null;
  try {
    const bin = atob(res.data.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], res.data.filename, { type: "application/pdf" });
  } catch {
    return null;
  }
}

// ---- background messaging ----

async function bg<T>(msg: Msg): Promise<MsgResponse<T>> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as MsgResponse<T>;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function getProfile(): Promise<Profile> {
  const r = await bg<{ profile: Profile }>({ kind: "get-profile" });
  if (!r.ok) throw new Error(r.error);
  return r.data.profile;
}
async function getPrefs(): Promise<Preferences> {
  const r = await bg<{ profile: Profile; prefs: Preferences }>({ kind: "get-profile" });
  if (!r.ok) throw new Error(r.error);
  return r.data.prefs;
}
async function getSettings(): Promise<Settings> {
  const r = await bg<Settings>({ kind: "get-settings" });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
async function getAppliedToday(): Promise<number> {
  // Background refreshes state.appliedToday from the persisted daily counter.
  const s = await getState();
  return s.appliedToday ?? 0;
}
async function bumpCount(): Promise<void> {
  const r = await bg<{ count: number }>({ kind: "bump-applied-count" });
  if (r.ok) await setState({ appliedToday: r.data.count });
}
async function getState(): Promise<AutopilotState> {
  const r = await bg<AutopilotState>({ kind: "get-autopilot-state" });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
async function isRunning(): Promise<boolean> {
  try {
    return (await getState()).running;
  } catch {
    return false;
  }
}
async function setState(patch: Partial<AutopilotState>): Promise<void> {
  await bg({ kind: "set-autopilot-state", patch });
}
async function hasApplied(id: string): Promise<boolean> {
  const r = await bg<{ applied: boolean }>({ kind: "already-applied", id });
  return r.ok && r.data.applied;
}

// ---- run state (persisted; no secrets, so content may touch storage) ----

async function getRun(): Promise<RunState | null> {
  try {
    const r = await chrome.storage.local.get(RUN_KEY);
    return (r[RUN_KEY] as RunState | undefined) ?? null;
  } catch {
    return null;
  }
}
async function publishApplyContext(
  job: JobContext,
  profile: Profile,
  tailor: TailorResult,
  settings: Settings,
): Promise<void> {
  const ctx: ActiveApply = {
    applyId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    job,
    profile,
    tailor,
    submitMode: settings.submitMode,
    pauseOnUnknownRequired: settings.pauseOnUnknownRequired,
    createdAt: Date.now(),
  };
  try {
    await chrome.storage.local.set({ [ACTIVE_APPLY_KEY]: ctx, indeedApplyStatus: null });
  } catch {
    /* ignore */
  }
}

async function saveRun(run: RunState): Promise<void> {
  try {
    // Cap the seen-set so it can't grow unbounded on a very long run.
    if (run.seen.length > 2000) run.seen = run.seen.slice(-2000);
    await chrome.storage.local.set({ [RUN_KEY]: run });
  } catch {
    /* ignore */
  }
}
