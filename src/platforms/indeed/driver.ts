// Indeed driver (top frame) — implements PlatformDriver for indeed.com.
//
// Indeed's SRP behaves like a SPA: clicking a result card loads the job into
// the right-hand pane without a full navigation (like LinkedIn). BUT the apply
// form ("Indeed Apply") renders inside a CROSS-ORIGIN IFRAME (smartapply /
// apply.indeed.com) that this top-frame script cannot read or fill.
//
// So this driver only drives search + open + scrape, then hands off: the
// engine has already published the apply context to chrome.storage, and a
// helper running INSIDE the apply iframe (src/lib/indeed-apply.ts) fills and
// submits, reporting progress back under "indeedApplyStatus". advance() here
// just polls that status. Works whether Indeed Apply opens as an in-page
// iframe or a separate smartapply tab — storage is shared across both.
//
// ⚠️ BETA: Indeed reshuffles selectors and A/B-tests the apply widget; expect
// to tune these on the first live run.

import type { PlatformDriver, ApplyHandle, AdvanceResult, FormField } from "@/shared/driver";
import { cleanText, textOf, findButton, isVisible, waitFor, sleep } from "@/shared/driver";
import type { JobCard, JobPosting, Platform, ActiveApply, IframeApplyStatus } from "@/shared/types";

export class IndeedDriver implements PlatformDriver {
  readonly platform: Platform = "indeed";

  private host(): string {
    return /\.indeed\.com$/.test(location.host) ? location.host : "in.indeed.com";
  }

  // ---- page classification -------------------------------------------------

  isSearchPage(): boolean {
    if (location.pathname === "/jobs" || location.pathname.startsWith("/jobs")) return true;
    return !!document.querySelector("#mosaic-provider-jobcards, .jobsearch-ResultsList");
  }

  isJobPage(): boolean {
    if (location.pathname.startsWith("/viewjob")) return true;
    return !!document.querySelector(".jobsearch-RightPane, #vjs-container, [data-testid='jobsearch-JobComponent']");
  }

  private jkFromUrl(url: string = location.href): string | null {
    try {
      return new URL(url).searchParams.get("jk");
    } catch {
      return null;
    }
  }

  // ---- searching -----------------------------------------------------------

  buildSearchUrl(keyword: string, locationStr: string, remoteOk: boolean): string {
    const p = new URLSearchParams();
    p.set("q", keyword);
    if (locationStr) p.set("l", locationStr);
    p.set("sort", "date");
    if (remoteOk) p.set("sc", "0kf:attr(DSQF7);"); // Indeed's "Remote" filter token
    return `https://${this.host()}/jobs?${p.toString()}`;
  }

  collectJobCards(): JobCard[] {
    const cards: JobCard[] = [];
    const seen = new Set<string>();
    const anchors = document.querySelectorAll<HTMLAnchorElement>(
      "#mosaic-provider-jobcards a[data-jk], .jobsearch-ResultsList a[data-jk], a.jcs-JobTitle[data-jk]",
    );
    for (const a of Array.from(anchors)) {
      const jk = a.getAttribute("data-jk") || this.jkFromUrl(a.href);
      if (!jk || seen.has(jk)) continue;
      const card = a.closest(".job_seen_beacon, .cardOutline, li") || a;
      const title = cleanText(
        a.getAttribute("title") ||
          textOf(a.querySelector("span[title], [id^='jobTitle']")) ||
          textOf(a),
      );
      const company = cleanText(textOf(card.querySelector("[data-testid='company-name'], .companyName")));
      const locStr = cleanText(textOf(card.querySelector("[data-testid='text-location'], .companyLocation")));
      const easy = !!card.querySelector("[data-testid='indeedApply'], .iaLabel, [class*='indeedApply']");
      if (!title) continue;
      seen.add(jk);
      cards.push({
        platform: this.platform,
        jobId: jk,
        url: `https://${this.host()}/viewjob?jk=${jk}`,
        title,
        company,
        location: locStr,
        applyKind: easy ? "easy" : "unknown",
      });
    }
    return cards;
  }

