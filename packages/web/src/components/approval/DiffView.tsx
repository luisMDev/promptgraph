import type { DiffFile, DiffResponse } from "@promptgraph/shared";
import { html as diffHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import type { ColorSchemeType } from "diff2html/lib/types";
import { useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "../common/ui";

type Layout = "line-by-line" | "side-by-side";

const STATUS_MARK: Record<DiffFile["status"], { mark: string; className: string }> = {
  added: { mark: "A", className: "text-green-600" },
  modified: { mark: "M", className: "text-amber-700" },
  deleted: { mark: "D", className: "text-red-600" },
  renamed: { mark: "R", className: "text-sky-700" },
  copied: { mark: "C", className: "text-sky-700" },
  other: { mark: "?", className: "text-muted-foreground" },
};

/**
 * Lane diff (§10) or one node's changes (§9.7): file list (click to jump) + diff2html patch, unified or
 * side by side. Loaded lazily with the dialogs.
 */
export function DiffView({ diff, title, emptyText = "No changes in this lane." }: { diff: DiffResponse; title?: string; emptyText?: string }) {
  const [layout, setLayout] = useState<Layout>("line-by-line");
  const bodyRef = useRef<HTMLDivElement>(null);
  const markup = useMemo(
    () => (diff.patch ? diffHtml(diff.patch, { drawFileList: false, matching: "lines", outputFormat: layout, colorScheme: "light" as ColorSchemeType }) : ""),
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
        <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {title ?? (
            <>
              Changes since base{" "}
              <span className="font-mono normal-case" title={`Merge base with the base branch: ${diff.base}`}>
                {diff.base.slice(0, 8)}
              </span>
            </>
          )}
        </h3>
        <span className="text-xs text-muted-foreground">
          {diff.files.length} file{diff.files.length === 1 ? "" : "s"} · <span className="text-green-600">+{additions}</span>{" "}
          <span className="text-red-600">−{deletions}</span>
        </span>
        {diff.patch && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            className="ml-auto"
            aria-label="Diff layout"
            value={layout}
            onValueChange={(v) => v && setLayout(v as Layout)}
          >
            <ToggleGroupItem value="line-by-line" className="text-xs">
              Unified
            </ToggleGroupItem>
            <ToggleGroupItem value="side-by-side" className="text-xs">
              Side by side
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      {diff.truncated && (
        <Alert role="status" className="border-amber-500/30">
          <AlertDescription className="text-xs text-amber-700">The diff is too large and was truncated.</AlertDescription>
        </Alert>
      )}
      {diff.files.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="max-h-40 overflow-y-auto rounded-md border bg-background py-1 text-xs">
          {diff.files.map((f) => (
            <li key={f.path}>
              <Button variant="ghost" size="xs" onClick={() => jumpTo(f)} className="w-full justify-start gap-2 rounded-none px-3 text-left font-normal">
                <span className={`w-3 font-mono font-semibold ${STATUS_MARK[f.status].className}`} title={f.status}>
                  {STATUS_MARK[f.status].mark}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
                  {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                </span>
                {f.binary ? (
                  <span className="text-muted-foreground">binary</span>
                ) : (
                  <span className="font-mono tabular-nums">
                    <span className="text-green-600">+{f.additions}</span> <span className="text-red-600">−{f.deletions}</span>
                  </span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {markup && <div ref={bodyRef} className="pg-diff overflow-auto rounded-md" dangerouslySetInnerHTML={{ __html: markup }} />}
    </div>
  );
}
