// LinkedIn driver — implements PlatformDriver for linkedin.com/jobs.
//
// LinkedIn is a SPA: selecting a job in the left list swaps the right-hand
// detail pane and the Easy Apply modal opens in-place, so a full run mostly
// happens in one content-script lifetime (no reloads between jobs). We switch
// keywords with a hard navigation, which the engine resumes after.
//
// Selectors favor data-* and ARIA over obfuscated class names, with text
// fallbacks. Everything fails soft (null / false), never throws.

import type {
  PlatformDriver,
  ApplyHandle,
  AdvanceResult,
  FormField,
} from "@/shared/driver";
import {
  cleanText,
  textOf,
  inferType,
  labelFor,
  setNativeValue,
  setSelect,
  attachFile,
  findButton,
  isVisible,
  waitFor,
  sleep,
} from "@/shared/driver";
import type { JobCard, JobPosting, Platform } from "@/shared/types";

const WRAPPERS =
  ".jobs-easy-apply-form-element, .artdeco-text-input, .fb-dash-form-element, [data-test-form-element], fieldset";

export class LinkedInDriver implements PlatformDriver {
  readonly platform: Platform = "linkedin";

  // ---- page classification -------------------------------------------------

  isSearchPage(): boolean {
    return /\/jobs\/(search|collections)/.test(location.pathname);
  }

  isJobPage(): boolean {
    return this.jobIdFromUrl() !== null;
  }

  private jobIdFromUrl(url: string = location.href): string | null {
    const view = url.match(/\/jobs\/view\/(\d+)/);
    if (view) return view[1];
    try {
      return new URL(url).searchParams.get("currentJobId");
    } catch {
      return null;
    }
  }

  // ---- searching -----------------------------------------------------------

  buildSearchUrl(keyword: string, locationStr: string, remoteOk: boolean): string {
    const p = new URLSearchParams();
    p.set("keywords", keyword);
    if (locationStr) p.set("location", locationStr);
    p.set("f_AL", "true"); // Easy Apply only — we can't auto-fill external applies
    if (remoteOk) p.set("f_WT", "2"); // remote
    p.set("sortBy", "DD"); // newest first
    return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
  }

  collectJobCards(): JobCard[] {
    const cards: JobCard[] = [];
    const seen = new Set<string>();
    const lis = document.querySelectorAll<HTMLElement>(
      "li[data-occludable-job-id], .jobs-search-results__list-item, .scaffold-layout__list-item, .job-card-container",
    );
    for (const li of Array.from(lis)) {
      const jobId =
        li.getAttribute("data-occludable-job-id") ||
        li.querySelector("[data-job-id]")?.getAttribute("data-job-id") ||
        this.jobIdFromAnchor(li);
      if (!jobId || seen.has(jobId)) continue;

      const titleEl = li.querySelector(
        ".job-card-list__title, .job-card-container__link, a.job-card-list__title--link, .artdeco-entity-lockup__title a",
      );
      const title = cleanText(titleEl?.getAttribute("aria-label") || textOf(titleEl));
      const company = cleanText(
        textOf(li.querySelector(".job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .job-card-container__company-name")),
      );
      const locStr = cleanText(
        textOf(li.querySelector(".job-card-container__metadata-item, .artdeco-entity-lockup__caption")),
      );
      if (!title) continue;

      seen.add(jobId);
      cards.push({
        platform: this.platform,
        jobId,
        url: `https://www.linkedin.com/jobs/view/${jobId}/`,
        title,
        company,
        location: locStr,
        applyKind: "easy", // f_AL=true filter means these are Easy Apply
      });
    }
    return cards;
  }

  private jobIdFromAnchor(root: HTMLElement): string | null {
    const a = root.querySelector<HTMLAnchorElement>("a[href*='/jobs/view/']");
    if (!a) return null;
    return this.jobIdFromUrl(a.href);
  }

  async loadMoreResults(): Promise<boolean> {
    const list =
      document.querySelector<HTMLElement>(".jobs-search-results-list") ||
      document.querySelector<HTMLElement>(".scaffold-layout__list > div") ||
      document.scrollingElement as HTMLElement;

    const before = this.collectJobCards().length;
    // Lazy-load by scrolling the results column to the bottom.
    if (list) list.scrollTop = list.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1400);
    const after = this.collectJobCards().length;
    if (after > before) return true;

