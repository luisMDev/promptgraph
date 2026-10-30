import type { DiffFile, DiffResponse } from "@promptgraph/shared";
import { html as diffHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import type { ColorSchemeType } from "diff2html/lib/types";
import { useMemo, useRef, useState } from "react";

type Layout = "line-by-line" | "side-by-side";

const STATUS_MARK: Record<DiffFile["status"], { mark: string; className: string }> = {
  added: { mark: "A", className: "text-green-400" },
  modified: { mark: "M", className: "text-amber-300" },
  deleted: { mark: "D", className: "text-red-400" },
  renamed: { mark: "R", className: "text-sky-300" },
  copied: { mark: "C", className: "text-sky-300" },
  other: { mark: "?", className: "text-zinc-400" },
};

/** Lane diff (§10): file list (click to jump) + diff2html patch, unified or side by side. Loaded lazily with the dialog. */
export function DiffView({ diff }: { diff: DiffResponse }) {
  const [layout, setLayout] = useState<Layout>("line-by-line");
  const bodyRef = useRef<HTMLDivElement>(null);
  const markup = useMemo(
    () => (diff.patch ? diffHtml(diff.patch, { drawFileList: false, matching: "lines", outputFormat: layout, colorScheme: "dark" as ColorSchemeType }) : ""),
    [diff.patch, layout],
  );
  const additions = diff.files.reduce((n, f) => n + f.additions, 0);
  const deletions = diff.files.reduce((n, f) => n + f.deletions, 0);

  const jumpTo = (file: DiffFile) => {
    const wrappers = bodyRef.current?.querySelectorAll<HTMLElement>(".d2h-file-wrapper") ?? [];
    const target = [...wrappers].find((w) => w.querySelector(".d2h-file-name")?.textContent?.includes(file.path));
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <h3 className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
          Changes since base{" "}
          <span className="font-mono normal-case" title={`Merge base with the base branch: ${diff.base}`}>
            {diff.base.slice(0, 8)}
          </span>
        </h3>
        <span className="text-xs text-zinc-500">
          {diff.files.length} file{diff.files.length === 1 ? "" : "s"} · <span className="text-green-400">+{additions}</span>{" "}
          <span className="text-red-400">−{deletions}</span>
        </span>
        {diff.patch && (
          <div className="ml-auto flex rounded-md ring-1 ring-zinc-700" role="group" aria-label="Diff layout">
            <LayoutButton active={layout === "line-by-line"} onClick={() => setLayout("line-by-line")}>
              Unified
            </LayoutButton>
            <LayoutButton active={layout === "side-by-side"} onClick={() => setLayout("side-by-side")}>
              Side by side
            </LayoutButton>
          </div>
        )}
      </div>
      {diff.truncated && <p className="text-xs text-amber-300">The diff is too large and was truncated.</p>}
      {diff.files.length === 0 ? (
        <p className="text-xs text-zinc-500">No changes in this lane.</p>
      ) : (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 py-1 text-xs">
          {diff.files.map((f) => (
            <li key={f.path}>
              <button type="button" onClick={() => jumpTo(f)} className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-zinc-800/70">
                <span className={`w-3 font-mono font-semibold ${STATUS_MARK[f.status].className}`} title={f.status}>
                  {STATUS_MARK[f.status].mark}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-200">
                  {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                </span>
                {f.binary ? (
                  <span className="text-zinc-500">binary</span>
                ) : (
                  <span className="font-mono tabular-nums">
                    <span className="text-green-400">+{f.additions}</span> <span className="text-red-400">−{f.deletions}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {markup && <div ref={bodyRef} className="pg-diff overflow-auto rounded-md" dangerouslySetInnerHTML={{ __html: markup }} />}
    </div>
  );
}

function LayoutButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`px-2.5 py-1 text-xs first:rounded-l-md last:rounded-r-md ${active ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
    >
      {children}
    </button>
  );
}
