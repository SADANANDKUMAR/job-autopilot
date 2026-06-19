// LinkedIn DOM selectors + helpers.
//
// LinkedIn ships React under the hood; class names are obfuscated and change
// across releases. We use data-test-id attributes where available (those are
// more stable than class names), with fallbacks to ARIA roles + accessible
// names + text-content matching.
//
// All selectors are wrapped in `safe...()` helpers that return null instead
// of throwing — the content script should never crash LinkedIn's page if a
// selector breaks.

export type ScrapedJob = {
  jobId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
};

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function getJobIdFromUrl(url: string = location.href): string | null {
  // Two LinkedIn job URL shapes:
  //   /jobs/view/3812340123/
  //   /jobs/search/?currentJobId=3812340123
  const viewMatch = url.match(/\/jobs\/view\/(\d+)/);
  if (viewMatch) return viewMatch[1];
  const u = new URL(url);
  const qp = u.searchParams.get("currentJobId");
  return qp || null;
}

export function isJobDetailUrl(url: string = location.href): boolean {
  return getJobIdFromUrl(url) !== null;
}

// ---------------------------------------------------------------------------
// Scraping the job page
// ---------------------------------------------------------------------------

export function scrapeJob(): ScrapedJob | null {
  const jobId = getJobIdFromUrl();
  if (!jobId) return null;

  const title = textOf(
    document.querySelector("h1.t-24, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title"),
  );

  // Company name — three plausible selectors LinkedIn has used over the past year
  const company =
    textOf(document.querySelector(".job-details-jobs-unified-top-card__company-name a")) ||
    textOf(document.querySelector(".jobs-unified-top-card__company-name a")) ||
    textOf(document.querySelector(".jobs-unified-top-card__company-name"));

  // Location is often in a tertiary-text span after the company name
  const location =
    textOf(document.querySelector(".job-details-jobs-unified-top-card__primary-description-container .tvm__text--low-emphasis")) ||
    textOf(document.querySelector(".jobs-unified-top-card__bullet")) ||
    "";

  // Description — LinkedIn uses several class names depending on A/B test cohort
  const desc =
    textOf(document.querySelector(".jobs-description__content .jobs-description-content__text")) ||
    textOf(document.querySelector(".jobs-description-content__text")) ||
    textOf(document.querySelector(".jobs-description")) ||
    "";

  if (!title || !desc) return null;

  return {
    jobId,
    url: `https://www.linkedin.com/jobs/view/${jobId}/`,
    title: cleanText(title),
    company: cleanText(company),
    location: cleanText(location),
    description: cleanText(desc),
  };
}

// ---------------------------------------------------------------------------
// Easy Apply detection
// ---------------------------------------------------------------------------

/** Returns the Easy Apply button on the current job detail page, or null. */
export function findEasyApplyButton(): HTMLButtonElement | null {
  // Modern selector: data-job-id + button content == "Easy Apply"
  const candidates = document.querySelectorAll<HTMLButtonElement>(
    "button.jobs-apply-button, .jobs-apply-button button, button[aria-label*='Easy Apply' i]",
  );
  for (const btn of candidates) {
    const txt = (btn.textContent || "").trim().toLowerCase();
    if (txt.includes("easy apply")) return btn;
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("easy apply")) return btn;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Easy Apply modal field walker
//
// LinkedIn's Easy Apply modal is a multi-step form. Each step renders a
// container with fieldsets; we iterate inputs and label-match by accessible
// name. Fields we know how to fill:
//   • text: name, email, phone, city
//   • numeric: years-of-experience screening questions
//   • select / dropdown: yes/no questions, country code, etc.
//   • textarea: cover letter, longer answers
// ---------------------------------------------------------------------------

export type FormField = {
  id: string;
  label: string;
  type: "text" | "email" | "tel" | "number" | "textarea" | "select" | "checkbox" | "radio" | "file" | "unknown";
  element: HTMLElement;
  required: boolean;
  currentValue: string;
  options?: string[];   // for select / radio
};

export function findEasyApplyModal(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(".jobs-easy-apply-modal") ||
    document.querySelector<HTMLElement>("div[role='dialog'][aria-labelledby*='easy-apply']") ||
    document.querySelector<HTMLElement>("div[data-test-modal='easy-apply-modal']")
  );
}

