import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Job Autopilot — AI auto-apply",
  short_name: "Job Autopilot",
  description:
    "Drop your resume once. Claude tailors it per job and the autopilot searches, fills and (optionally) submits applications on LinkedIn.",
  version: "0.3.0",
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
      js: ["src/content/linkedin.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["https://www.naukri.com/*"],
      js: ["src/content/naukri.ts"],
      run_at: "document_idle",
    },
    {
      // all_frames so the helper reaches the cross-origin Indeed Apply iframe.
      matches: ["https://*.indeed.com/*"],
      js: ["src/content/indeed.ts"],
      run_at: "document_idle",
      all_frames: true,
    },
  ],
  permissions: ["storage", "activeTab", "scripting", "tabs"],
  host_permissions: [
    "https://www.linkedin.com/*",
    "https://*.naukri.com/*",
    "https://*.indeed.com/*",
    "https://api.anthropic.com/*",
  ],
  web_accessible_resources: [
    {
      resources: ["icons/*", "assets/*"],
      matches: ["https://www.linkedin.com/*", "https://*.naukri.com/*", "https://*.indeed.com/*"],
    },
  ],
});