  async loadMoreResults(): Promise<boolean> {
    const before = this.collectJobCards().length;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1000);
    if (this.collectJobCards().length > before) return true;
    const next = document.querySelector<HTMLAnchorElement>("a[data-testid='pagination-page-next']");
    if (next?.href) {
      location.assign(next.href); // navigation → engine resumes on the next page
      return true;
    }
    return false;
  }

  // ---- a single job --------------------------------------------------------

  async openJob(card: JobCard): Promise<"opened" | "navigating" | "failed"> {
    const anchor = document.querySelector<HTMLAnchorElement>(`a[data-jk="${card.jobId}"]`);
    if (!anchor || !isVisible(anchor)) {
      location.assign(card.url);
      return "navigating";
    }
    anchor.click();
    const ok = await waitFor(() => {
      const t = textOf(this.pick(["#jobDescriptionText"]));
      return t ? true : null;
    }, 7000);
    return ok ? "opened" : "failed";
  }

  scrapeJob(): JobPosting | null {
    const jk = this.jkFromUrl() || document.querySelector("[data-jk]")?.getAttribute("data-jk") || "";
    const title = textOf(
      this.pick([
        "h2[data-testid='jobsearch-JobInfoHeader-title']",
        "h1.jobsearch-JobInfoHeader-title",
        ".jobsearch-JobInfoHeader-title",
      ]),
    );
    const company = textOf(this.pick(["[data-testid='inlineHeader-companyName']", "[data-company-name='true']", ".jobsearch-CompanyInfoContainer a"]));
    const locStr = textOf(this.pick(["[data-testid='inlineHeader-companyLocation']", "[data-testid='job-location']", ".jobsearch-JobInfoHeader-subtitle div"]));
    const desc = textOf(this.pick(["#jobDescriptionText", ".jobsearch-JobComponent-description"]));
    if (!title || !desc) return null;
    return {
      platform: this.platform,
      jobId: jk || title.slice(0, 40),
      url: jk ? `https://${this.host()}/viewjob?jk=${jk}` : location.href.split("&")[0],
      title: cleanText(title),
      company: cleanText(company),
      location: cleanText(locStr),
      applyKind: this.canAutoApply() ? "easy" : "external",
      description: cleanText(desc),
    };
  }

  canAutoApply(): boolean {
    const ia = this.pick([
      "#indeedApplyButton",
      ".indeed-apply-button",
      "[data-testid='indeedApplyButton']",
      ".jobsearch-IndeedApplyButton",
      "button[class*='indeedApply']",
    ]);
    if (ia && isVisible(ia as HTMLElement)) return true;
    const byText = findButton(document, ["apply now"]);
    return !!byText && !/company site/i.test(byText.textContent || "");
  }

  alreadyApplied(): boolean {
    if (document.querySelector("[class*='indeed-apply-status-applied'], [data-testid*='applied']")) return true;
    const header = document.querySelector(".jobsearch-IndeedApplyButton, #indeedApplyButton");
    return !!header && /applied/i.test(header.textContent || "");
  }

  isLoggedOut(): boolean {
    // Indeed Apply works for guests (it collects your email in the flow), so a
    // signed-out session is NOT a blocker here — never false-pause the run.
    // A hard bot/login wall is caught by detectCaptcha() instead.
    return false;
  }

  // ---- the apply flow (delegated to the iframe helper) ---------------------

  async startApply(): Promise<ApplyHandle | null> {
    const btn =
      (this.pick([
        "#indeedApplyButton",
        ".indeed-apply-button",
        "[data-testid='indeedApplyButton']",
        ".jobsearch-IndeedApplyButton button",
      ]) as HTMLElement | null) || (findButton(document, ["apply now"]) as HTMLElement | null);
    if (!btn) return null;
    btn.click();
    // Give Indeed Apply a moment to open its iframe/tab; the helper there picks
    // up the apply context we published and starts filling.
    await sleep(1500);
    return { root: document.body, step: 0 };
  }

  // The form lives in a cross-origin iframe — nothing fillable in this frame.
  scanFields(_handle: ApplyHandle): FormField[] {
    return [];
  }
  async attachResume(): Promise<number> {
    return 0;
  }
  async setFieldValue(): Promise<boolean> {
    return true;
  }

  async advance(_handle: ApplyHandle): Promise<AdvanceResult> {
    const active = await this.read<ActiveApply>("activeApply");
    const status = await this.read<IframeApplyStatus>("indeedApplyStatus");

    if (active && status && status.applyId === active.applyId) {
      switch (status.status) {
        case "submitted":
          return { status: "submitted" };
        case "done":
          return { status: "done" };
        case "paused":
          return { status: "blocked", reason: status.reason || "Indeed Apply needs you." };
        case "error":
          return { status: "blocked", reason: status.reason || "Indeed Apply error." };
        default:
          break; // working
      }
    }

    // Top-frame fallback signals.
    if (this.alreadyApplied() && !this.applyWidgetOpen()) return { status: "submitted" };

    // Still working (or the helper hasn't booted yet) — wait, let the loop poll.
    await sleep(4000);
    return { status: "next" };
  }

  private applyWidgetOpen(): boolean {
    return !!document.querySelector("iframe[title*='Apply' i], .indeed-apply-widget iframe, #indeedapply-modal, [id*='indeedapply']");
  }

  async submit(): Promise<boolean> {
    return true; // the iframe helper submits
  }

  detectCaptcha(): boolean {
    if (/\/challenge|hcaptcha|recaptcha/.test(location.href)) return true;
    return !!document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], [class*='captcha']");
  }

  closeApply(_handle: ApplyHandle): void {
    const close =
      this.pick(["[aria-label*='close' i]", ".indeed-apply-widget [aria-label*='close' i]", "#close-popup"]) ||
      findButton(document, ["close"]);
    (close as HTMLElement | null)?.click();
  }

  // ---- internal ------------------------------------------------------------

  private pick(selectors: string[]): Element | null {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el as HTMLElement)) return el;
    }
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  private async read<T>(key: string): Promise<T | null> {
    try {
      const r = await chrome.storage.local.get(key);
      return (r[key] as T) ?? null;
    } catch {
      return null;
    }
  }
}
