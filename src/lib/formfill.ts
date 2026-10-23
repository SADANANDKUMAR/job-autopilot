// Shared form-filling primitives used by the engine's driver loop AND by the
// Indeed apply-iframe helper (which fills a cross-origin form the top-frame
// engine can't reach). Keeping these here means one mapping, one behavior.
//
// resolveFieldValue() maps a field to a value: profile first, then the tailor's
// prepared screening answers, then a live Claude call for anything unseen. It
// messages the background worker for that last step, which works from any frame
// (content scripts in iframes can use chrome.runtime).

import type { FieldType, FormField } from "@/shared/driver";
import {
  cleanText,
  inferType,
  labelFor,
  setNativeValue,
  setSelect,
  isVisible,
} from "@/shared/driver";
import type { Profile, TailorResult, JobContext, Msg, MsgResponse } from "@/shared/types";

// ---------------------------------------------------------------------------
// Generic field scanning (radio groups collapsed to one field w/ options).
// ---------------------------------------------------------------------------

export function scanGenericFields(root: ParentNode, wrappers: string): FormField[] {
  const fields: FormField[] = [];
  const radioGroups = new Set<string>();

  for (const ctrl of Array.from(root.querySelectorAll<HTMLElement>("input, textarea, select, [contenteditable='true']"))) {
    let type: FieldType = ctrl.getAttribute("contenteditable") === "true" ? "textarea" : inferType(ctrl);
    if (type === "unknown" || !isVisible(ctrl)) continue;

    if (type === "radio") {
      const name = (ctrl as HTMLInputElement).name || "";
      if (!name || radioGroups.has(name)) continue;
      radioGroups.add(name);
      const group = Array.from(root.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${cssEscape(name)}"]`));
      const fieldset = ctrl.closest("fieldset");
      const legend = fieldset ? cleanText(textOf(fieldset.querySelector("legend, [class*='label'], [class*='question']"))) : "";
      const checked = group.find((r) => r.checked);
      fields.push({
        key: name,
        label: legend || labelFor(ctrl, wrappers),
        type: "radio",
        element: fieldset || ctrl,
        required: group.some((r) => r.required || r.getAttribute("aria-required") === "true"),
        currentValue: checked ? radioLabel(checked, wrappers) : "",
        options: group.map((r) => radioLabel(r, wrappers)).filter(Boolean),
      });
      continue;
    }

    const options =
      ctrl instanceof HTMLSelectElement
        ? Array.from(ctrl.options).map((o) => o.text.trim()).filter((t) => t && !/^select/i.test(t))
        : undefined;

    fields.push({
      key: ctrl.id || labelFor(ctrl, wrappers),
      label: labelFor(ctrl, wrappers),
      type,
      element: ctrl,
      required: ctrl.hasAttribute("required") || ctrl.getAttribute("aria-required") === "true" || !!ctrl.closest("[required]"),
      currentValue:
        "value" in ctrl ? (ctrl as HTMLInputElement).value : ctrl.getAttribute("contenteditable") === "true" ? textOf(ctrl) : "",
      options,
    });
  }
  return fields;
}

export function radioLabel(radio: HTMLInputElement, wrappers: string): string {
  if (radio.id) {
    const byFor = document.querySelector(`label[for="${cssEscape(radio.id)}"]`);
    if (byFor) return cleanText(byFor.textContent || "");
  }
  const wrap = radio.closest("label") || radio.closest(wrappers);
  if (wrap) return cleanText(wrap.textContent || "");
  return cleanText(radio.value || "");
}

// ---------------------------------------------------------------------------
// Apply a resolved value to a field (text / select / checkbox / radio / CE).
// ---------------------------------------------------------------------------

export function applyFieldValue(field: FormField, value: string, root: ParentNode = document): boolean {
  if (field.type === "radio") {
    const radios = Array.from(root.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${cssEscape(field.key)}"]`));
    const want = value.trim().toLowerCase();
    const match =
      radios.find((r) => radioLabel(r, "label").toLowerCase() === want) ||
      radios.find((r) => radioLabel(r, "label").toLowerCase().includes(want) || want.includes(radioLabel(r, "label").toLowerCase()));
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

// ---------------------------------------------------------------------------
// Resolve a field → value. Profile → prepared answers → live Claude.
// Returns null when nothing confident is available.
// ---------------------------------------------------------------------------

export async function resolveFieldValue(
  field: FormField,
  profile: Profile,
  tailor: TailorResult,
  job: JobContext,
): Promise<string | null> {
  if (field.currentValue && field.currentValue.trim()) return null; // don't clobber

  const label = field.label.toLowerCase();

  if (field.type === "checkbox") return field.required ? "true" : null;

  const direct = mapProfile(field, label, profile);
  if (direct !== null) return direct;

  if (field.type === "textarea" && anyOf(label, ["cover letter", "why are you interested", "tell us about yourself", "anything else", "message to", "additional information", "summary", "why do you want"])) {
    return tailor.coverLetter;
  }

  for (const sa of tailor.screeningAnswers) {
    if (labelOverlap(label, sa.question.toLowerCase()) && sa.answer && !sa.answer.includes("[NEEDS USER INPUT]")) {
      return sa.answer;
    }
  }

  if (label && (field.required || field.type === "select" || field.type === "radio")) {
    const res = await bg<{ answer: string; confident: boolean }>({
      kind: "answer-question",
      question: field.label,
      job,
      options: field.options,
    });
    if (res.ok && res.data.confident && res.data.answer.trim()) return res.data.answer.trim();
  }
  return null;
}

function mapProfile(field: FormField, label: string, p: Profile): string | null {
  if (anyOf(label, ["first name", "given name"])) return p.firstName || firstWord(p.fullName);
  if (anyOf(label, ["last name", "surname", "family name"])) return p.lastName || restWords(p.fullName);
  if (anyOf(label, ["full name", "your name"]) || label === "name") return p.fullName;
  if (field.type === "email" || anyOf(label, ["email"])) return p.email;
  if (field.type === "tel" || anyOf(label, ["phone", "mobile", "contact number"])) return p.phone;
  if (anyOf(label, ["country code", "phone country"])) return p.phoneCountryCode || "";
  if (anyOf(label, ["city", "current location", "where are you based", "location"])) return p.city || p.location;
  if (anyOf(label, ["country"])) return p.country || "";
  if (anyOf(label, ["linkedin"])) return p.linkedinUrl || "";
  if (anyOf(label, ["github"])) return p.githubUrl || "";
  if (anyOf(label, ["portfolio", "website", "personal site"])) return p.portfolioUrl || "";
  if (anyOf(label, ["current company", "present employer"])) return p.currentCompany || "";
  if (anyOf(label, ["current title", "current designation", "job title", "current role"])) return p.currentTitle || p.headline || "";
  if (anyOf(label, ["total experience", "years of experience", "years experience", "how many years", "work experience"])) {
    return p.yearsExperience !== undefined ? String(p.yearsExperience) : null;
  }
  if (anyOf(label, ["notice period"])) return p.noticePeriodDays !== undefined ? String(p.noticePeriodDays) : null;
  if (anyOf(label, ["current ctc", "current salary", "present ctc"])) return p.currentCtcLpa !== undefined ? String(p.currentCtcLpa) : null;
  if (anyOf(label, ["expected ctc", "expected salary"])) return p.expectedCtcLpa !== undefined ? String(p.expectedCtcLpa) : null;
  if (anyOf(label, ["relocate"]) && p.willingToRelocate !== undefined) return p.willingToRelocate ? "Yes" : "No";
  if (anyOf(label, ["sponsorship", "require visa", "work authorization", "authorized to work", "right to work"]) && p.requiresVisaSponsorship !== undefined) {
    return p.requiresVisaSponsorship ? "No" : "Yes";
  }
  return null;
}

// ---------------------------------------------------------------------------

function anyOf(label: string, needles: string[]): boolean {
  return needles.some((n) => label.includes(n));
}

function labelOverlap(a: string, b: string): boolean {
  const wordsA = new Set(a.split(/\W+/).filter((w) => w.length > 3));
  const wordsB = b.split(/\W+/).filter((w) => w.length > 3);
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return overlap >= 3 || (wordsB.length > 0 && wordsB.length <= 4 && overlap >= 2);
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0] || "";
}
function restWords(s: string): string {
  const parts = s.trim().split(/\s+/);
  return parts.slice(1).join(" ") || s.trim();
}

function textOf(el: Element | null | undefined): string {
  return el?.textContent?.trim() || "";
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/(["\\[\]])/g, "\\$1");
}

async function bg<T>(msg: Msg): Promise<MsgResponse<T>> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as MsgResponse<T>;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