    // Try the pagination "next" button.
    const next =
      document.querySelector<HTMLButtonElement>("button[aria-label='View next page']") ||
      document.querySelector<HTMLButtonElement>(".jobs-search-pagination__button--next") ||
      findButton(document, ["next"]);
    if (next && !next.disabled) {
      next.click();
      await sleep(1600);
      return true;
    }
    return false;
  }

  // ---- a single job --------------------------------------------------------

  async openJob(card: JobCard): Promise<"opened" | "navigating" | "failed"> {
    // Prefer an in-page click (no reload) when the card is in the list.
    const anchor = document.querySelector<HTMLAnchorElement>(
      `li[data-occludable-job-id="${card.jobId}"] a, a[href*="/jobs/view/${card.jobId}"]`,
    );
    if (!anchor || !isVisible(anchor)) {
      location.assign(card.url); // hard nav; engine resumes after boot
      return "navigating";
    }
    anchor.click();
    const ok = await waitFor(() => {
      const t = textOf(document.querySelector("h1.t-24, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title"));
      return t ? true : null;
    }, 7000);
    return ok ? "opened" : "failed";
  }

  scrapeJob(): JobPosting | null {
    const jobId = this.jobIdFromUrl();
    if (!jobId) return null;

    const title = textOf(
      document.querySelector("h1.t-24, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title"),
    );
    const company =
      textOf(document.querySelector(".job-details-jobs-unified-top-card__company-name a")) ||
      textOf(document.querySelector(".jobs-unified-top-card__company-name a")) ||
      textOf(document.querySelector(".job-details-jobs-unified-top-card__company-name"));
    const locStr =
      textOf(document.querySelector(".job-details-jobs-unified-top-card__primary-description-container .tvm__text--low-emphasis")) ||
      textOf(document.querySelector(".jobs-unified-top-card__bullet")) ||
      "";
    const desc =
      textOf(document.querySelector("#job-details")) ||
      textOf(document.querySelector(".jobs-description__content .jobs-description-content__text")) ||
      textOf(document.querySelector(".jobs-description-content__text")) ||
      textOf(document.querySelector(".jobs-description")) ||
      "";

    if (!title || !desc) return null;
    return {
      platform: this.platform,
      jobId,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      title: cleanText(title),
      company: cleanText(company),
      location: cleanText(locStr),
      applyKind: "easy",
      description: cleanText(desc),
    };
  }

  canAutoApply(): boolean {
    return !!this.findEasyApplyButton();
  }

  alreadyApplied(): boolean {
    // LinkedIn shows an "Applied" pill / inline feedback after applying.
    const feedback = document.querySelector(".jobs-s-apply .artdeco-inline-feedback, .post-apply-timeline, .jobs-apply-button--applied");
    if (feedback) return true;
    const topcard = document.querySelector(".job-details-jobs-unified-top-card__container, .jobs-unified-top-card");
    return !!topcard && /\bapplied\b/i.test(topcard.textContent || "") && !this.findEasyApplyButton();
  }

  isLoggedOut(): boolean {
    // Logged-in markers win (member nav / authenticated job list).
    if (document.querySelector(".global-nav__me, .global-nav__me-photo, a[href*='/feed/'], [data-control-name='nav.settings']")) {
      return false;
    }
    if (document.querySelector("li[data-occludable-job-id]")) return false;
    // Guest / sign-in wall markers.
    if (document.querySelector("a[href*='/login'], a.nav__button-secondary, .authwall, .join-form, [data-tracking-control-name*='guest']")) {
      return true;
    }
    return /\bsign in to view|join linkedin|new to linkedin\?/i.test(document.body.innerText || "");
  }

  private findEasyApplyButton(): HTMLButtonElement | null {
    const candidates = document.querySelectorAll<HTMLButtonElement>(
      "button.jobs-apply-button, .jobs-apply-button button, button[aria-label*='Easy Apply' i]",
    );
    for (const btn of Array.from(candidates)) {
      if (!isVisible(btn)) continue;
      const txt = (btn.textContent || "").trim().toLowerCase();
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (txt.includes("easy apply") || aria.includes("easy apply")) return btn;
    }
    return null;
  }

  // ---- the apply flow ------------------------------------------------------

  async startApply(): Promise<ApplyHandle | null> {
    const btn = this.findEasyApplyButton();
    if (!btn) return null;
    btn.click();
    const modal = await waitFor(() => this.findModal(), 6000);
    if (!modal) return null;
    return { root: modal, step: 0 };
  }

  private findModal(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>(".jobs-easy-apply-modal") ||
      document.querySelector<HTMLElement>("div[role='dialog'] .jobs-easy-apply-content") ||
      document.querySelector<HTMLElement>("div[data-test-modal][role='dialog']") ||
      document.querySelector<HTMLElement>("div[role='dialog'][aria-labelledby*='easy-apply']")
    );
  }

  scanFields(handle: ApplyHandle): FormField[] {
    const root = this.findModal() || handle.root;
    const fields: FormField[] = [];
    const radioGroups = new Set<string>();

    const controls = root.querySelectorAll<HTMLElement>("input, textarea, select");
    for (const ctrl of Array.from(controls)) {
      const type = inferType(ctrl);
      if (type === "unknown") continue;
      if (!isVisible(ctrl)) continue;

      // Group radios by name — one field per question, options = radio labels.
      if (type === "radio") {
        const name = (ctrl as HTMLInputElement).name || "";
        if (!name || radioGroups.has(name)) continue;
        radioGroups.add(name);
        const group = Array.from(root.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${CSS.escape(name)}"]`));
        const fieldset = ctrl.closest("fieldset");
        const legend = fieldset ? textOf(fieldset.querySelector("legend, .fb-dash-form-element__label, [data-test-form-element-label]")) : "";
        const checked = group.find((r) => r.checked);
        fields.push({
          key: name,
          label: cleanText(legend) || labelFor(ctrl, WRAPPERS),
          type: "radio",
          element: fieldset || ctrl,
          required: group.some((r) => r.required || r.getAttribute("aria-required") === "true") || !!fieldset,
          currentValue: checked ? this.radioLabel(checked) : "",
          options: group.map((r) => this.radioLabel(r)).filter(Boolean),
        });
        continue;
      }

      const required =
        ctrl.hasAttribute("required") ||
        ctrl.getAttribute("aria-required") === "true" ||
        !!ctrl.closest("[data-test-form-element][required]");
      const currentValue =
        ctrl instanceof HTMLInputElement || ctrl instanceof HTMLTextAreaElement || ctrl instanceof HTMLSelectElement
          ? ctrl.value || ""
          : "";
      const options =
        ctrl instanceof HTMLSelectElement
          ? Array.from(ctrl.options).map((o) => o.text.trim()).filter((t) => t && !/^select/i.test(t))
          : undefined;

      fields.push({
        key: ctrl.id || labelFor(ctrl, WRAPPERS),
        label: labelFor(ctrl, WRAPPERS),
        type,
        element: ctrl,
        required,
        currentValue,
        options,
      });
    }
    return fields;
  }

  private radioLabel(radio: HTMLInputElement): string {
    const byFor = radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : null;
    if (byFor) return cleanText(byFor.textContent || "");
    const wrap = radio.closest("label");
    if (wrap) return cleanText(wrap.textContent || "");
    return cleanText(radio.value || "");
  }

  async attachResume(handle: ApplyHandle, file: File): Promise<number> {
    const root = this.findModal() || handle.root;
    let attached = 0;
    const inputs = root.querySelectorAll<HTMLInputElement>("input[type=file]");
    for (const input of Array.from(inputs)) {
      const accept = input.accept || "";
      const label = labelFor(input, WRAPPERS).toLowerCase();
      const wantsResume =
        /resume|cv|curriculum/.test(label) ||
        accept.includes("pdf") ||
        accept.includes("application/pdf") ||
        (!label && (accept === "" || accept.includes("*")));
      if (!wantsResume) continue;
      // Skip if LinkedIn already shows an uploaded file for this input.
      if (input.files && input.files.length > 0) continue;
      if (attachFile(input, file)) attached++;
    }
    return attached;
  }

  async setFieldValue(field: FormField, value: string): Promise<boolean> {
    if (field.type === "radio") {
      const root = this.findModal() || field.element;
      const radios = Array.from(root.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${CSS.escape(field.key)}"]`));
      const want = value.trim().toLowerCase();
      const match =
        radios.find((r) => this.radioLabel(r).toLowerCase() === want) ||
        radios.find((r) => this.radioLabel(r).toLowerCase().includes(want) || want.includes(this.radioLabel(r).toLowerCase()));
      if (match) {
        match.click();
        return true;
      }
      return false;
    }
    if (field.type === "checkbox") {
      const cb = field.element as HTMLInputElement;
      const on = value === "true" || value === "yes";
      if (cb.checked !== on) cb.click();
      return true;
    }
    if (field.type === "select") {
      return setSelect(field.element as HTMLSelectElement, value);
    }
    setNativeValue(field.element as HTMLInputElement | HTMLTextAreaElement, value);
    return true;
  }

  async advance(_handle: ApplyHandle): Promise<AdvanceResult> {
    const modal = this.findModal();
    if (!modal) {
      // Modal gone → either submitted & auto-closed, or dismissed.
      if (this.applyConfirmationShown()) return { status: "submitted" };
      return { status: "done" };
    }

    // Error banners on the current step block progress.
    const err = modal.querySelector(".artdeco-inline-feedback--error, .fb-dash-form-element-error");
    const submit = findButton(modal, ["submit application"]);
    if (submit) {
      if (err && isVisible(err as HTMLElement)) {
        return { status: "blocked", reason: cleanText(err.textContent || "a field needs attention") };
      }
      return { status: "submit-ready", button: submit };
    }

    if (err && isVisible(err as HTMLElement)) {
      return { status: "blocked", reason: cleanText(err.textContent || "a field needs attention") };
    }

    const review = findButton(modal, ["review"]);
    const next = findButton(modal, ["continue to next step", "next", "continue"]);
    const btn = review || next;
    if (!btn) return { status: "blocked", reason: "no Next/Review button found" };
    btn.click();
    return { status: "next" };
  }

  async submit(button: HTMLButtonElement): Promise<boolean> {
    button.click();
    // Wait for the post-apply confirmation, then dismiss it.
    await waitFor(() => (this.applyConfirmationShown() || !this.findModal() ? true : null), 6000);
    await sleep(500);
    this.dismissPostApply();
    return true;
  }

  private applyConfirmationShown(): boolean {
    const dialog = document.querySelector("div[role='dialog']");
    if (!dialog) return false;
    const txt = (dialog.textContent || "").toLowerCase();
    return /application sent|applied|your application was sent|premium/.test(txt) && !this.findModal();
  }

  private dismissPostApply(): void {
    // "Done" / "Not now" / dismiss (×) on the confirmation + "add to your job
    // search" upsell modals.
    const done =
      findButton(document, ["done", "not now", "no thanks"]) ||
      document.querySelector<HTMLButtonElement>("button[aria-label='Dismiss']");
    done?.click();
  }

  detectCaptcha(): boolean {
    if (/checkpoint\/challenge|\/challenge/.test(location.href)) return true;
    if (document.querySelector("iframe[src*='captcha'], iframe[title*='captcha' i], #captcha-internal, .challenge-dialog")) return true;
    return false;
  }

  closeApply(_handle: ApplyHandle): void {
    const modal = this.findModal();
    if (!modal) {
      this.dismissPostApply();
      return;
    }
    const dismiss =
      document.querySelector<HTMLButtonElement>("button[aria-label='Dismiss']") ||
      findButton(document, ["dismiss"]);
    dismiss?.click();
    // LinkedIn asks to save/discard the draft — click Discard.
    setTimeout(() => {
      const discard = findButton(document, ["discard"]);
      discard?.click();
    }, 400);
  }
}
