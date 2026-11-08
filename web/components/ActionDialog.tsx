"use client";

import { useId, useState } from "react";
import { Modal } from "./Modal";
import { toApiError, type ApiError } from "@/lib/api";
import { cx } from "@/lib/cx";

export type ReasonMode = "required" | "optional" | "none";

export function ActionDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  danger = false,
  reason,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  reason: ReasonMode;
  onSubmit: (reason: string) => Promise<void>;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <DialogForm
        onClose={onClose}
        description={description}
        confirmLabel={confirmLabel}
        danger={danger}
        reason={reason}
        onSubmit={onSubmit}
      />
    </Modal>
  );
}

function DialogForm({
  onClose,
  description,
  confirmLabel,
  danger,
  reason,
  onSubmit,
}: Omit<Parameters<typeof ActionDialog>[0], "open" | "title">) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const fieldId = useId();
  const errId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (reason === "required" && !value) {
      setLocalError("Enter a reason. It is saved in the timeline.");
      return;
    }
    setLocalError(null);
    setApiError(null);
    setBusy(true);
    try {
      await onSubmit(value);
      onClose();
    } catch (err) {
      setApiError(toApiError(err));
      setBusy(false);
    }
  };

  const fieldError = localError;
  return (
    <form onSubmit={submit} noValidate className="mt-2">
      <p className="text-sm text-slate-700">{description}</p>

      {reason !== "none" ? (
        <div className="mt-4">
          <label htmlFor={fieldId} className="block text-sm font-medium">
            {reason === "required" ? "Reason (required)" : "Reason (optional)"}
          </label>
          <textarea
            id={fieldId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? errId : undefined}
            className={cx(
              "mt-1 w-full rounded border bg-white px-2 py-1.5 text-sm",
              fieldError ? "border-red-700" : "border-slate-400",
            )}
          />
          {fieldError ? (
            <p id={errId} className="mt-1 text-sm font-medium text-red-800">
              {fieldError}
            </p>
          ) : null}
        </div>
      ) : null}

      {apiError ? (
        <div role="alert" className="mt-4 rounded border border-red-700 bg-red-50 p-3 text-sm text-red-900">
          <p className="font-semibold">{apiError.detail}</p>
          <p className="mt-0.5 text-xs">
            Error code: <code>{apiError.code}</code>
            {apiError.status ? ` (HTTP ${apiError.status})` : ""}
          </p>
        </div>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-slate-400 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className={cx(
            "rounded px-3 py-2 text-sm font-semibold text-white disabled:opacity-60",
            danger ? "bg-red-700 hover:bg-red-800" : "bg-slate-900 hover:bg-slate-700",
          )}
        >
          {busy ? "Working..." : confirmLabel}
        </button>
      </div>
    </form>
  );
}
