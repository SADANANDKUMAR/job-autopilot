// Claude API wrapper — runs in the background service worker so the API key
// never reaches a job-board page context. We call the REST API directly (no
// SDK) to keep the service-worker bundle tiny.
//
// v0.3: every call uses TOOL-USE structured output (tool_choice forced) so the
// model returns a typed object, never prose we have to fence-strip and pray
// over. This is what makes unattended runs reliable.

import type { JobContext, Profile, Resume, Preferences, TailorResult } from "@/shared/types";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export class ClaudeError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ClaudeError";
  }
}

type ToolUseBlock = { type: "tool_use"; name: string; input: unknown };
type ApiResponse = {
  content?: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
  stop_reason?: string;
  error?: { message?: string };
};

type CallArgs = {
  apiKey: string;
  model: string;
  system: string;
  userContent: string;
  tool: { name: string; description: string; input_schema: Record<string, unknown> };
  maxTokens?: number;
};

/** One request → forced tool call → the tool's typed input object. */
async function callTool<T>(args: CallArgs): Promise<T> {
  const { apiKey, model, system, userContent, tool, maxTokens = 4096 } = args;

  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    throw new ClaudeError("Missing or invalid Anthropic API key. Open the popup → Settings.");
  }

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: userContent }],
  };

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ClaudeError(`Network error reaching Claude: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as ApiResponse).error?.message || msg;
    } catch {
      /* keep raw */
    }
    throw new ClaudeError(`Claude API ${res.status}: ${msg}`, res.status);
  }

  const json = (await res.json()) as ApiResponse;
  const block = json.content?.find((c): c is ToolUseBlock => c.type === "tool_use" && c.name === tool.name);
  if (!block || typeof block.input !== "object" || block.input === null) {
    throw new ClaudeError("Claude did not return structured output. Try again.");
  }
  return block.input as T;
}

// ===========================================================================
// 1. Resume → structured Profile
// ===========================================================================

const PARSE_SYSTEM = `You extract a structured candidate profile from a raw resume. Be faithful: copy facts exactly as written. NEVER invent data. If a field is absent from the resume, omit it (or use an empty string/array). Normalize phone numbers to include the country code when you can infer it from context. For yearsExperience, compute total professional years from the work history (round to the nearest whole number).`;

const PROFILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    fullName: { type: "string" },
    firstName: { type: "string" },
    lastName: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    phoneCountryCode: { type: "string", description: "e.g. +91" },
    location: { type: "string", description: "City, Country" },
    city: { type: "string" },
    country: { type: "string" },
    linkedinUrl: { type: "string" },
    portfolioUrl: { type: "string" },
    githubUrl: { type: "string" },
    headline: { type: "string" },
    summary: { type: "string" },
    yearsExperience: { type: "number" },
    currentCompany: { type: "string" },
    currentTitle: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
    work: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
          location: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
        },
        required: ["company", "title", "startDate", "endDate", "bullets"],
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          institution: { type: "string" },
          degree: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
          grade: { type: "string" },
        },
        required: ["institution", "degree"],
      },
    },
    certifications: { type: "array", items: { type: "string" } },
    languages: { type: "array", items: { type: "string" } },
  },
  required: ["fullName", "firstName", "lastName", "email", "phone", "location", "skills", "work", "education"],
};

export async function parseResume(resumeText: string, apiKey: string, model: string): Promise<Partial<Profile>> {
  if (!resumeText || resumeText.trim().length < 80) {
    throw new ClaudeError("Resume text is empty or too short to parse.");
  }
  const parsed = await callTool<Partial<Profile>>({
    apiKey,
    model,
    system: PARSE_SYSTEM,
    userContent: `=== RESUME ===\n${resumeText}\n\nExtract the structured profile.`,
    tool: {
      name: "save_profile",
      description: "Save the structured candidate profile extracted from the resume.",
      input_schema: PROFILE_SCHEMA,
    },
    maxTokens: 4096,
  });
  // Belt-and-braces: ensure arrays exist so downstream code never NPEs.
  parsed.skills = parsed.skills ?? [];
  parsed.work = parsed.work ?? [];
  parsed.education = parsed.education ?? [];
  if (!parsed.fullName && (parsed.firstName || parsed.lastName)) {
    parsed.fullName = [parsed.firstName, parsed.lastName].filter(Boolean).join(" ");
  }
  return parsed;
}

// ===========================================================================
// 2. Tailor resume + cover letter + screening answers for one JD
// ===========================================================================

const TAILOR_SYSTEM = `You are an expert career coach + resume strategist. Given a candidate's structured profile and a target job description, you tailor their resume to maximize interview chances for THIS specific role.

Rules:
1. NEVER invent experience, skills, employers, dates, or degrees. Reframing is fine; fabrication is not.
2. Mirror the JD's language where the candidate's real experience matches — same verbs, same nouns. ATS systems keyword-match.
3. Lead bullets with quantified impact when the source resume has numbers.
4. Cut anything irrelevant to this role. A tight resume beats a bloated one.
5. matchScore reflects actual fit, not flattery — 60 = decent, 85 = strong, 95+ should be rare (exactly built for it).
6. screeningAnswers: anticipate the common questions THIS job's Easy/quick apply will ask (years in X, work authorization, relocation, notice period, current/expected CTC for India roles, English proficiency). Answer truthfully from the profile. If the profile lacks the data, answer "[NEEDS USER INPUT]" — never guess.
7. Cover letter: 3 short paragraphs, ~120 words, specific to this company + role.`;

const TAILOR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    tailoredResume: {
      type: "string",
      description: "Full tailored resume as plain text, sectioned (SUMMARY, EXPERIENCE, SKILLS, EDUCATION), no markdown.",
    },
    matchScore: { type: "integer", description: "0-100 fit for this JD" },
    keyHighlights: { type: "array", items: { type: "string" }, description: "3-5 talking points" },
    coverLetter: { type: "string" },
    screeningAnswers: {
      type: "array",
      items: {
        type: "object",
        properties: { question: { type: "string" }, answer: { type: "string" } },
        required: ["question", "answer"],
      },
    },
  },
  required: ["tailoredResume", "matchScore", "keyHighlights", "coverLetter", "screeningAnswers"],
};

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
  if (!resume.text || resume.text.length < 80) {
    throw new ClaudeError("Resume is empty or too short. Add it in the popup → Profile.");
  }

  const userContent = [
    "=== CANDIDATE PROFILE ===",
    JSON.stringify(compactProfile(profile), null, 2),
    "",
    "=== BASE RESUME (verbatim) ===",
    resume.text,
    "",
    "=== JOB PREFERENCES ===",
    `Target titles: ${prefs.targetTitles.join(", ") || "[not set]"}`,
    `Target locations: ${prefs.targetLocations.join(", ") || "[not set]"}`,
    `Remote OK: ${prefs.remoteOk ? "yes" : "no"}`,
    prefs.minSalaryLpa ? `Min salary: ₹${prefs.minSalaryLpa}L/annum` : "",
    "",
    "=== TARGET JOB ===",
    `Platform: ${job.platform}`,
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${job.location}`,
    "",
    "Job description:",
    job.description,
  ].filter(Boolean).join("\n");

  const result = await callTool<TailorResult>({
    apiKey,
    model,
    system: TAILOR_SYSTEM,
    userContent,
    tool: {
      name: "submit_tailored_application",
      description: "Return the tailored resume, match score, highlights, cover letter and screening answers.",
      input_schema: TAILOR_SCHEMA,
    },
    maxTokens: 4096,
  });

  result.keyHighlights = Array.isArray(result.keyHighlights) ? result.keyHighlights : [];
  result.screeningAnswers = Array.isArray(result.screeningAnswers) ? result.screeningAnswers : [];
  result.coverLetter = result.coverLetter || "";
  if (typeof result.matchScore !== "number") result.matchScore = 0;
  return result;
}

