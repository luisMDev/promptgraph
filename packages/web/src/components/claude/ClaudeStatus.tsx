import { createPortal } from "react-dom";
import { useTabContext } from "../tabs/tab-context";
import { BillingBadge } from "./BillingBadge";
import { ClaudeSetupButton } from "./ClaudeSetupWizard";

/**
 * The start of a repository tab's bottom bar (DESIGN §13.4): how Claude is billed and its usage (§23.4) and the Claude
 * Code setup wizard (§19.5). Rendered inline outside the tabbed app (tests).
 */
export function ClaudeStatus() {
  const tab = useTabContext();
  const items = (
    <div className="flex items-center gap-0.5 [&_button]:h-7 [&_button]:text-xs">
      <BillingBadge />
      <ClaudeSetupButton />
    </div>
  );
  if (!tab) return items;
  return tab.bottomBarStart ? createPortal(items, tab.bottomBarStart) : null;
}
