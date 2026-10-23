// Indeed content entry — runs in every indeed.com frame (all_frames).
//
// Dispatch by surface:
//   • The Indeed Apply form (its own smartapply/apply.indeed.com tab, or a
//     cross-origin iframe on the SRP) → run the fill-and-submit helper.
//   • The main SRP / viewjob top frame → run the autopilot engine + dock.
//   • Any other sub-frame (ads, trackers) → do nothing.

import { IndeedDriver } from "@/platforms/indeed/driver";
import { initContent } from "@/content/dock";
import { runIndeedApplyHelper, looksLikeIndeedApply } from "@/lib/indeed-apply";

const inFrame = window.top !== window;
const applyHost = /(^|\.)(smartapply|apply)\.indeed\.com$/.test(location.host) || /\.apply\.indeed\.com$/.test(location.host);
const applySurface = applyHost || (inFrame && looksLikeIndeedApply());

if (applySurface) {
  const start = () => runIndeedApplyHelper().catch((e) => console.error("[Autopilot] indeed apply helper", e));
  start();
  setTimeout(start, 1500);
  setTimeout(start, 4000);
} else if (!inFrame) {
  initContent(new IndeedDriver());
}
