import { createPortal } from "react-dom";
import { useStripSlot } from "../tabs/strip-slot";
import { useTabContext } from "../tabs/tab-context";
import { PendingApprovals } from "./RunControls";

/**
 * The pending approvals of this view's repository, in the tab strip (DESIGN §13.4): only the active tab's view renders
 * them there. Outside the tabbed app (tests) they render inline.
 */
export function StripApprovals() {
  const tab = useTabContext();
  const slot = useStripSlot((s) => s.el);
  if (!tab) return <PendingApprovals />;
  return tab.active && slot ? createPortal(<PendingApprovals />, slot) : null;
}
