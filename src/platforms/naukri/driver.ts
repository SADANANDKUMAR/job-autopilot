// Naukri driver — implements PlatformDriver for naukri.com.
//
// Naukri differs from LinkedIn in two big ways:
//   1. It's multi-page: opening a job is a full navigation, not an in-place
//      swap. openJob() returns "navigating" and the engine resumes the apply
//      on the job detail page after boot (via run.pendingApply).
//   2. Its apply flow is a CHATBOT drawer that asks one question at a time
//      (text box or selectable chips) and sends the application after the last
//      answer — there's no single multi-field form and no separate Submit. So
//      scanFields() returns just the CURRENT question as one field, and
//      advance() clicks "send" to reveal the next one until a success message
//      appears.
//
// Naukri's class names are build-hashed (styles_x__AbC12), so selectors match
// on PARTIAL class + ARIA + text. ⚠️ BETA: expect to tune these on the first
// live run — Naukri reshuffles its DOM often.

import type { PlatformDriver, ApplyHandle, AdvanceResult, FormField } from "@/shared/driver";
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

const WRAPPERS = "[class*='form-element'], [class*='fieldWrapper'], .form-row, label";

export class NaukriDriver implements PlatformDriver {
  readonly platform: Platform = "naukri";

  // ---- page classification -------------------------------------------------

  isSearchPage(): boolean {
    if (/-jobs(-in-[a-z0-9-]+)?(\/|\?|$)/.test(location.pathname)) return true;
    return !!document.querySelector(".srp-jobtuple-wrapper, article.jobTuple, .cust-job-tuple");
  }

  isJobPage(): boolean {
    return /^\/job-listings-/.test(location.pathname);
  }

  private jobIdFromUrl(url: string = location.href): string | null {
    // .../job-listings-<slug>-<digits>  (sometimes ?src=... trailing)
    const m = url.match(/job-listings-[^?#]*?-(\d{5,})(?:[?#/]|$)/);
    return m ? m[1] : null;
  }

  // ---- searching -----------------------------------------------------------

  buildSearchUrl(keyword: string, locationStr: string, remoteOk: boolean): string {
    const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const kw = slug(keyword) || "jobs";
    const base = locationStr
      ? `https://www.naukri.com/${kw}-jobs-in-${slug(locationStr)}`
      : `https://www.naukri.com/${kw}-jobs`;
    return remoteOk ? `${base}?wfhType=1` : base;
  }

  collectJobCards(): JobCard[] {
    const cards: JobCard[] = [];
    const seen = new Set<string>();
    const tuples = document.querySelectorAll<HTMLElement>(".srp-jobtuple-wrapper, article.jobTuple, .cust-job-tuple");
    for (const li of Array.from(tuples)) {
      const titleEl = li.querySelector<HTMLAnchorElement>("a.title, a[class*='title']");
      const href = titleEl?.href || "";
      const jobId = li.getAttribute("data-job-id") || this.jobIdFromUrl(href);
      if (!jobId || seen.has(jobId)) continue;

      const title = cleanText(titleEl?.getAttribute("title") || textOf(titleEl));
      const company = cleanText(textOf(li.querySelector("a.comp-name, [class*='comp-name'], a.subTitle, [class*='subTitle']")));
      const locStr = cleanText(textOf(li.querySelector("span.locWdth, [class*='locWdth'], [class*='loc-wrap'], .location, [class*='location']")));
      if (!title || !href) continue;

      seen.add(jobId);
      cards.push({
        platform: this.platform,
        jobId,
        url: href.startsWith("http") ? href : `https://www.naukri.com${href}`,
        title,
        company,
        location: locStr,
        applyKind: "unknown", // decided on the detail page (easy vs company-site)
      });
    }
    return cards;
  }

  async loadMoreResults(): Promise<boolean> {
    const before = this.collectJobCards().length;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1200);
    if (this.collectJobCards().length > before) return true;

    // Paginate: Naukri uses numbered pages with a "Next" link (a navigation).
    const next =
      document.querySelector<HTMLAnchorElement>("a[class*='pagination'][class*='next'], a.fright.btn-secondary") ||
      Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).find(
        (a) => /^next\b/i.test(cleanText(a.textContent || "")) && /pageNo|-jobs-\d|-\d(\?|$)/.test(a.href),
      ) ||
      null;
    if (next && next.href) {
      location.assign(next.href); // navigation → engine resumes on the new page
      return true;
    }
    return false;
  }

  // ---- a single job --------------------------------------------------------

  async openJob(card: JobCard): Promise<"opened" | "navigating" | "failed"> {
    // Naukri opens the detail page as a full navigation.
    location.assign(card.url);
    return "navigating";
  }

