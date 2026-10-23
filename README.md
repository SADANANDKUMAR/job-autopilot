# 🚀 Job Autopilot

Drop your resume once. **Claude** extracts your profile, then the autopilot **searches**, **tailors your resume per job**, **fills the application**, and — in full-auto mode — **submits it for you**, throttled and capped, pausing only when it physically can't proceed (a CAPTCHA, or a required question it can't answer truthfully from your resume).

> ⚠️ **Read this first.** Automating applications and submitting without review is **against LinkedIn / Naukri / Indeed terms of service** and can get your account restricted or banned. Full-auto is opt-in and off by default's recommendation for a reason. CAPTCHAs are never solved for you. Use at your own risk.

## How it works

1. Install → open the popup → **drop your PDF resume** → click **Autofill from resume**. Claude reads it into a structured profile (contact, skills, work history, screening answers). Review the fields.
2. **Targets** tab: add job titles, locations, a minimum match score, and any exclude filters.
3. **Settings** tab: paste your `sk-ant-...` key, pick **Submit mode** (Assisted / Full-auto), a **daily cap**, and the delay range.
4. Open **Control** → **Start autopilot** (or press Start on the floating dock on any LinkedIn jobs page).
5. It searches your targets, and for each Easy Apply job: scores the fit, skips low matches, tailors the resume + cover letter, fills every field it recognizes, answers screening questions from your profile (asking Claude live for ones it hasn't seen), attaches your PDF, and advances the form.
   - **Full-auto:** clicks Submit, logs it, waits a randomized delay, moves on — until the daily cap.
   - **Assisted:** stops at Submit for your click.
6. It **pauses and tells you** on a CAPTCHA or any required field it can't answer. Fix it, press **Resume**.

## Modes

| | Assisted | Full-auto |
|---|---|---|
| Fills the whole form | ✅ | ✅ |
| Clicks Submit | 🚫 you do | ✅ unattended |
| Throttle + daily cap | — | ✅ |
| TOS / ban risk | low | **high — your call** |
| CAPTCHA | pauses for you | pauses for you |

## Platforms

| Platform | Status |
|---|---|
| **LinkedIn** Easy Apply | ✅ live |
| **Naukri** (quick-apply chatbot) | 🧪 beta — selectors need live tuning |
| **Indeed** (Indeed Apply) | 🧪 beta — cross-frame, needs live tuning |

- **Naukri** is multi-page and applies through a chatbot drawer (one question
  at a time), so the engine resumes the apply across page loads and walks the
  conversation.
- **Indeed Apply** renders its form in a **cross-origin iframe** the main page
  can't touch. So the content script runs in all frames: the SRP frame runs the
  engine, and a helper running *inside* the apply iframe (or the standalone
  smartapply tab) fills and submits, coordinating with the engine through
  shared storage. This is the most moving parts and the most likely to need a
  selector pass on first run.

All three sites use build-hashed class names — expect to adjust a selector or
two the first time you run against the live site.

New boards are a single driver module (`src/platforms/<site>/driver.ts`) implementing `PlatformDriver` — the engine is site-agnostic.

## Install (developer mode)

```bash
git clone <this-repo>
cd job-autopilot
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → **Developer mode** on → **Load unpacked** → select the `dist` folder.

## Architecture

```
src/
  shared/
    types.ts        profile, settings, jobs, messages
    driver.ts       PlatformDriver interface + shared DOM helpers
  lib/
    claude.ts       Claude via tool-use (parse resume · tailor · answer question)
    engine.ts       site-agnostic autopilot loop (search→tailor→fill→submit)
    formfill.ts     shared field scan + value resolution (engine & iframe helper)
    indeed-apply.ts Indeed Apply iframe helper (fills the cross-origin form)
    storage.ts      chrome.storage wrapper (profile/prefs/settings/log/counter/state)
    pdf.ts          PDF → text extraction (pdf.js)
  platforms/
    linkedin/driver.ts   LinkedIn (in-page Easy Apply modal)
    naukri/driver.ts     Naukri (multi-page + chatbot apply)
    indeed/driver.ts     Indeed (SRP engine + delegates iframe fill)
  content/
    dock.ts         shared boot + floating control dock
    linkedin.ts · naukri.ts · indeed.ts   thin per-site entries
  background/
    index.ts        MV3 worker: Claude calls (key stays here) + storage + state
  popup/            React control panel (Control · Profile · Targets · Settings · History)
```

## Privacy & safety

- **Resume, profile, API key** stay in `chrome.storage.local` on your machine.
- **Claude calls** go directly from the background worker to `api.anthropic.com` — the key never enters a job-board page context.
- Claude **never fabricates** résumé facts or screening answers; blanks mean it wasn't in your resume.
- No analytics, no telemetry, no third-party server.

## What's in v0.3

- ✅ Resume-drop → Claude-extracted structured profile
- ✅ Structured output via tool-use (no fragile JSON parsing)
- ✅ Autonomous search → queue → tailor → fill → submit loop
- ✅ Full-auto & Assisted modes, daily cap, randomized throttling
- ✅ Live question-answering for unseen screening fields
- ✅ Pause-and-resume on CAPTCHA / unanswerable required fields
- ✅ Floating control dock + popup control panel with live status
- ✅ Multi-page (MPA) support — resumes an apply across navigations
- ✅ Cross-frame apply — fills forms in cross-origin apply iframes
- 🧪 Naukri driver (chatbot apply) — beta
- 🧪 Indeed driver (cross-frame Indeed Apply) — beta
