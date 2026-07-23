/**
 * §4.8 / §6.9 — the "Rescan" affordance and its "last scanned" caption, shared by the Harness
 * Manager (§6.9) and the Harness Map (§6.7). Both surfaces re-read the same harness tables, so
 * both offer the same one-click way to re-walk `~/.claude` after files change while the app is
 * open — driven by `useHarnessScan`, which owns the `harness:scan` round trip.
 *
 * ⚠️ Plain words only, no jargon (CLAUDE.md §1a): "Rescan", "Scanning…", "Last scanned <time>",
 * "Not scanned yet this session" — never a channel name, never `harness:scan`.
 */

import type { JSX } from 'react';
import { formatTimestamp } from '../lib/format';
import { useHarnessScan } from '../hooks/use-harness-scan';

export function RescanButton(): JSX.Element {
  const { rescan, scanning, error, lastScannedAt } = useHarnessScan();
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="harness-rescan">
      <button
        type="button"
        onClick={rescan}
        disabled={scanning}
        data-testid="harness-rescan-button"
        className="rounded-control border border-border px-3 py-1 text-small text-text-primary disabled:opacity-60"
      >
        {scanning ? 'Scanning…' : 'Rescan'}
      </button>
      <span className="text-small text-text-muted" data-testid="harness-last-scanned">
        {lastScannedAt === null
          ? 'Not scanned yet this session'
          : `Last scanned ${formatTimestamp(lastScannedAt)}`}
      </span>
      {error !== null && (
        <span role="status" className="text-small text-danger" data-testid="harness-rescan-error">
          {error.message}
        </span>
      )}
    </div>
  );
}
