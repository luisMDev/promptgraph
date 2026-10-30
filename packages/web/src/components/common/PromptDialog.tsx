import { useState, type FormEvent } from "react";
import { Button, Field, Modal, inputClass } from "./ui";

/** Small modal asking for one line of text (create / rename graph). */
export function PromptDialog({
  title,
  label,
  initial = "",
  submitLabel,
  hint,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  hint?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const valid = value.trim().length > 0;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) return;
    onSubmit(value.trim());
    onClose();
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => submit()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label={label} hint={hint?.(value) ?? undefined}>
          <input autoFocus className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-zinc-300">{message}</p>
    </Modal>
  );
}