  scrapeJob(): JobPosting | null {
    const jobId = this.jobIdFromUrl();
    if (!jobId) return null;
    const title = textOf(this.pick(["[class*='jd-header-title']", "h1.jd-header-title", "header h1"]));
    const company = textOf(this.pick(["[class*='jd-header-comp-name'] a", "[class*='jd-header-comp-name']", "a.comp-name"]));
    const locStr = textOf(this.pick(["[class*='jhc__location']", "[class*='loc'] a", ".location"]));
    const desc = textOf(this.pick(["[class*='dang-inner-html']", "[class*='job-desc']", "section.styles_job-desc-container", ".dang-inner-html"]));
    if (!title || !desc) return null;
    return {
      platform: this.platform,
      jobId,
      url: location.href.split("?")[0],
      title: cleanText(title),
      company: cleanText(company),
      location: cleanText(locStr),
      applyKind: this.canAutoApply() ? "easy" : "external",
      description: cleanText(desc),
    };
  }

  canAutoApply(): boolean {
    // "Apply" = Naukri quick/chatbot apply. "Apply on company site" = external.
    const apply = document.querySelector<HTMLElement>("#apply-button, button[class*='apply-button']");
    if (apply && isVisible(apply) && !/company site/i.test(apply.textContent || "")) return true;
    const byText = findButton(document, ["apply"]);
    if (byText && !/company site/i.test(byText.textContent || "")) return true;
    return false;
  }

  alreadyApplied(): boolean {
    if (document.querySelector("[class*='already-applied'], [class*='applied-status']")) return true;
    const apply = document.querySelector("#apply-button, button[class*='apply-button']");
    return !!apply && /applied/i.test(apply.textContent || "");
  }

  // ---- the apply flow ------------------------------------------------------

  async startApply(): Promise<ApplyHandle | null> {
    const btn =
      document.querySelector<HTMLElement>("#apply-button") ||
      (findButton(document, ["apply"]) as HTMLElement | null);
    if (!btn) return null;
    btn.click();
    // Either the chatbot drawer opens, or it applies instantly (success toast).
    const ready = await waitFor(() => (this.chatbot() || this.applySucceeded() ? true : null), 6000);
    if (!ready) return null;
    return { root: this.chatbot() || document.body, step: 0 };
  }

  private chatbot(): HTMLElement | null {
    return this.pick([
      "[class*='chatbot_DrawerContentWrapper']",
      "[class*='chatbot_Drawer']",
      "[class*='_chatBotContainer']",
      "[class*='chatBot']",
    ]) as HTMLElement | null;
  }

  private applySucceeded(): boolean {
    const scope = this.chatbot() || document.body;
    const txt = (scope.textContent || "").toLowerCase();
    if (/successfully applied|application (has been )?sent|you have applied|applied successfully/.test(txt)) return true;
    return !!document.querySelector("[class*='apply_success'], [class*='applySuccess']");
  }

  scanFields(handle: ApplyHandle): FormField[] {
    const bot = this.chatbot();
    if (bot) {
      const field = this.currentChatbotQuestion(bot);
      return field ? [field] : [];
    }
    // Fallback: a classic inline form (rare on Naukri).
    const root = handle.root;
    const fields: FormField[] = [];
    for (const ctrl of Array.from(root.querySelectorAll<HTMLElement>("input, textarea, select"))) {
      const type = inferType(ctrl);
      if (type === "unknown" || type === "radio" || !isVisible(ctrl)) continue;
      const options = ctrl instanceof HTMLSelectElement ? Array.from(ctrl.options).map((o) => o.text.trim()).filter(Boolean) : undefined;
      fields.push({
        key: ctrl.id || labelFor(ctrl, WRAPPERS),
        label: labelFor(ctrl, WRAPPERS),
        type,
        element: ctrl,
        required: ctrl.hasAttribute("required") || ctrl.getAttribute("aria-required") === "true",
        currentValue: "value" in ctrl ? (ctrl as HTMLInputElement).value : "",
        options,
      });
    }
    return fields;
  }

