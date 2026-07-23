/**
 * The guarded-action confirm dialog — DESIGN §6.9, §5.5 rules 2 and 3, INV-06.
 *
 * §6.9, verbatim: "**Confirm dialog** (`data-testid="confirm-dialog"`): states the action, lists
 * **every** target with its size, states that a restore point will be written first and where,
 * and requires either a plain confirm or the exact typed phrase (§5.5 rule 3). **Cancel is the
 * default focus.**"
 *
 * ⚠️ Four rules this component exists to make true, all of them testable:
 *
 *   1. **Every** target is listed, with its size. Not "12 files" — the twelve paths. The list is
 *      the thing the `confirmToken` is bound to (INV-06), so what the user reads and what the
 *      main process will act on are the same list or the execute is refused.
 *   2. **Cancel holds the initial focus**, and cancelling is the Enter-key default. A destructive
 *      action must never be one keystroke away from a dialog the user did not read.
 *   3. The confirm control is **disabled until the typed phrase matches exactly** when one is
 *      required. No trimming, no case folding, no "close enough".
 *   4. The restore point is named **before** the action, in the dialog, because "a restore point
 *      will be written first, and here is where" is the promise the whole trust story rests on
 *      (§5.5 rule 1, INV-07).
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import type { ActionPreview } from '../../shared/ipc-contract';
import { cx } from '../lib/cx';
import { formatBytes } from '../lib/format';

export interface ConfirmDialogProps {
  preview: ActionPreview;
  /** A sentence in the user's own words, e.g. §6.9's archive copy. Rendered above the list. */
  headline: string;
  /** Where the restore point goes, in words. §5.5 rule 1's promise, stated before the act. */
  restorePointNote: string;
  /** The label on the confirming control, e.g. "Delete 2 folders". */
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  preview,
  headline,
  restorePointNote,
  confirmLabel,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps): JSX.Element {
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);

  // §6.9 — "Cancel is the default focus."
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // ⚠️ Exact match. No `.trim()`, no `.toLowerCase()`: §5.5 rule 3 says "the exact
  // `typedConfirmPhrase`", and a forgiving comparison is a confirmation that confirms less.
  const phraseMatches =
    !preview.requiresTypedConfirm ||
    (preview.typedConfirmPhrase !== null && typed === preview.typedConfirmPhrase);
  const canConfirm = phraseMatches && !busy;

  return (
    <div
      data-testid="confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={headline}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-app/80 p-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-card border border-border bg-bg-surface p-6 shadow-card">
        <h2 className="text-h3 text-text-primary">{headline}</h2>

        {/* ⚠️ EVERY target, with its size (§6.9). Never a count, never a summary. */}
        <div
          data-testid="confirm-targets"
          className="flex flex-col gap-1 rounded-control border border-border bg-bg-surface-2 p-3"
        >
          {preview.targets.length === 0 ? (
            <p className="text-small text-text-muted">Nothing matches any more — nothing to do.</p>
          ) : (
            preview.targets.map((target) => (
              <p
                key={target.relPath}
                data-testid="confirm-target"
                className="flex items-baseline justify-between gap-4 font-mono text-micro text-text-primary"
              >
                <span className="break-all">{target.relPath}</span>
                <span className="shrink-0 text-text-muted">
                  {target.kind === 'directory' ? 'folder · ' : ''}
                  {formatBytes(target.sizeBytes)}
                </span>
              </p>
            ))
          )}
        </div>
        <p className="text-small text-text-muted">
          {preview.targets.length} item{preview.targets.length === 1 ? '' : 's'} ·{' '}
          {formatBytes(preview.totalBytes)} in total
        </p>

        {preview.warnings.map((warning) => (
          <p key={warning} data-testid="confirm-warning" className="text-small text-warn">
            {warning}
          </p>
        ))}

        {/* §5.5 rule 1 / INV-07 — stated BEFORE the act, not reported after it. */}
        <p data-testid="confirm-restore-note" className="text-small text-text-muted">
          {restorePointNote}
        </p>

        {preview.requiresTypedConfirm && preview.typedConfirmPhrase !== null && (
          <label className="flex flex-col gap-2 text-small text-text-primary">
            <span>
              Type <code className="font-mono text-text-primary">{preview.typedConfirmPhrase}</code>{' '}
              to continue.
            </span>
            <input
              data-testid="confirm-phrase"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
              className="rounded-control border border-border bg-bg-surface-2 px-3 py-2 font-mono text-small text-text-primary"
            />
          </label>
        )}

        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            data-testid="confirm-cancel"
            type="button"
            onClick={onCancel}
            className="rounded-control border border-border px-4 py-2 text-small text-text-primary"
          >
            Cancel
          </button>
          <button
            data-testid="confirm-accept"
            type="button"
            disabled={!canConfirm}
            onClick={onConfirm}
            className={cx(
              'rounded-control border px-4 py-2 text-small',
              canConfirm
                ? 'border-danger text-text-primary'
                : 'border-border text-text-faint opacity-60',
            )}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
