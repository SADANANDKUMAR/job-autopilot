# 🚀 Job Autopilot

A Chrome extension that tailors your resume with **Claude AI** and auto-fills the LinkedIn **Easy Apply** form. You always click Submit yourself — LinkedIn TOS-safe.

## How it works

1. Install once → open the popup → paste your **resume**, **Anthropic API key**, and a few profile details
2. Browse LinkedIn job listings as normal
3. On any **Easy Apply** job, a purple **🚀 Autopilot Apply** button appears next to LinkedIn's button
4. Click it → Claude tailors your resume to this specific JD (~10s)
5. A side-panel shows: match score, tailored resume, cover letter, prepared answers to common screening questions
6. Click **Fill the form** → extension clicks Easy Apply for you and walks through the multi-step modal, filling every field it recognizes
7. **Extension stops at the Submit button.** You review and click Submit yourself

## Install (developer mode)

```bash
git clone <this-repo>
cd job-autopilot
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `job-autopilot/dist` folder

The 🚀 icon appears in your toolbar. Click it → set up Profile → set up Settings (paste `sk-ant-...` key from [console.anthropic.com](https://console.anthropic.com/settings/keys)) → done.

## What's safe vs not

| Behavior | Status |
|---|---|
| Read job description from page | ✅ safe |
| Send JD + your resume to Claude API | ✅ safe (your own API key) |
| Click LinkedIn's Easy Apply button | ✅ same as you clicking it |
| Fill text inputs in the modal | ✅ same as you typing |
| Click the final **Submit application** button | 🚫 **never** — you do this manually |

The extension never opens new tabs, never scrapes other users' data, never submits anything without your final click.

## Privacy

- **Resume + profile + API key** stay in `chrome.storage.local` on your machine
- **Claude API calls** go directly from your browser to `api.anthropic.com` (no Job Autopilot server in between)
- **No analytics, no telemetry, no third-party tracking**

## What's in v0.2

- ✅ Onboarding popup (resume + profile + targets + API key)
- ✅ LinkedIn job detection on `linkedin.com/jobs/*`
- ✅ Claude-tailored resume + cover letter + screening answers
- ✅ Easy Apply form auto-fill (text/email/phone/numeric/select/textarea)
- ✅ Stops at Submit button — TOS-safe
- ✅ History tab (last 500 applications)
- ✅ **PDF resume drag-drop** — pdf.js extracts text, lazy-loaded so popup stays fast
- ✅ **PDF auto-attached** to LinkedIn upload fields via DataTransfer (same path the browser uses for drag-drop)

## Roadmap

- v0.3: Radio / checkbox / artdeco-listbox screening question support
- v0.4: Naukri.com support
- v0.5: Indeed Apply support
- v0.6: Batch mode — queue 50 jobs to review one-by-one
- v0.7: Daily "10 jobs you'd be a fit for" digest

## File structure

```
job-autopilot/
├── manifest.config.ts        MV3 manifest (via @crxjs/vite-plugin)
├── vite.config.ts
├── src/
│   ├── popup/                React popup — Profile/Targets/Settings/History tabs
│   ├── content/              LinkedIn injector — vanilla TS for tiny bundle
│   ├── background/           MV3 service worker — Claude API + storage proxy
│   ├── lib/
│   │   ├── claude.ts         Claude API wrapper (no SDK — direct fetch)
│   │   ├── storage.ts        Typed chrome.storage.local
│   │   └── linkedin.ts       Selectors + form walker
│   └── shared/types.ts       Cross-context type definitions
└── icons/                    16 / 48 / 128 px PNGs
```

## License

MIT
