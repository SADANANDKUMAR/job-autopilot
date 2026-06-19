// Claude API wrapper — called from the background service worker so the API
// key never reaches the LinkedIn page context. We use the REST API directly
// (not the SDK) because the SDK pulls in node-fetch + streams which inflate
// the service-worker bundle for no real benefit here.

import type { JobContext, Profile, Resume, Preferences, TailorResult } from "@/shared/types";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export class ClaudeError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ClaudeError";
  }
}

const SYSTEM_PROMPT = `You are an expert career coach + resume strategist. Given a user's base resume and a target job description, you tailor the resume to maximize the candidate's chance of getting an interview at THIS specific company for THIS specific role.

Your output is a structured JSON object — never prose, never markdown wrappers.

Rules:
1. NEVER invent experience, skills, employers, dates, or degrees the user doesn't have. Reframe is fine; fabrication is not.
2. Mirror the language of the JD where the user's actual experience matches — same verbs, same nouns. ATS systems keyword-match.
3. Lead each bullet with quantified impact when possible (numbers, %s, currency, scale).
4. Cut anything irrelevant to this role even if it was in the original. A tight 1-page resume beats a bloated 2-page one.
5. matchScore should reflect actual fit, not flattery — 60 means "decent but not perfect", 85 means "strong match", 95+ should be rare and mean "exactly the role they're built for".
6. screeningAnswers: anticipate 4-6 common LinkedIn Easy Apply screening questions for this kind of role (years of experience in X, eligible to work in Y location, willing to relocate, current notice period, current/expected CTC for India, English proficiency, etc). Use the user's profile data to answer truthfully. If you don't have the data, write "[NEEDS USER INPUT]" — never guess.
7. Cover letter: 3 paragraphs max, ~120 words. Specific to this company + role, not generic. Open with why THIS company specifically.

Return ONLY valid JSON matching this shape:
{
  "tailoredResume": "Full tailored resume as plain text — preserve sectioning (SUMMARY, EXPERIENCE, SKILLS, EDUCATION) with simple line breaks. No markdown.",
  "matchScore": 0-100 integer,
  "keyHighlights": ["3-5 bullet talking points to emphasize verbally if asked"],
  "coverLetter": "Short cover letter",
  "screeningAnswers": [{"question": "...", "answer": "..."}]
}`;

export type TailorInput = {
  job: JobContext;
  profile: Profile;
  resume: Resume;
  prefs: Preferences;
  apiKey: string;
  model: string;
};

export async function tailorResume(input: TailorInput): Promise<TailorResult> {
  const { job, profile, resume, prefs, apiKey, model } = input;

  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    throw new ClaudeError("Missing or invalid Anthropic API key. Open Job Autopilot popup → Settings to add one.");
  }
  if (!resume.text || resume.text.length < 100) {
    throw new ClaudeError("Resume is empty or too short. Paste your full resume in the popup → Profile tab.");
  }

  const userMessage = [
    "=== CANDIDATE PROFILE ===",
    `Name: ${profile.fullName || "[not set]"}`,
    `Email: ${profile.email || "[not set]"}`,
    `Phone: ${profile.phone || "[not set]"}`,
    `Location: ${profile.location || "[not set]"}`,
    profile.linkedinUrl ? `LinkedIn: ${profile.linkedinUrl}` : "",
    profile.portfolioUrl ? `Portfolio: ${profile.portfolioUrl}` : "",
    profile.yearsExperience !== undefined ? `Years experience: ${profile.yearsExperience}` : "",
    "",
    "=== BASE RESUME ===",
    resume.text,
    "",
    "=== JOB PREFERENCES ===",
    `Target titles: ${prefs.targetTitles.join(", ") || "[not set]"}`,
    `Target locations: ${prefs.targetLocations.join(", ") || "[not set]"}`,
    `Remote OK: ${prefs.remoteOk ? "yes" : "no"}`,
    prefs.minSalaryLpa ? `Min salary: ₹${prefs.minSalaryLpa}L per annum` : "",
    "",
    "=== TARGET JOB ===",
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${job.location}`,
    `URL: ${job.url}`,
    "",
    "Job description:",
    job.description,
    "",
    "Return tailored output as JSON per the schema in the system prompt.",
  ].filter(Boolean).join("\n");

  const body = {
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ClaudeError(`Claude API ${res.status}: ${text.slice(0, 300)}`, res.status);
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };

  const textBlock = json.content?.find((c) => c.type === "text")?.text || "";
  if (!textBlock) {
    throw new ClaudeError("Claude returned no text content. Try again.");
  }

  // Claude sometimes wraps JSON in ```json ... ``` despite system-prompt
  // instructions. Strip those fences if present, then parse.
  const cleaned = textBlock
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as TailorResult;
    // Minimal shape validation — we don't need a heavy schema lib in a service worker
    if (typeof parsed.tailoredResume !== "string" || typeof parsed.matchScore !== "number") {
      throw new Error("missing required fields");
    }
    parsed.keyHighlights = Array.isArray(parsed.keyHighlights) ? parsed.keyHighlights : [];
    parsed.screeningAnswers = Array.isArray(parsed.screeningAnswers) ? parsed.screeningAnswers : [];
    parsed.coverLetter = parsed.coverLetter || "";
    return parsed;
  } catch (e) {
    throw new ClaudeError(`Claude returned malformed JSON: ${(e as Error).message}. Raw: ${cleaned.slice(0, 200)}`);
  }
}
