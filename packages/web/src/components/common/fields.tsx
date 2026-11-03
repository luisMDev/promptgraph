import { useState } from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Monospace modifier shared by code-like fields. */
const monoClass = "font-mono text-xs md:text-xs";
/** Textareas honour `rows` (shadcn's Textarea auto-sizes to its content by default). */
const textareaClass = "field-sizing-fixed min-h-0 resize-y";

/** Text input that maps "" to undefined (optional config fields). */
export function OptionalText({
  value,
  onChange,
  placeholder,
  mono,
  list,
  disabled,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  placeholder?: string;
  mono?: boolean;
  list?: string;
  disabled?: boolean;
}) {
  return (
    <Input
      className={cn(mono && monoClass)}
      value={value ?? ""}
      placeholder={placeholder}
      list={list}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
  mono,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <Textarea
      // leading-relaxed must come after the font-size classes, or cn drops it as a conflict.
      className={cn(textareaClass, mono && monoClass, "leading-relaxed")}
      rows={rows}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={!mono}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Number input; empty → undefined. */
export function OptionalNumber({
  value,
  onChange,
  placeholder,
  min,
  max,
  disabled,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <Input
      type="number"
      value={value ?? ""}
      min={min}
      max={max}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        const n = e.target.valueAsNumber;
        onChange(Number.isFinite(n) ? n : undefined);
      }}
    />
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <NativeSelect className="w-full" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <NativeSelectOption key={o.value} value={o.value}>
          {o.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/**
 * One item per line (e.g. allowedTools, KEY=VALUE env). Keeps its own text so blank lines survive while
 * typing; mount with a `key` per edited object to reset.
 */
export function LinesInput({
  value,
  onChange,
  placeholder,
  rows = 3,
  disabled,
}: {
  value: readonly string[] | undefined;
  onChange: (v: string[] | undefined) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => (value ?? []).join("\n"));
  return (
    <Textarea
      className={cn(textareaClass, monoClass)}
      rows={rows}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        const items = parseLines(e.target.value);
        onChange(items.length ? items : undefined);
      }}
    />
  );
}

export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** KEY=VALUE lines → record (lines without "=" are ignored). */
export function parseEnv(lines: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}
