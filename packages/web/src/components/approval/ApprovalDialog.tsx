import type { ApprovalInfoResponse, DiffResponse } from "@promptgraph/shared";
import { html as diffHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import type { ColorSchemeType } from "diff2html/lib/types";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../../api/rest";
import { useRunStore } from "../../store/run-store";
import { useUiStore } from "../../store/ui-store";
import { TextArea } from "../common/fields";
import { Button, Field, Modal, inputClass } from "../common/ui";

/** Approval gate (§10): message, lane diff, predecessor outputs, editable PR title/body, approve/reject. */
export function ApprovalDialog() {
  const nodeRunId = useUiStore((s) => s.approvalNodeRunId);
  if (!nodeRunId) return null;
  return <ApprovalDialogBody key={nodeRunId} nodeRunId={nodeRunId} />;
}

function ApprovalDialogBody({ nodeRunId }: { nodeRunId: string }) {
  const close = () => useUiStore.getState().openApproval(null);
  const [info, setInfo] = useState<ApprovalInfoResponse | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .approvalInfo(nodeRunId)
      .then(async (res) => {
        if (cancelled) return;
        setInfo(res);
        setTitle(res.pr?.title ?? "");
        setBody(res.pr?.body ?? "");
        if (res.showDiff) {
          const d = await api.diff(nodeRunId);
          if (!cancelled) setDiff(d);
        }
      })
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [nodeRunId]);

  const diffMarkup = useMemo(
    () =>
      diff?.patch
        ? diffHtml(diff.patch, { drawFileList: true, matching: "lines", outputFormat: "line-by-line", colorScheme: "dark" as ColorSchemeType })
        : null,
    [diff],
  );

  const submit = async (approved: boolean) => {
    setBusy(true);
    try {
      const { nodeRun } = await api.submitApproval(nodeRunId, {
        approved,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(info?.pr ? { title, body } : {}),
      });
      useRunStore.getState().applyNodeUpdate(nodeRun);
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pending = info?.nodeRun.status === "waiting_approval";

  return (
    <Modal
      wide
      title={info?.pr ? "Approve pull request" : "Approval required"}
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
            {info?.pr ? "Approve & push" : "Approve"}
          </Button>
        </>
      }
    >
      {error && <p className="mb-3 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
      {!info && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {info && (
        <div className="space-y-4">
          {!pending && <p className="rounded-md bg-zinc-800 px-3 py-2 text-xs text-zinc-300">This gate is no longer waiting for approval.</p>}
          {info.message && <p className="text-sm whitespace-pre-wrap text-zinc-200">{info.message}</p>}
          {info.pr && (
            <div className="space-y-3 rounded-lg border border-zinc-800 p-3">
              <p className="text-xs text-zinc-500">
                {info.pr.draft ? "Draft PR" : "PR"} into <span className="font-mono text-zinc-300">{info.pr.base}</span>
              </p>
              <Field label="Title">
                <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label="Body">
                <TextArea value={body} rows={6} onChange={setBody} />
              </Field>
            </div>
          )}
          {info.predecessorOutputs.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Previous steps</h3>
              {info.predecessorOutputs.map((p) => (
                <details key={p.nodeId} className="rounded-md border border-zinc-800 bg-zinc-950">
                  <summary className="cursor-pointer px-3 py-2 text-sm text-zinc-300">{p.label}</summary>
                  <pre className="max-h-64 overflow-auto px-3 pb-3 text-xs whitespace-pre-wrap text-zinc-400">{p.text}</pre>
                </details>
              ))}
            </div>
          )}
          {info.showDiff && (
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
                Changes {diff ? `· ${diff.files.length} files vs ${diff.base}` : ""}
              </h3>
              {!diff && <p className="text-xs text-zinc-500">Loading diff…</p>}
              {diff && !diff.patch && <p className="text-xs text-zinc-500">No changes.</p>}
              {diff?.truncated && <p className="text-xs text-amber-300">The diff is truncated.</p>}
              {diffMarkup && <div className="pg-diff overflow-auto rounded-md" dangerouslySetInnerHTML={{ __html: diffMarkup }} />}
            </div>
          )}
          <Field label="Comment (optional)">
            <TextArea value={comment} rows={2} onChange={setComment} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