  /** The latest unanswered question in the chatbot, as one field. */
  private currentChatbotQuestion(bot: HTMLElement): FormField | null {
    // Question text = the last bot message bubble.
    const msgs = bot.querySelectorAll("[class*='botMsg'], [class*='botItem'], li[class*='bot'], [class*='_messageText']");
    const label = msgs.length ? cleanText(textOf(msgs[msgs.length - 1])) : cleanText(textOf(bot)).slice(0, 160);

    // Selectable chips (single/multi choice).
    const chips = Array.from(bot.querySelectorAll<HTMLElement>("[class*='chip'], [class*='ssc__'] [class*='item'], [class*='radio'] label")).filter(isVisible);
    if (chips.length) {
      return {
        key: "chatbot-chips",
        label,
        type: "radio",
        element: bot,
        required: true,
        currentValue: "",
        options: chips.map((c) => cleanText(c.textContent || "")).filter(Boolean),
      };
    }

    // Text / contenteditable input.
    const input = bot.querySelector<HTMLElement>(
      "div[contenteditable='true'], textarea, input[type='text'], input[type='number'], input:not([type])",
    );
    if (input && isVisible(input)) {
      return {
        key: "chatbot-text",
        label,
        type: input instanceof HTMLTextAreaElement || input.getAttribute("contenteditable") === "true" ? "textarea" : "text",
        element: input,
        required: true,
        currentValue: "value" in input ? (input as HTMLInputElement).value : textOf(input),
      };
    }
    return null;
  }

  async attachResume(_handle: ApplyHandle, file: File): Promise<number> {
    // Naukri normally uses the resume on your profile; attach only if a file
    // input is explicitly present.
    let n = 0;
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("input[type=file]"))) {
      const accept = input.accept || "";
      if ((accept.includes("pdf") || accept === "") && isVisible(input) && (!input.files || input.files.length === 0)) {
        if (attachFile(input, file)) n++;
      }
    }
    return n;
  }

  async setFieldValue(field: FormField, value: string): Promise<boolean> {
    const bot = this.chatbot();
    if (bot && field.key === "chatbot-chips") {
      const want = value.trim().toLowerCase();
      const chips = Array.from(bot.querySelectorAll<HTMLElement>("[class*='chip'], [class*='ssc__'] [class*='item'], [class*='radio'] label")).filter(isVisible);
      const match =
        chips.find((c) => cleanText(c.textContent || "").toLowerCase() === want) ||
        chips.find((c) => cleanText(c.textContent || "").toLowerCase().includes(want) || want.includes(cleanText(c.textContent || "").toLowerCase()));
      if (match) {
        match.click();
        return true;
      }
      return false;
    }
    if (field.type === "select") return setSelect(field.element as HTMLSelectElement, value);

    const el = field.element;
    if (el.getAttribute && el.getAttribute("contenteditable") === "true") {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    }
    setNativeValue(el as HTMLInputElement | HTMLTextAreaElement, value);
    return true;
  }

  async advance(_handle: ApplyHandle): Promise<AdvanceResult> {
    await sleep(200);
    if (this.applySucceeded()) return { status: "submitted" };

    const bot = this.chatbot();
    if (!bot) {
      // Drawer gone without a success message — treat as done (be lenient).
      return this.alreadyApplied() ? { status: "submitted" } : { status: "done" };
    }

    // A validation/error bubble blocks progress.
    const err = bot.querySelector("[class*='error'], [class*='commentBox'] [class*='warning']");
    if (err && isVisible(err as HTMLElement) && cleanText(err.textContent || "")) {
      return { status: "blocked", reason: cleanText(err.textContent || "a chatbot answer was rejected") };
    }

    // Click "save"/"send" to submit the current answer and reveal the next Q.
    const send =
      this.pick(["[class*='sendMsg']", "[class*='send-msg']", "[class*='_sendMessageButton']", "[class*='save'][role='button']"]) ||
      findButton(bot, ["save", "send", "submit", "next"]);
    if (send) {
      (send as HTMLElement).click();
      return { status: "next" };
    }
    // No send button (chips may auto-advance) — let the loop re-scan.
    return { status: "next" };
  }

  async submit(button: HTMLButtonElement): Promise<boolean> {
    // Naukri auto-submits after the last chatbot answer; this is only reached
    // if a classic form exposed an explicit submit.
    button.click();
    await waitFor(() => (this.applySucceeded() ? true : null), 5000);
    return true;
  }

  detectCaptcha(): boolean {
    if (document.querySelector("iframe[src*='recaptcha'], iframe[title*='captcha' i], [class*='captcha']")) return true;
    // Naukri sometimes bounces to a login/OTP wall mid-session.
    if (/\/nlogin\/login|\/wapAuth/.test(location.href)) return true;
    return false;
  }

  closeApply(_handle: ApplyHandle): void {
    const close = this.pick([
      "[class*='chatbot'] [class*='crossIcon']",
      "[class*='chatbot_Nav'] [class*='cross']",
      "[class*='drawer'] [aria-label='Close']",
      "[class*='crossIcon']",
    ]);
    (close as HTMLElement | null)?.click();
  }

  // ---- internal ------------------------------------------------------------

  /** First matching element across a list of selectors (partial-class safe). */
  private pick(selectors: string[]): Element | null {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el as HTMLElement)) return el;
    }
    // Retry ignoring visibility (some bubbles measure 0 until animated in).
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
}
