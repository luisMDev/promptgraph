import type { ApprovalInfoResponse, DiffResponse } from "@promptgraph/shared";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/rest";
import { useAppStore } from "../../store/app-store";
import { useRunStore } from "../../store/run-store";
import { useUiStore } from "../../store/ui-store";
import { TextArea } from "../common/fields";
import { Button, Field, Modal, inputClass } from "../common/ui";
import { DiffView } from "./DiffView";

/**
 * Approval gate (§10) for approval and pr nodes: message, predecessor outputs, lane diff vs base, editable
 * PR title/body, Approve / Reject with an optional comment. Opened from a violet node or the header's
 * pending list (any run of the repo). Loaded lazily (with diff2html) by App.
 */
export function ApprovalDialog({ nodeRunId }: { nodeRunId: string }) {
  const close = () => useUiStore.getState().openApproval(null);
  const [info, setInfo] = useState<ApprovalInfoResponse | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const context = useGateContext(info);

  useEffect(() => {
    let cancelled = false;
    api
      .approvalInfo(nodeRunId)
      .then((res) => {
        if (cancelled) return;
        setInfo(res);
        setTitle(res.pr?.title ?? "");
        setBody(res.pr?.body ?? "");
        if (!res.showDiff) return;
        api.diff(nodeRunId).then(
          (d) => !cancelled && setDiff(d),
          (err: unknown) => !cancelled && setDiffError(errorMessage(err)),
        );
      })
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [nodeRunId]);

  const submit = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { nodeRun } = await api.submitApproval(nodeRunId, {
        approved,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(info?.pr ? { title, body } : {}),
      });
      useRunStore.getState().applyNodeUpdate(nodeRun);
      void useAppStore.getState().refreshPending();
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pending = info?.nodeRun.status === "waiting_approval";
  const isPr = !!info?.pr;
  const outputs = info?.predecessorOutputs.filter((p) => p.text.trim()) ?? [];

  return (
    <Modal
      wide
      title={
        <span className="flex items-baseline gap-2">
          <span>{isPr ? "Approve pull request" : "Approval required"}</span>
          {context && <span className="truncate text-xs font-normal text-zinc-500">{context}</span>}
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
          <Button variant="primary" disabled={!pending || busy} onClick={() => void submit(true)}>
            {isPr ? "Approve & push" : "Approve"}
          </Button>
        </>
      }
    >
      {error && <p className="mb-3 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
      {!info && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {info && (
        <div className="space-y-4">
          {!pending && <p className="rounded-md bg-zinc-800 px-3 py-2 text-xs text-zinc-300">This gate is no longer waiting for approval.</p>}
          {info.message && <p className="rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-100">{info.message}</p>}
          {info.pr && (
            <div className="space-y-3 rounded-lg border border-zinc-800 p-3">
              <p className="text-xs text-zinc-500">
                Pushes the lane branch and opens a {info.pr.draft ? "draft " : ""}PR into <span className="font-mono text-zinc-300">{info.pr.base}</span>
              </p>
              <Field label="Title" hint="Empty keeps the proposed title.">
                <input className={inputClass} value={title} disabled={!pending} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label="Body">
                <TextArea value={body} rows={6} disabled={!pending} onChange={setBody} />
              </Field>
            </div>
          )}
          {outputs.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Previous steps</h3>
              {outputs.map((p) => (
                <details key={p.nodeId} open={outputs.length === 1} className="rounded-md border border-zinc-800 bg-zinc-950">
                  <summary className="cursor-pointer px-3 py-2 text-sm text-zinc-300">{p.label}</summary>
                  <pre className="max-h-64 overflow-auto px-3 pb-3 text-xs whitespace-pre-wrap text-zinc-400">{p.text}</pre>
                </details>
              ))}
            </div>
          )}
          {info.showDiff &&
            (diff ? (
              <DiffView diff={diff} />
            ) : (
              <p className={`text-xs ${diffError ? "text-red-300" : "text-zinc-500"}`}>{diffError ? `Could not load the diff: ${diffError}` : "Loading diff…"}</p>
            ))}
          <Field label={pending ? "Comment (optional, passed on with the decision)" : "Comment"}>
            <TextArea value={comment} rows={2} disabled={!pending} onChange={setComment} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/** "Node label · graph · run #id" from the shown run or the pending list's run info. */
function useGateContext(info: ApprovalInfoResponse | null): string | null {
  const runId = info?.nodeRun.runId;
  const nodeId = info?.nodeRun.nodeId;
  const fromDetail = useRunStore((s) => (s.detail && s.detail.run.id === runId ? s.detail.run : null));
  const fromPending = useAppStore((s) => (runId ? s.pendingRuns[runId] : undefined));
  if (!info || !nodeId) return null;
  if (fromDetail) {
    const label = fromDetail.graphSnapshot.nodes.find((n) => n.id === nodeId)?.label || nodeId;
    return `${label} · ${fromDetail.graphName} · run #${fromDetail.shortId}`;
  }
  if (fromPending) return `${fromPending.nodeLabels[nodeId] ?? nodeId} · ${fromPending.graphName} · run #${fromPending.shortId}`;
  return null;
}
