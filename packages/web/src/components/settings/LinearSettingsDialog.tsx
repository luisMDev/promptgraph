import { LINEAR_ERROR } from "@promptgraph/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { ApiRequestError, errorMessage } from "../../api/rest";
import { useLinearStore } from "../../store/linear-store";
import { Icons } from "../common/icons";
import { Button, Field, Modal } from "../common/ui";

/** Where Linear creates personal API keys. */
export const LINEAR_KEYS_URL = "https://linear.app/settings/account/security";

const STATUS_ERRORS: Record<string, string> = {
  [LINEAR_ERROR.keyInvalid]: "Linear rejects the saved key. Disconnect and add a new one.",
  [LINEAR_ERROR.unavailable]: "Linear could not be reached. Issue search will retry.",
};

/** Message for a failed connect: Linear's answer, without ever echoing the key. */
export function connectErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.body.code === LINEAR_ERROR.keyInvalid) return "Linear rejected this key. Check that it was copied whole.";
    if (err.body.code === LINEAR_ERROR.unavailable) return `Linear could not be reached: ${err.body.error}`;
  }
  return errorMessage(err);
}

/**
 * Settings → Linear (DESIGN §24): connect a personal API key (checked with Linear, then saved by the daemon in
 * `~/.promptgraph/linear-key`; the browser never gets it back) or disconnect. Once connected, the new-graph dialog
 * can link a graph to an issue.
 */
export function LinearSettingsDialog({ onClose }: { onClose: () => void }) {
  const status = useLinearStore((s) => s.status);
  const loading = useLinearStore((s) => s.loading);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void useLinearStore.getState().load(true);
  }, []);

  const connect = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await useLinearStore.getState().connect(key);
      setKey("");
    } catch (err) {
      setError(connectErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await useLinearStore.getState().disconnect();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected === true;
  return (
    <Modal
      title="Linear"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {connected ? (
            <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || !key.trim()} onClick={() => void connect()}>
              {busy ? "Checking…" : "Connect"}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-xs leading-snug text-muted-foreground">
          Link new graphs to Linear issues: the graph takes the issue&apos;s name and branch, and its pull requests name the issue.
        </p>
        {!status && loading && <p className="text-xs text-muted-foreground">Checking the connection…</p>}
        {connected ? (
          <div className="space-y-1 rounded-md border p-3" aria-label="Linear connection">
            <div className="flex items-center gap-2 font-medium">
              <Icons.check className="text-emerald-600" />
              {status.workspace ? `Connected to ${status.workspace.name}` : "API key saved"}
            </div>
            {status.viewer && (
              <div className="text-xs text-muted-foreground">
                As {status.viewer.name}
                {status.viewer.email ? ` (${status.viewer.email})` : ""}
              </div>
            )}
            {status.error && (
              <p role="alert" className="text-xs text-amber-700">
                {STATUS_ERRORS[status.error] ?? status.error}
              </p>
            )}
          </div>
        ) : (
          <form className="space-y-2" onSubmit={(e) => void connect(e)}>
            <Field
              label="Personal API key"
              hint={
                <>
                  Create one in{" "}
                  <a href={LINEAR_KEYS_URL} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                    Linear → Settings → Security &amp; access
                  </a>
                  . Read access is enough to link issues; Linear update steps also need write access. The key stays in ~/.promptgraph/linear-key (readable by you only) and is never
                  shown again or given to Claude.
                </>
              }
            >
              <Input autoFocus type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="lin_api_…" />
            </Field>
          </form>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
