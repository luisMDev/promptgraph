import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject } from "react";
import { Icons } from "./icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-500 disabled:bg-blue-900 disabled:text-blue-300/60",
  secondary: "bg-zinc-800 text-zinc-100 ring-1 ring-inset ring-zinc-700 hover:bg-zinc-700 disabled:text-zinc-500",
  ghost: "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-600",
  danger: "bg-red-600/90 text-white hover:bg-red-500 disabled:bg-red-950 disabled:text-red-300/50",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  const sizing = size === "sm" ? "h-7 px-2 text-xs gap-1" : "h-8 px-3 text-sm gap-1.5";
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed ${sizing} ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

/** Calls `onOutside` on mousedown outside `ref` and on Escape while `active`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void): void {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cb.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, active]);
}

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
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-[2px]">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl ${wide ? "max-w-5xl" : "max-w-md"}`}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="Close">
            <Icons.x />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-snug text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60";

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
    <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
      <input
        type="checkbox"
        className="size-3.5 accent-blue-500"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-3 border-b border-zinc-800 px-4 py-4 last:border-b-0">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">{title}</h3>
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
      <span className="text-zinc-500">{label}</span>
      <span className="min-w-0 break-words text-zinc-200">{children}</span>
    </div>
  );
}