// ===========================================================================
// 3. Answer ONE live screening question the tailor didn't anticipate
//    (used mid-form so autopilot doesn't stall on an unexpected field)
// ===========================================================================

const ANSWER_SYSTEM = `You answer a single job-application screening question on the candidate's behalf, truthfully, using ONLY their profile. If the question needs data the profile doesn't contain, set "answer" to "" and "confident" to false — do not guess personal facts (visa status, exact CTC, etc). For numeric questions (years of experience) return just the number. For yes/no return "Yes" or "No". If options are given, your answer MUST be exactly one of them.`;

const ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The value to type/select. Empty if not confidently answerable." },
    confident: { type: "boolean" },
  },
  required: ["answer", "confident"],
};

export async function answerQuestion(
  question: string,
  options: string[] | undefined,
  profile: Profile,
  job: JobContext,
  apiKey: string,
  model: string,
): Promise<{ answer: string; confident: boolean }> {
  const userContent = [
    "=== CANDIDATE PROFILE ===",
    JSON.stringify(compactProfile(profile), null, 2),
    "",
    `=== JOB === ${job.title} @ ${job.company} (${job.location})`,
    "",
    `QUESTION: ${question}`,
    options && options.length ? `OPTIONS (pick exactly one): ${options.join(" | ")}` : "",
    "",
    "Answer from the profile only.",
  ].filter(Boolean).join("\n");

  return callTool<{ answer: string; confident: boolean }>({
    apiKey,
    model,
    system: ANSWER_SYSTEM,
    userContent,
    tool: {
      name: "answer",
      description: "Provide the answer to the screening question.",
      input_schema: ANSWER_SCHEMA,
    },
    maxTokens: 512,
  });
}

// ---------------------------------------------------------------------------

/** Trim the profile to the fields Claude needs — keeps prompts cheap. */
function compactProfile(p: Profile): Record<string, unknown> {
  return {
    name: p.fullName,
    headline: p.headline,
    location: p.location,
    yearsExperience: p.yearsExperience,
    currentTitle: p.currentTitle,
    currentCompany: p.currentCompany,
    currentCtcLpa: p.currentCtcLpa,
    expectedCtcLpa: p.expectedCtcLpa,
    noticePeriodDays: p.noticePeriodDays,
    willingToRelocate: p.willingToRelocate,
    requiresVisaSponsorship: p.requiresVisaSponsorship,
    authorizedCountries: p.authorizedCountries,
    skills: p.skills,
    work: p.work,
    education: p.education,
    certifications: p.certifications,
    languages: p.languages,
  };
}
