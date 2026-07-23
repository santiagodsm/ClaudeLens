/**
 * §6.2 — "**Onboarding** is a state of the shell, not a ninth view: with `dirStatus = 'unset'`,
 * the sidebar and top bar render disabled and the content area shows the directory picker with
 * the validation rule stated ('must contain `projects/` and/or `history.jsonl`'). Choosing a
 * valid directory transitions to Overview and starts a full sync."
 *
 * ⚠️ The picker never touches the filesystem. `dir:pick` opens the native dialog in the main
 * process and returns a validated result; `settings:set { key: 'claudeDir' }` performs the
 * transition of §5.1. The renderer has no `node:fs` and no `node:path` (INV-16), which is why
 * it cannot check the rule itself and must not pretend to.
 */

import { useState } from 'react';
import type { JSX } from 'react';
import type { AppError, DirValidation } from '../../shared/ipc-contract';
import { invoke } from '../lib/ipc';
import { useAppStore } from '../store/app-store';
import { ErrorState } from '../components/ErrorState';
import { FolderIcon } from '../components/icons';
import { Spinner } from '../components/LoadingState';

/** §4.3 — the rule, stated in the UI verbatim as §6.2 requires. */
export const DIRECTORY_RULE = 'must contain projects/ and/or history.jsonl';

export function Onboarding(): JSX.Element {
  const runBootstrap = useAppStore((state) => state.runBootstrap);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [rejected, setRejected] = useState<DirValidation | null>(null);

  const pick = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setRejected(null);
    try {
      const picked = await invoke('dir:pick');
      if (!picked.ok) {
        setError(picked.error);
        return;
      }
      // §4.3 — cancellation is data, not an error. Nothing happens and nothing is said.
      if (picked.data.cancelled) return;
      if (picked.data.validation.status !== 'valid') {
        setRejected(picked.data.validation);
        return;
      }
      const applied = await invoke('settings:set', {
        key: 'claudeDir',
        value: picked.data.path,
      });
      if (!applied.ok) {
        setError(applied.error);
        return;
      }
      // §5.1 — the main process purges and starts a full sync; the renderer re-reads the world.
      await runBootstrap();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="onboarding"
      className="col-span-12 mx-auto flex max-w-2xl flex-col items-center gap-4 rounded-card border border-border bg-bg-surface p-12 text-center shadow-card"
    >
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-card text-h2 text-text-primary"
        style={{ background: 'var(--grad-violet-cyan)', boxShadow: 'var(--glow)' }}
      >
        <FolderIcon />
      </span>

      <h2 className="text-h2 font-semibold text-text-primary">Choose your Claude directory</h2>
      <p className="text-body text-text-muted">
        Claude Lens reads your local Claude Code data and never sends it anywhere.
      </p>
      <p className="font-mono text-small text-text-faint">{DIRECTORY_RULE}</p>

      <button
        type="button"
        data-testid="pick-directory"
        disabled={busy}
        onClick={() => {
          void pick();
        }}
        className="mt-2 flex items-center gap-2 rounded-control px-6 py-3 text-body font-semibold text-text-primary transition-opacity duration-hover disabled:opacity-60"
        style={{ background: 'var(--grad-violet-cyan)', boxShadow: 'var(--glow)' }}
      >
        {busy && <Spinner />}
        Choose directory…
      </button>

      {/* A rejected directory is DATA (§4.3 `DirValidation`), not an error: the dialog worked,
          the answer was "not this one". It says which of the two markers was missing. */}
      {rejected !== null && (
        <p data-testid="onboarding-rejected" className="text-small text-text-primary">
          Not usable — {rejected.reason ?? DIRECTORY_RULE}. Found{' '}
          {rejected.hasProjects ? 'projects/' : 'no projects/'} and{' '}
          {rejected.hasHistory ? 'history.jsonl' : 'no history.jsonl'}.
        </p>
      )}

      {error !== null && <ErrorState error={error} className="w-full text-left" />}
    </section>
  );
}
