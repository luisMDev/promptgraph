import type { ListDirsResponse } from "@promptgraph/shared";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { daemonApi, errorMessage } from "../../api/rest";
import { Icons } from "../common/icons";
import { Button, Modal } from "../common/ui";

/** Most suggestions shown under the path field. */
const MAX_SUGGESTIONS = 50;
/** Debounce of the directory listing while typing. */
const LIST_DELAY_MS = 120;

/**
 * Splits what the user typed into the directory to list and the name prefix to match in it:
 * `~/pro` → `~/` + `pro`, `/home/a/` → `/home/a/` + ``, `~` → `~/` + ``. Null for a path that is not
 * absolute nor `~`-prefixed (nothing to suggest).
 */
export function splitTypedPath(value: string): { dir: string; prefix: string } | null {
  if (value === "~") return { dir: "~/", prefix: "" };
  if (!value.startsWith("/") && !value.startsWith("~/")) return null;
  const slash = value.lastIndexOf("/");
  return { dir: value.slice(0, slash + 1), prefix: value.slice(slash + 1) };
}

/** `path` with the home directory shown as `~`. */
export function tildePath(path: string, home: string): string {
  if (home && home !== "/" && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * The repository path field of Home's "Add repository" (DESIGN §13.3): a combobox that suggests the
 * subdirectories of what is typed (`GET /api/fs/dirs`). ↑/↓ highlight, Tab or Enter on a highlighted
 * suggestion complete it, Escape closes the list; Enter without a highlighted suggestion submits the form.
 */
export function PathInput({
  value,
  onChange,
  disabled,
  inputClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Extra classes of the input (e.g. a borderless field inside a card). */
  inputClassName?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{ dir: string; hidden: boolean; res: ListDirsResponse | null } | null>(null);
  const [highlight, setHighlight] = useState(-1);

  const split = splitTypedPath(value);
  const hidden = split?.prefix.startsWith(".") ?? false;
  const wanted = split && open ? { dir: split.dir, hidden } : null;

  useEffect(() => {
    if (!wanted) return;
    if (listing && listing.dir === wanted.dir && listing.hidden === wanted.hidden) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      daemonApi.listDirs(wanted.dir, wanted.hidden).then(
        (res) => !cancelled && setListing({ ...wanted, res }),
        () => !cancelled && setListing({ ...wanted, res: null }),
      );
    }, LIST_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `listing` is read only to skip a refetch of the same directory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted?.dir, wanted?.hidden]);

  const current = wanted && listing?.dir === wanted.dir && listing.hidden === wanted.hidden ? listing.res : null;
  const prefix = split?.prefix.toLowerCase() ?? "";
  const suggestions = current ? current.entries.filter((e) => e.name.toLowerCase().startsWith(prefix)).slice(0, MAX_SUGGESTIONS) : [];
  const shown = open && suggestions.length > 0 && !(suggestions.length === 1 && suggestions[0]!.name === split?.prefix);

  useEffect(() => setHighlight(-1), [value]);

  const complete = (name: string) => {
    if (!split) return;
    onChange(`${split.dir}${name}/`);
    setHighlight(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!shown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      complete(suggestions[Math.max(highlight, 0)]!.name);
    } else if (e.key === "Enter" && highlight >= 0) {
      e.preventDefault();
      complete(suggestions[highlight]!.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Input
        role="combobox"
        aria-label="Repository path"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && highlight >= 0 ? `${listId}-${highlight}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="/home/you/project or ~/project"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className={cn("font-mono text-xs", inputClassName)}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Folder suggestions"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.path}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                complete(s.name);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`flex cursor-pointer items-center gap-2 px-2.5 py-1 font-mono text-xs ${i === highlight ? "bg-accent text-accent-foreground" : ""}`}
            >
              <Icons.folder className="shrink-0 text-muted-foreground" />
              <span className="truncate">{s.name}</span>
              {s.isGitRepo && <GitBadge />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GitBadge() {
  return <Badge className="ml-auto h-4 shrink-0 bg-emerald-500/15 px-1.5 font-sans text-[10px] font-normal text-emerald-700">git</Badge>;
}

/**
 * Folder browser of Home's "Add repository" (DESIGN §13.3), served by the daemon (`GET /api/fs/dirs`), so
 * it works the same in a browser and in the desktop shell. Starts at `initialPath` (home when empty or
 * unreadable); a click on a folder enters it; "Add this folder" hands the current folder to `onSelect`.
 */
export function FolderBrowser({ initialPath, onSelect, onClose }: { initialPath?: string; onSelect: (path: string) => void; onClose: () => void }) {
  const [data, setData] = useState<ListDirsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const seq = useRef(0);

  const load = (path: string | undefined, showHidden = hidden, fallbackHome = false) => {
    const n = ++seq.current;
    setLoading(true);
    daemonApi.listDirs(path, showHidden).then(
      (res) => {
        if (n !== seq.current) return;
        setData(res);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (n !== seq.current) return;
        setLoading(false);
        if (fallbackHome) return load(undefined, showHidden);
        setError(errorMessage(err));
      },
    );
  };

  useEffect(() => {
    load(initialPath?.trim() || undefined, false, Boolean(initialPath?.trim()));
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const crumbs = data ? breadcrumbs(data.path, data.home) : [];

  return (
    <Modal
      title="Choose a repository folder"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!data} onClick={() => data && onSelect(data.path)}>
            Add this folder
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Parent folder" disabled={!data?.parent} onClick={() => data?.parent && load(data.parent)}>
            <Icons.arrowUp />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Home folder" disabled={!data} onClick={() => load(undefined)}>
            <Icons.home />
          </Button>
          <nav aria-label="Current folder" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-xs">
            {crumbs.map((c, i) => (
              <span key={c.path} className="inline-flex items-center gap-0.5">
                {i > 0 && <Icons.chevronRight className="text-[10px] text-muted-foreground" />}
                {i === crumbs.length - 1 ? (
                  <span aria-current="location" className="px-1 font-medium text-foreground">
                    {c.label}
                  </span>
                ) : (
                  <button type="button" className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => load(c.path)}>
                    {c.label}
                  </button>
                )}
              </span>
            ))}
          </nav>
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked);
                if (data) load(data.path, e.target.checked);
              }}
            />
            Show hidden
          </label>
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
        {data?.isGitRepo && <p className="text-xs text-emerald-700">This folder is a git repository.</p>}

        <ul aria-label="Folders" aria-busy={loading} className="h-80 overflow-y-auto rounded-md border">
          {data && data.entries.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No subfolders.</li>}
          {!data && !error && <li className="px-3 py-2 text-xs text-muted-foreground">Loading…</li>}
          {data?.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-accent"
                onClick={() => load(e.path)}
                title={e.path}
              >
                <Icons.folder className="shrink-0 text-muted-foreground" />
                <span className="truncate">{e.name}</span>
                {e.isGitRepo && <GitBadge />}
              </button>
            </li>
          ))}
        </ul>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={data?.path}>
          {data ? tildePath(data.path, data.home) : ""}
        </p>
      </div>
    </Modal>
  );
}

/** Clickable segments of `path`; under the home directory it starts at `~`. */
export function breadcrumbs(path: string, home: string): { label: string; path: string }[] {
  const underHome = home && home !== "/" && (path === home || path.startsWith(`${home}/`));
  const base = underHome ? home : "/";
  const out = [{ label: underHome ? "~" : "/", path: base }];
  const rest = path.slice(base.length).split("/").filter(Boolean);
  let acc = base;
  for (const part of rest) {
    acc = acc.endsWith("/") ? `${acc}${part}` : `${acc}/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}
