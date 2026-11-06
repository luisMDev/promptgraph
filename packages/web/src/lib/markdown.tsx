import type { ReactNode } from "react";

/**
 * A small, safe Markdown renderer for chat replies: fenced code, headings, lists, quotes, rules and paragraphs, with
 * inline code, bold, italic and links. It builds React elements only (no HTML strings), so model output can never
 * inject markup; links are kept only for http(s) and mailto URLs.
 */

export type MdBlock =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "paragraph"; text: string };

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Splits Markdown into blocks. Pure; an unclosed fence runs to the end (as while streaming). */
export function parseBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[j]!)) body.push(lines[j++]!);
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      i = j;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flush();
      const isOrdered = !!ordered;
      const items: string[] = [bullet ? bullet[1]! : ordered![2]!];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j]!;
        const m = isOrdered ? ORDERED.exec(next) : BULLET.exec(next);
        if (m) items.push(isOrdered ? m[2]! : m[1]!);
        // An indented continuation line belongs to the previous item.
        else if (next.trim() && /^\s{2,}/.test(next)) items[items.length - 1] += `\n${next.trim()}`;
        else break;
      }
      blocks.push({ kind: "list", ordered: isOrdered, start: isOrdered ? Number(ordered![1]) : 1, items });
      i = j - 1;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const body = [quote[1]!];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const m = QUOTE.exec(lines[j]!);
        if (!m) break;
        body.push(m[1]!);
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      i = j - 1;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "link"; href: string; children: MdInline[] };

/** Only these URL schemes become links; anything else (javascript:, data:, …) stays plain text. */
export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/;

/** Tokenises inline Markdown. Pure. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: "text", text: rest.slice(0, m.index) });
    if (m[1]) out.push({ kind: "code", text: m[2]!.replace(/^ (.*) $/, "$1") });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ kind: "strong", children: parseInline(m[3] ?? m[4]!) });
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ kind: "em", children: parseInline(m[5] ?? m[6]!) });
    else {
      const href = safeHref(m[8]!);
      if (href) out.push({ kind: "link", href, children: parseInline(m[7]!) });
      else out.push({ kind: "text", text: m[0] });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function renderInline(nodes: MdInline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case "text":
        return withBreaks(n.text, i);
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
            {n.text}
          </code>
        );
      case "strong":
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer noopener" className="text-blue-600 underline-offset-2 hover:underline">
            {renderInline(n.children)}
          </a>
        );
    }
  });
}

function withBreaks(text: string, key: number): ReactNode {
  const parts = text.split("\n");
  if (parts.length === 1) return text;
  return (
    <span key={key}>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {p}
        </span>
      ))}
    </span>
  );
}

function Inline({ text }: { text: string }) {
  return <>{renderInline(parseInline(text))}</>;
}

const HEADING_CLASS = ["text-base font-semibold", "text-[15px] font-semibold", "text-sm font-semibold"];

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`space-y-2 text-sm leading-relaxed break-words ${className ?? ""}`}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-snug" data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case "heading":
            return (
              <p key={i} role="heading" aria-level={b.level} className={HEADING_CLASS[Math.min(b.level, 3) - 1]}>
                <Inline text={b.text} />
              </p>
            );
          case "list": {
            const items = b.items.map((it, j) => (
              <li key={j}>
                <Inline text={it} />
              </li>
            ));
            return b.ordered ? (
              <ol key={i} start={b.start} className="list-decimal space-y-0.5 pl-5">
                {items}
              </ol>
            ) : (
              <ul key={i} className="list-disc space-y-0.5 pl-5">
                {items}
              </ul>
            );
          }
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 pl-3 text-muted-foreground">
                <Inline text={b.text} />
              </blockquote>
            );
          case "rule":
            return <hr key={i} className="border-border" />;
          case "paragraph":
            return (
              <p key={i}>
                <Inline text={b.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
