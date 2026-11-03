import { useState, type ComponentProps, type ReactNode } from "react";
import { Button as UiButton } from "@/components/ui/button";
import { Checkbox as UiCheckbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Icons } from "./icons";

/**
 * App-level wrappers over the shadcn/ui primitives in `@/components/ui`. Their props are the stable API the
 * rest of the app uses; the shadcn components underneath own styling and accessibility.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "xs" | "icon" | "icon-sm" | "icon-xs";

const VARIANTS = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  danger: "destructive",
} as const satisfies Record<Variant, ComponentProps<typeof UiButton>["variant"]>;

const SIZES = {
  sm: "sm",
  md: "default",
  xs: "xs",
  icon: "icon",
  "icon-sm": "icon-sm",
  "icon-xs": "icon-xs",
} as const satisfies Record<Size, ComponentProps<typeof UiButton>["size"]>;

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  ...props
}: Omit<ComponentProps<"button">, "type"> & { variant?: Variant; size?: Size; type?: "button" | "submit" | "reset" }) {
  return <UiButton type={type} variant={VARIANTS[variant]} size={SIZES[size]} {...props} />;
}

/**
 * Always-open modal dialog; unmount it (or call `onClose`) to close. Built on Radix Dialog via shadcn: focus
 * moves into the dialog and is trapped there, returns to the opener on close, the page behind is inert and
 * does not scroll, Escape / a click outside close only the topmost dialog, and the title names the dialog.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  // The dialog has no DialogTrigger (it is mounted open), so Radix has no trigger to refocus on close: remember
  // what had focus when it mounted and return focus there, whether it closes via Escape/outside/X or unmounts.
  const [opener] = useState(() => (typeof document === "undefined" ? null : focusReturnTarget(document.activeElement)));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (opener?.isConnected) opener.focus();
        }}
        className={cn("flex max-h-[calc(100%-3rem)] flex-col gap-0 overflow-hidden p-0", wide ? "sm:max-w-5xl" : "sm:max-w-md")}
      >
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
          <DialogClose asChild>
            <UiButton variant="ghost" size="icon-sm" aria-label="Close">
              <Icons.x />
            </UiButton>
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <DialogFooter className="m-0 rounded-none px-4 py-3">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Element focus should return to when a Modal opened from `active` closes. A dialog opened from a menu item would
 * otherwise "return" to the item, which unmounts with the menu: use the menu's trigger instead.
 */
function focusReturnTarget(active: Element | null): HTMLElement | null {
  const menu = active?.closest<HTMLElement>("[role=menu]");
  if (menu?.id) {
    const trigger = [...document.querySelectorAll<HTMLElement>("[aria-controls]")].find((el) => el.getAttribute("aria-controls") === menu.id);
    if (trigger) return trigger;
  }
  return active instanceof HTMLElement ? active : null;
}

/** Label + control + optional hint. The control is nested in the label, so it is labelled implicitly. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    // Native <label>, not the Radix Label: Radix prevents text selection on mousedown, which would make hints and
    // read-only values inside a Field impossible to select or copy.
    <label className="flex flex-col gap-1 text-sm">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-snug text-muted-foreground/80">{hint}</span>}
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Label className="cursor-pointer font-normal text-foreground/85">
      <UiCheckbox checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </Label>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-3 border-b px-4 py-4 last:border-b-0">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function StatusDot({ className }: { className: string }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${className}`} />;
}

/** Key/value rows for read-only details. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground/90">{children}</span>
    </div>
  );
}
