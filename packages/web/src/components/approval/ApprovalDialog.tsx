import { nodeDisplayLabel, type ApprovalInfoResponse, type DiffResponse } from "@promptgraph/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, errorMessage } from "../../api/rest";
import { getRepoCache } from "../../store/repo-cache";
import { useRepo, useRun, useView } from "../../store/view/context";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Icons } from "../common/icons";
import { Button, Field, Modal } from "../common/ui";
import { DiffView } from "./DiffView";
import { decisionsOf, draftsOf, LinearUpdatesEditor, type LinearUpdateDraft } from "./LinearUpdatesEditor";

/**
 * Approval gate (§10) for approval, pr and linear nodes: message, predecessor outputs, lane diff vs base, editable
 * PR title/body or Linear updates (§24.5), Approve / Reject with an optional comment. Opened from a violet node or the header's
 * pending list (any run of the repo). Whether the gate still waits follows the live stores; approving a PR
 * sends the reviewed commit (diff.head), and a refused decision (409) reloads the gate. Loaded lazily
 * (with diff2html) by App.
 */
export function ApprovalDialog({ nodeRunId }: { nodeRunId: string }) {
  const view = useView();
  const close = () => view.ui.getState().openApproval(null);
  const [info, setInfo] = useState<ApprovalInfoResponse | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [drafts, setDrafts] = useState<LinearUpdateDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const context = useGateContext(info);
  const waiting = useStillWaiting(info);

  /** Loads the gate; `keepEdits` (a reload after a refused decision) keeps the edited title/body. */
  const load = useCallback(
    (isCancelled: () => boolean, keepEdits: boolean) =>
      view.api
        .approvalInfo(nodeRunId)
        .then((res) => {
          if (isCancelled()) return;
          setInfo(res);
          if (!keepEdits) {
            setTitle(res.pr?.title ?? "");
            setBody(res.pr?.body ?? "");
            setDrafts(draftsOf(res.linear?.proposals ?? []));
          }
          if (!res.showDiff) return;
          setDiff(null);
          setDiffError(null);
          view.api.diff(nodeRunId).then(
            (d) => !isCancelled() && setDiff(d),
            (err: unknown) => !isCancelled() && setDiffError(errorMessage(err)),
          );
        })
        .catch((err: unknown) => !isCancelled() && setError(errorMessage(err))),
    [nodeRunId, view.api],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled, false);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const submit = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { nodeRun } = await view.api.submitApproval(nodeRunId, {
        approved,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(info?.pr ? { title, body, ...(diff ? { headSha: diff.head } : {}) } : {}),
        ...(info?.linear && approved ? { linearUpdates: decisionsOf(drafts) } : {}),
      });
      view.run.getState().applyNodeUpdate(nodeRun);
      void getRepoCache(view.repoId).getState().refreshPending();
      close();
    } catch (err) {
      setError(errorMessage(err));
      // The gate moved on, or the PR branch changed: show its current state.
      if (err instanceof ApiRequestError && err.status === 409) void load(() => false, true);
    } finally {
      setBusy(false);
    }
  };

  const pending = info?.nodeRun.status === "waiting_approval" && waiting;
  // Approving a PR pushes exactly the reviewed commit, so it needs the loaded diff.
  const isLinear = !!info?.linear;
  const canApprove = pending && (!info?.pr || !!diff) && (!isLinear || decisionsOf(drafts).length > 0);
  const isPr = !!info?.pr;
  const outputs = info?.predecessorOutputs.filter((p) => p.text.trim()) ?? [];

  return (
    <Modal
      wide
      title={
        <span className="flex items-baseline gap-2">
          <span>{isPr ? "Approve pull request" : isLinear ? "Approve Linear updates" : "Approval required"}</span>
          {context && <span className="truncate text-xs font-normal text-muted-foreground">{context}</span>}
        </span>
      }
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          <Button variant="danger" disabled={!pending || busy} onClick={() => void submit(false)}>
            Reject
          </Button>
          <Button variant="primary" disabled={!canApprove || busy} onClick={() => void submit(true)}>
            {isPr ? "Approve & push" : isLinear ? "Approve & update Linear" : "Approve"}
          </Button>
        </>
      }
    >
      {error && (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!info && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {info && (
        <div className="space-y-4">
          {!pending && (
            <Alert role="status">
              <AlertDescription className="text-xs">This gate is no longer waiting for approval.</AlertDescription>
            </Alert>
          )}
          {info.message && (
            <Alert role="status" className="border-violet-500/30 bg-violet-500/10">
              <AlertDescription className="whitespace-pre-wrap text-foreground">{info.message}</AlertDescription>
            </Alert>
          )}
          {info.pr && (
            <Card size="sm">
              <CardContent className="space-y-3">
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  Pushes the lane branch and opens a {info.pr.draft && <Badge variant="secondary">draft</Badge>} PR into
                  <Badge variant="outline" className="font-mono">
                    {info.pr.base}
                  </Badge>
                </p>
                <Field label="Title" hint="Empty keeps the proposed title.">
                  <Input value={title} disabled={!pending} onChange={(e) => setTitle(e.target.value)} />
                </Field>
                <Field label="Body">
                  <Textarea className="field-sizing-fixed min-h-0 resize-y leading-relaxed" value={body} rows={6} disabled={!pending} onChange={(e) => setBody(e.target.value)} />
                </Field>
              </CardContent>
            </Card>
          )}
          {info.linear && <LinearUpdatesEditor linear={info.linear} drafts={drafts} disabled={!pending} onChange={setDrafts} />}
          {outputs.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Previous steps</h3>
              {outputs.map((p) => (
                <Collapsible key={p.nodeId} defaultOpen={outputs.length === 1} className="group/output rounded-md border bg-background">
                  <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-3 py-2 text-left text-sm text-foreground/85 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                    <Icons.chevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-data-[state=open]/output:rotate-0" />
                    {p.label}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="max-h-64 overflow-auto px-3 pb-3 text-xs whitespace-pre-wrap text-muted-foreground">{p.text}</pre>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
          {info.showDiff &&
            (diff ? (
              <DiffView diff={diff} />
            ) : diffError ? (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">Could not load the diff: {diffError}</AlertDescription>
              </Alert>
            ) : (
              <p className="text-xs text-muted-foreground">Loading diff…</p>
            ))}
          <Field label={pending ? "Comment (optional, passed on with the decision)" : "Comment"}>
            <Textarea className="field-sizing-fixed min-h-0 resize-y leading-relaxed" value={comment} rows={2} disabled={!pending} onChange={(e) => setComment(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/**
 * Whether the gate still waits for approval, live: the shown run's node runs when it belongs to that run,
 * else the repo's pending list (both follow WS updates). True until `info` is loaded.
 */
function useStillWaiting(info: ApprovalInfoResponse | null): boolean {
  const id = info?.nodeRun.id;
  const runId = info?.nodeRun.runId;
  const fromDetail = useRun((s) => (s.detail && s.detail.run.id === runId ? s.detail.nodeRuns.find((n) => n.id === id)?.status : undefined));
  const inPending = useRepo((s) => s.pending.some((n) => n.id === id));
  if (!info) return true;
  return fromDetail ? fromDetail === "waiting_approval" : inPending;
}

/** "Node label · graph · run #id" from the shown run or the pending list's run info. */
function useGateContext(info: ApprovalInfoResponse | null): string | null {
  const runId = info?.nodeRun.runId;
  const nodeId = info?.nodeRun.nodeId;
  const fromDetail = useRun((s) => (s.detail && s.detail.run.id === runId ? s.detail.run : null));
  const fromPending = useRepo((s) => (runId ? s.pendingRuns[runId] : undefined));
  if (!info || !nodeId) return null;
  if (fromDetail) {
    const label = nodeDisplayLabel(fromDetail.graphSnapshot.nodes.find((n) => n.id === nodeId) ?? { id: nodeId });
    return `${label} · ${fromDetail.graphName} · run #${fromDetail.shortId}`;
  }
  if (fromPending) return `${fromPending.nodeLabels[nodeId] ?? nodeId} · ${fromPending.graphName} · run #${fromPending.shortId}`;
  return null;
}
