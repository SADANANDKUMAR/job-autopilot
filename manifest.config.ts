import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Job Autopilot — AI-tailored LinkedIn Easy Apply",
  short_name: "Job Autopilot",
  description:
    "Tailor your resume to each LinkedIn Easy Apply job with Claude AI, auto-fill the application form, and review-then-submit. TOS-safe — you always click Submit yourself.",
  version: "0.2.0",
  icons: {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Job Autopilot",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["https://www.linkedin.com/jobs/*"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  permissions: ["storage", "activeTab", "scripting"],
  host_permissions: [
    "https://www.linkedin.com/*",
    "https://api.anthropic.com/*",
  ],
  web_accessible_resources: [
    {
      resources: ["icons/*", "assets/*"],
      matches: ["https://www.linkedin.com/*"],
    },
  ],
});