export function scanFormFields(root: HTMLElement): FormField[] {
  const fields: FormField[] = [];

  // Each labeled input lives inside a `.jobs-easy-apply-form-element` (or
  // similar). Walk every input-shaped element under the root.
  const controls = root.querySelectorAll<HTMLElement>("input, textarea, select");
  for (const ctrl of Array.from(controls)) {
    const type = inferType(ctrl);
    if (type === "unknown") continue;

    const id = ctrl.id || "";
    const label = findLabelText(ctrl);
    const required =
      ctrl.hasAttribute("required") ||
      ctrl.getAttribute("aria-required") === "true" ||
      !!ctrl.closest("[required]");

    const currentValue =
      ctrl instanceof HTMLInputElement || ctrl instanceof HTMLTextAreaElement || ctrl instanceof HTMLSelectElement
        ? ctrl.value || ""
        : "";

    const options =
      ctrl instanceof HTMLSelectElement
        ? Array.from(ctrl.options).map((o) => o.text.trim()).filter(Boolean)
        : undefined;

    fields.push({ id, label, type, element: ctrl, required, currentValue, options });
  }

  return fields;
}

/** Fire React-compatible input events so LinkedIn's controlled inputs commit. */
export function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const desc =
    Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    );
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function setSelectValue(el: HTMLSelectElement, value: string): boolean {
  const wanted = value.trim().toLowerCase();
  const opt = Array.from(el.options).find(
    (o) => o.text.trim().toLowerCase() === wanted || o.value.trim().toLowerCase() === wanted,
  );
  if (!opt) return false;
  el.value = opt.value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Find LinkedIn's "Next" / "Submit application" button in the modal. */
export function findModalAdvanceButton(modal: HTMLElement): { btn: HTMLButtonElement; isSubmit: boolean } | null {
  const buttons = modal.querySelectorAll<HTMLButtonElement>("button[type='button'], button[type='submit'], button");
  for (const b of Array.from(buttons)) {
    const aria = (b.getAttribute("aria-label") || "").toLowerCase();
    const txt = (b.textContent || "").trim().toLowerCase();
    if (aria.includes("submit application") || txt === "submit application") return { btn: b, isSubmit: true };
    if (aria.includes("review") || txt.startsWith("review")) return { btn: b, isSubmit: false };
    if (aria.includes("continue") || aria.includes("next") || txt === "next" || txt === "continue") {
      return { btn: b, isSubmit: false };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function inferType(el: HTMLElement): FormField["type"] {
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLInputElement) {
    const t = (el.type || "text").toLowerCase();
    if (t === "email") return "email";
    if (t === "tel") return "tel";
    if (t === "number") return "number";
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "file") return "file";
    if (t === "hidden" || t === "submit" || t === "button") return "unknown";
    return "text";
  }
  return "unknown";
}

function findLabelText(ctrl: HTMLElement): string {
  // 1. aria-label wins if present
  const aria = ctrl.getAttribute("aria-label");
  if (aria) return cleanText(aria);

  // 2. associated <label for=...>
  const id = ctrl.id;
  if (id) {
    const lbl = document.querySelector(`label[for="${cssEscape(id)}"]`);
    if (lbl) return cleanText(lbl.textContent || "");
  }

  // 3. enclosing label
  const wrapping = ctrl.closest("label");
  if (wrapping) return cleanText(wrapping.textContent || "");

  // 4. preceding label-ish element in the form-element wrapper
  const wrapper = ctrl.closest(".jobs-easy-apply-form-element, .artdeco-text-input, [data-test-form-element]");
  if (wrapper) {
    const lbl = wrapper.querySelector("label, .artdeco-text-input__label, .fb-form-element-label");
    if (lbl) return cleanText(lbl.textContent || "");
  }

  return "";
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() || "";
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cssEscape(s: string): string {
  // Polyfill for older Chromium versions without CSS.escape
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/(["\\\[\]])/g, "\\$1");
}
