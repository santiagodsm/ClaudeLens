/**
 * Settings — `view-settings` (DESIGN §6.10). Max-width 720 px, stacked cards.
 *
 * ⚠️ **The price-fetch URL ships empty and the button stays disabled until the user fills it**
 * (§11.3, closed). The recorded rationale is stated on the surface in one line: **no third-party
 * trust is baked into a published repo — the user opts into a dependency rather than inheriting
 * one.** The guaranteed-correct path is always the bundled seed plus manual editing.
 *
 * ⚠️ **This is the only place "offline" is visible** (§6.10 state table). *Refresh prices* is the
 * one network call the application can make (§7.5, INV-15). It fails inline, non-blockingly, and
 * **leaves the price table completely intact**; every other control on this screen, and every
 * other screen, works exactly the same with no network at all.
 *
 * ⚠️ Cards 6 (Backups & audit) and 7 (Archive) are E10's. Their mounting points are here, empty
 * and labelled — an unbuilt card that says so is honest; one that renders zeroes is not.
 */

import { useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type {
  AppError,
  DirValidation,
  ErrorCode,
  PriceRow,
  ProjectGroups,
  Result,
  SettingsSnapshot,
  SyncPhase,
  ThemePreference,
  TokenClass,
} from '../../shared/ipc-contract';
import { Badge } from '../components/Badge';
import { ErrorState } from '../components/ErrorState';
import { LoadingState, Spinner } from '../components/LoadingState';
import { useQuery } from '../hooks/use-query';
import { cx } from '../lib/cx';
import { formatInteger, formatMillis, formatRatePerMillion, formatTimestamp } from '../lib/format';
import { invoke } from '../lib/ipc';
import { useAppStore } from '../store/app-store';
import { ViewShell } from '../shell/ViewShell';
import { localDayString } from './shared/disclosures';

// ---------------------------------------------------------------------------
// Copy that DESIGN §6.10 states, so a test can assert the sentence and not a paraphrase.
// ---------------------------------------------------------------------------

export const IDLE_GAP_NOTE = 'Gaps longer than this are removed from active time.';
/** A-12 — the session-efficiency flag threshold, explained in plain words (§1a). Stated as "% lost"
 *  so it matches the Tokens & Cost panel's slider and graph, which use the same framing. */
export const EFFICIENCY_THRESHOLD_NOTE =
  'A session is flagged on the Tokens & Cost screen as worth clearing or compacting once it has lost more than this share of the efficiency it had when it started.';
/** ⚠️ Never let this read as a quality score — it is a self-referential efficiency proxy (A-12). */
export const EFFICIENCY_THRESHOLD_QUALITY_NOTE =
  'This compares tokens written to tokens of context — never the quality of the answers.';
/** ⚠️ The sentence that stops the slider being read as a session-boundary control (INV-05). */
export const IDLE_GAP_BOUNDARY_NOTE = 'This does not change session boundaries.';
export const REBUILD_WARNING =
  'Changing this rebuilds the derived cache. Your price history, settings and audit trail are kept.';
export const ONLY_NETWORK_REQUEST_NOTE =
  'This is the only network request Claude Lens ever makes, and the app works fully without it.';
export const URL_OPT_IN_NOTE =
  'No third-party trust is baked into a published repo — you opt into a dependency rather than inheriting one.';
export const URL_DISABLED_NOTE = 'Set a price-table URL to enable fetching';
export const PRICING_EMPTY_REASON = 'No price rows — load the bundled seed or add one.';
/** §6.10's verified community option, offered as text to paste. **Not a default.** */
export const COMMUNITY_PRICE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * §4.7 / §3.11 — the five classes, in the order the price table lists them.
 *
 * ⚠️ A-05 — `cache_write` is the **5-minute** class and `cache_write_1h` the 1-hour one; they are
 * priced independently and stored, never derived from `input` (ADR-024).
 */
const TOKEN_CLASSES: readonly TokenClass[] = [
  'input',
  'output',
  'cache_write',
  'cache_write_1h',
  'cache_read',
];
const THEMES: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const IDLE_GAP_MIN = 5;
const IDLE_GAP_MAX = 60;
const IDLE_GAP_STEP = 5;

/** A-12 — the flag threshold slider, in whole percent (the stored value is the fraction). */
const EFFICIENCY_MIN_PERCENT = 5;
const EFFICIENCY_MAX_PERCENT = 95;
const EFFICIENCY_STEP_PERCENT = 5;

/**
 * §6.10 error row — "Inline under the field that failed, using the specific `ErrorCode`
 * message". The renderer branches on `code`, never on `message` (§4.1 rule 2).
 */
const PRICE_ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  E_PRICE_OVERLAP: 'That date range overlaps an existing row for this model and class.',
  E_PRICE_PRECISION: 'A rate may carry at most six decimal places of USD per million tokens.',
  E_PRICE_RANGE: 'The end of a validity range must come after its start.',
  E_PRICE_NOT_FOUND: 'No price row matches that model and token class.',
  E_FETCH_NO_URL: 'Set a price-table URL first — nothing is fetched by default.',
  E_FETCH_NETWORK: 'Could not reach the price table. Your price table is unchanged.',
  E_FETCH_TIMEOUT: 'The price table timed out. Your price table is unchanged.',
  E_FETCH_HTTP: 'The price table returned an error. Your price table is unchanged.',
  E_FETCH_SHAPE:
    'That document is not in the format Claude Lens expects. Your price table is unchanged.',
};

function priceErrorText(error: AppError): string {
  return PRICE_ERROR_TEXT[error.code] ?? error.message;
}

export function SettingsView(): JSX.Element {
  return (
    <ViewShell id="settings">
      <div
        className="mx-auto flex w-full flex-col gap-6"
        style={{ maxWidth: 'var(--settings-max-w)' }}
      >
        <DirectoryCard />
        <IdleGapCard />
        <EfficiencyThresholdCard />
        <ThemeCard />
        <ResyncCard />
        {/* A-16 / §3.18 — the explicit rebuild, beside the incremental re-sync it is the opposite
            of. Placed here rather than on its own screen: §6.2 locks eight nav items. */}
        <RereadCard />
        <PricingCard />
        {/* ADR-040 — grouped projects sit with the other things the user decided themselves. */}
        <SameProjectsCard />
        <MountingPoint
          id="backups"
          title="Backups & audit"
          note="Restore points, the audit trail and Undo last action arrive in a later update."
        />
        <MountingPoint
          id="archive"
          title="Archive"
          note="The archive folder picker and the list of archived transcripts arrive in a later update. Archived transcripts are still fully counted."
        />
      </div>
    </ViewShell>
  );
}

// ---------------------------------------------------------------------------
// Shared card chrome
// ---------------------------------------------------------------------------

function Card({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      id={id}
      data-testid={`settings-card-${id}`}
      className="flex flex-col gap-3 rounded-card border border-border bg-bg-surface p-6 shadow-card"
    >
      <div>
        <h2 className="text-h3 font-semibold text-text-primary">{title}</h2>
        {description !== undefined && (
          <p className="mt-1 text-small text-text-muted">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function MountingPoint({
  id,
  title,
  note,
}: {
  id: string;
  title: string;
  note: string;
}): JSX.Element {
  return (
    <Card id={id} title={title}>
      <p className="text-small text-text-muted">{note}</p>
    </Card>
  );
}

/** Persists one setting and adopts the FULL new snapshot §4.3 returns (never a merge). */
async function applySetting<K extends keyof SettingsSnapshot>(
  key: K,
  value: SettingsSnapshot[K],
): Promise<AppError | null> {
  const result = await invoke('settings:set', { key, value });
  if (!result.ok) return result.error;
  useAppStore.setState({ settings: result.data });
  return null;
}

// ---------------------------------------------------------------------------
// 1 — Claude data directory
// ---------------------------------------------------------------------------

function DirectoryCard(): JSX.Element {
  const claudeDir = useAppStore((state) => state.settings?.claudeDir ?? null);
  const runBootstrap = useAppStore((state) => state.runBootstrap);
  // ⚠️ The validation is stored **with the path it validated**. A validation line left over from
  // the previous directory would say "Valid — 412 transcript files" about a folder the user just
  // navigated away from, which is a wrong number with a straight face (CLAUDE.md §1).
  const [validated, setValidated] = useState<{ path: string; validation: DirValidation } | null>(
    null,
  );
  const [rejected, setRejected] = useState<DirValidation | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  // §6.10 — "a live validation line". Revalidated whenever the configured path changes; the
  // renderer has no `node:fs` (INV-16), so the answer can only come from `dir:validate`.
  useEffect(() => {
    if (claudeDir === null) return;
    let cancelled = false;
    void invoke('dir:validate', { path: claudeDir }).then((result) => {
      if (cancelled || !result.ok) return;
      setValidated({ path: claudeDir, validation: result.data });
    });
    return () => {
      cancelled = true;
    };
  }, [claudeDir]);

  const validation =
    validated !== null && validated.path === claudeDir ? validated.validation : null;

  const choose = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const picked = await invoke('dir:pick');
      if (!picked.ok) {
        setError(picked.error);
        return;
      }
      // §4.3 — cancellation is data, not an error. Nothing happens and nothing is said.
      if (picked.data.cancelled) return;
      if (picked.data.validation.status !== 'valid') {
        // A rejected folder is data too: the dialog worked, the answer was "not this one".
        setRejected(picked.data.validation);
        return;
      }
      setRejected(null);
      setValidated({ path: picked.data.path, validation: picked.data.validation });
      const applied = await applySetting('claudeDir', picked.data.path);
      if (applied !== null) {
        setError(applied);
        return;
      }
      await runBootstrap();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="directory" title="Claude data directory">
      <p className="font-mono text-small text-text-primary" data-testid="settings-claude-dir">
        {claudeDir ?? 'not set'}
      </p>

      {validation !== null && (
        <p
          data-testid="dir-validation"
          className={cx('text-small', validation.status === 'valid' ? 'text-ok' : 'text-danger')}
        >
          {validation.status === 'valid'
            ? `Valid — ${formatInteger(validation.transcriptFileCount)} transcript files detected`
            : (validation.reason ?? 'That directory cannot be used.')}
        </p>
      )}

      {rejected !== null && (
        <p data-testid="dir-rejected" className="text-small text-danger">
          Not usable — {rejected.reason ?? 'must contain projects/ and/or history.jsonl'}. Found{' '}
          {rejected.hasProjects ? 'projects/' : 'no projects/'} and{' '}
          {rejected.hasHistory ? 'history.jsonl' : 'no history.jsonl'}.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="settings-choose-folder"
          disabled={busy}
          onClick={() => {
            void choose();
          }}
          className="flex items-center gap-2 rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2 disabled:opacity-60"
        >
          {busy && <Spinner />}
          Choose folder…
        </button>
      </div>

      <p className="text-small text-text-muted">{REBUILD_WARNING}</p>
      {error !== null && <ErrorState error={error} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2 — Idle-gap threshold
// ---------------------------------------------------------------------------

function IdleGapCard(): JSX.Element {
  const stored = useAppStore((state) => state.settings?.idleGapMinutes ?? null);
  const [value, setValue] = useState<number | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const current = value ?? stored;

  return (
    <Card id="idle-gap" title="Idle-gap threshold">
      <label className="flex items-center gap-4 text-small text-text-primary">
        <input
          type="range"
          data-testid="idle-gap-slider"
          aria-label="Idle-gap threshold in minutes"
          min={IDLE_GAP_MIN}
          max={IDLE_GAP_MAX}
          step={IDLE_GAP_STEP}
          disabled={current === null}
          value={current ?? IDLE_GAP_MIN}
          onChange={(event) => {
            setValue(Number.parseInt(event.target.value, 10));
          }}
          onPointerUp={() => {
            if (value === null) return;
            void applySetting('idleGapMinutes', value).then(setError);
          }}
          onKeyUp={() => {
            if (value === null) return;
            void applySetting('idleGapMinutes', value).then(setError);
          }}
          className="w-full"
        />
        <span data-testid="idle-gap-value" className="w-16 shrink-0 text-right">
          {current === null ? '—' : `${String(current)} min`}
        </span>
      </label>
      <p className="text-small text-text-muted">{IDLE_GAP_NOTE}</p>
      {/* ⚠️ INV-05 — changing this changes active time and nothing else. */}
      <p className="text-small text-text-primary">{IDLE_GAP_BOUNDARY_NOTE}</p>
      {error !== null && <p className="text-small text-danger">{error.message}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2b — Session-efficiency flag threshold (A-12)
// ---------------------------------------------------------------------------

/**
 * A-12 — mirrors the panel's slider so the two always agree, and persists the value so it sticks
 * across launches (the same USER-class round trip as every other setting).
 *
 * ⚠️ The STORED value is unchanged — a retained-efficiency fraction (`efficiencyDropThreshold`,
 * default 0.40). The control shows and edits it as "% lost" (its complement) to match the panel's
 * graph and slider: display = 100 − round(fraction×100) (60 by default), and a change of L% persists
 * a fraction of (100 − L)/100. Slider range 5–95 (% lost) ↔ stored 0.95–0.05, inside [0.05, 0.95].
 */
function EfficiencyThresholdCard(): JSX.Element {
  const stored = useAppStore((state) => state.settings?.efficiencyDropThreshold ?? null);
  const [value, setValue] = useState<number | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const currentFraction = value ?? stored;
  const currentLostPercent =
    currentFraction === null ? null : 100 - Math.round(currentFraction * 100);

  return (
    <Card id="efficiency-threshold" title="Flag sessions worth restarting">
      <label className="flex items-center gap-4 text-small text-text-primary">
        <input
          type="range"
          data-testid="efficiency-threshold-slider"
          aria-label="Flag a session once it has lost more than this share of its starting efficiency"
          min={EFFICIENCY_MIN_PERCENT}
          max={EFFICIENCY_MAX_PERCENT}
          step={EFFICIENCY_STEP_PERCENT}
          disabled={currentLostPercent === null}
          value={currentLostPercent ?? EFFICIENCY_MIN_PERCENT}
          onChange={(event) => {
            // Slider is "% lost"; the STORED value stays the retained fraction (100 − lost) / 100.
            setValue((100 - Number.parseInt(event.target.value, 10)) / 100);
          }}
          onPointerUp={() => {
            if (value === null) return;
            void applySetting('efficiencyDropThreshold', value).then(setError);
          }}
          onKeyUp={() => {
            if (value === null) return;
            void applySetting('efficiencyDropThreshold', value).then(setError);
          }}
          className="w-full"
        />
        <span data-testid="efficiency-threshold-value" className="w-24 shrink-0 text-right">
          {currentLostPercent === null ? '—' : `${String(currentLostPercent)}% lost`}
        </span>
      </label>
      <p className="text-small text-text-muted">{EFFICIENCY_THRESHOLD_NOTE}</p>
      {/* ⚠️ A-12 — never let it read as a quality score. */}
      <p className="text-small text-text-primary">{EFFICIENCY_THRESHOLD_QUALITY_NOTE}</p>
      {error !== null && <p className="text-small text-danger">{error.message}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3 — Theme
// ---------------------------------------------------------------------------

function ThemeCard(): JSX.Element {
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);

  return (
    <Card id="theme" title="Theme">
      <div role="radiogroup" aria-label="Theme" className="flex gap-2">
        {THEMES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={theme === option.value}
            data-testid={`theme-${option.value}`}
            onClick={() => {
              void setTheme(option.value);
            }}
            className={cx(
              'rounded-control border border-border px-3 py-2 text-small transition-colors duration-hover',
              theme === option.value ? 'bg-bg-surface-2 text-text-primary' : 'text-text-muted',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 4 — Re-sync data
// ---------------------------------------------------------------------------

function ResyncCard(): JSX.Element {
  const sync = useAppStore((state) => state.sync);
  const refresh = useAppStore((state) => state.refresh);
  const running = sync !== null && sync.phase !== 'idle' && sync.phase !== 'failed';

  return (
    <Card
      id="resync"
      title="Re-sync data"
      description="An incremental refresh of the derived cache."
    >
      <p className="text-small text-text-muted" data-testid="resync-last">
        Last sync {formatTimestamp(sync?.lastCompletedAt ?? null)}
        {sync?.lastDurationMs === undefined || sync.lastDurationMs === null
          ? ''
          : ` · took ${formatMillis(sync.lastDurationMs)}`}
      </p>
      <div>
        <button
          type="button"
          data-testid="settings-resync"
          disabled={running}
          onClick={() => {
            void refresh();
          }}
          className="flex items-center gap-2 rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2 disabled:opacity-60"
        >
          {running && <Spinner />}
          Re-sync now
        </button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 4a — Read transcripts again from the start (A-16, §3.18's "explicit rebuild")
// ---------------------------------------------------------------------------

/**
 * ⚠️ **Every sentence below is the contract of this control, and §1a is binding on all of them.**
 * No `message.id`, no column name, no section number, no `ACT-xx` — this button re-reads files,
 * and the copy says that in the words someone who has never opened `DESIGN.md` would use.
 *
 * ⚠️ The one sentence that must never be dropped for brevity is `REREAD_CANNOT_REACH`. Archived
 * transcripts (§5.3 `ARCHIVED`, ADR-034) and vanished ones (`retained_orphan = 1`, ADR-041) are
 * never re-parsed, by design, so a rebuild reaches everything except them. A card that implied a
 * clean sweep would be promising a remedy that cannot work for part of the data — exactly the
 * mistake A-05's archived cache-split sentence exists to avoid.
 */
export const REREAD_WHAT_IT_DOES =
  'Claude Lens normally reads only what is new at the end of each transcript, so a line it read once is never looked at again. This reads every transcript from the beginning.';
export const REREAD_WHY =
  'Worth doing when Claude Lens has learned to notice something it was not recording when it first read your history — the answers on the other screens are rebuilt from the files, so what it can now see, it sees everywhere.';
export const REREAD_WHAT_IS_KEPT =
  'Your price table, your settings, the record of what you have archived, the history of actions you have taken and the projects you have told Claude Lens are the same are all kept — none of them come from your transcripts.';
export const REREAD_CANNOT_REACH =
  'Transcripts you have archived, and transcripts that have disappeared from your Claude data directory, are never re-read. Their history is kept exactly as it is, and whatever Claude Lens did not record the first time stays unknown for them — this cannot bring it back.';
export const REREAD_COST =
  'This takes about as long as the very first scan did. You can keep using the app while it runs, and you can stop it at any time — anything already read again stays read.';
/** The second step. ⚠️ Explicit and user-initiated; nothing in the app ever decides this (ADR-032). */
export const REREAD_CONFIRM_QUESTION =
  'Read every transcript again from the beginning? Nothing in your Claude data directory is changed or deleted.';

/** Plain words for each phase of a running cycle (§1a — never the phase name itself). */
function syncPhaseWords(phase: SyncPhase): string {
  switch (phase) {
    case 'scanning':
      return 'Looking through your Claude data directory';
    case 'parsing':
      return 'Reading transcripts';
    case 'finalizing':
      return 'Finishing up';
    case 'cancelling':
      return 'Stopping';
    default:
      return 'Working';
  }
}

function RereadCard(): JSX.Element {
  const sync = useAppStore((state) => state.sync);
  const rereadEverything = useAppStore((state) => state.rereadEverything);
  const applySync = useAppStore((state) => state.applySync);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const running = sync !== null && sync.phase !== 'idle' && sync.phase !== 'failed';

  return (
    <Card id="reread" title="Read your transcripts again from the start">
      <p className="text-small text-text-muted" data-testid="reread-what">
        {REREAD_WHAT_IT_DOES}
      </p>
      <p className="text-small text-text-muted" data-testid="reread-why">
        {REREAD_WHY}
      </p>
      <p className="text-small text-text-muted" data-testid="reread-kept">
        {REREAD_WHAT_IS_KEPT}
      </p>
      {/* ⚠️ The honest limit, in its own paragraph so it cannot be skimmed past as a footnote. */}
      <p className="text-small text-text-muted" data-testid="reread-cannot-reach">
        {REREAD_CANNOT_REACH}
      </p>
      <p className="text-small text-text-muted" data-testid="reread-cost">
        {REREAD_COST}
      </p>

      {running ? (
        <div className="flex flex-wrap items-center gap-3">
          <span
            role="status"
            className="flex items-center gap-2 text-small text-text-primary"
            data-testid="reread-progress"
          >
            <Spinner />
            {syncPhaseWords(sync.phase)}
            {/* ⚠️ A file count only once there is one. `0 of 0` during SCANNING would be a
                fabricated denominator for a total nobody has counted yet (CLAUDE.md §1). */}
            {sync.filesTotal > 0 &&
              ` — ${formatInteger(sync.filesDone)} of ${formatInteger(sync.filesTotal)} files`}
          </span>
          <button
            type="button"
            data-testid="reread-stop"
            onClick={() => {
              void (async () => {
                const result = await invoke('sync:cancel');
                // §5.2 — already-committed files stay committed and the manifest stays consistent
                // with them; nothing is rolled back. The next sync picks up from there.
                if (result.ok) applySync(result.data);
              })();
            }}
            className="rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
          >
            Stop
          </button>
        </div>
      ) : confirming ? (
        <div className="flex flex-col gap-2" data-testid="reread-confirm">
          <p className="text-small text-text-primary">{REREAD_CONFIRM_QUESTION}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="reread-confirm-yes"
              onClick={() => {
                void (async () => {
                  setConfirming(false);
                  setError(await rereadEverything());
                })();
              }}
              className="rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
            >
              Yes, read them again
            </button>
            <button
              type="button"
              data-testid="reread-confirm-no"
              onClick={() => {
                setConfirming(false);
              }}
              className="rounded-control px-3 py-2 text-small text-text-muted transition-colors duration-hover hover:text-text-primary"
            >
              Leave things as they are
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            data-testid="settings-reread"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            className="rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
          >
            Read everything again
          </button>
        </div>
      )}

      {error !== null && (
        // §6.10 — inline, under the control that failed. ⚠️ A refusal means NOTHING was deleted
        // and no re-read started, and the sentence has to say so; the user has just been told the
        // app is about to clear its answers.
        <p role="status" className="text-small text-danger" data-testid="reread-error">
          {error.message} Nothing was cleared and nothing has started.
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 5 — Pricing
// ---------------------------------------------------------------------------

function PricingCard(): JSX.Element {
  const storedUrl = useAppStore((state) => state.settings?.priceFetchUrl ?? '');
  const models = useQuery('pricing:models', undefined);
  const prices = useQuery('pricing:list', { includeHistory: true });

  // ⚠️ Not a mirror of the query. Every `pricing:*` mutation returns the **full new row set**
  // (§4.7), so this holds the newest authoritative answer the main process gave us and is
  // preferred over the last list response until the next one arrives (`evt:pricingChanged`
  // invalidates the query). It is never a locally-computed row.
  const [written, setWritten] = useState<PriceRow[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const rows = written ?? prices.data?.rows ?? null;
  const setRows = setWritten;
  const currentUrl = url ?? storedUrl;
  // §6.10 / §11.3 — the button is disabled until the user has typed a URL. Nothing is fetched
  // by default, and no URL ships in the repository.
  const canFetch = currentUrl.trim() !== '' && !fetching;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    setNotice(null);
    await action();
  };

  const editRate = (row: PriceRow, usdPerMillion: number): void => {
    void run(async () => {
      const result = await invoke('pricing:upsertRate', {
        model: row.model,
        tokenClass: row.tokenClass,
        usdPerMillion,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows(result.data.rows);
    });
  };

  const editDates = (row: PriceRow, validFrom: number, validTo: number | null): void => {
    void run(async () => {
      const result = await invoke('pricing:setDates', { id: row.id, validFrom, validTo });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows(result.data.rows);
    });
  };

  const deleteRow = (row: PriceRow): void => {
    void run(async () => {
      const result = await invoke('pricing:deleteRow', { id: row.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows(result.data.rows);
    });
  };

  const resetToSeed = (): void => {
    void run(async () => {
      const result = await invoke('pricing:resetToSeed');
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(
        `Bundled seed applied — ${formatInteger(result.data.applied.length)} changed, ${formatInteger(result.data.unchanged)} unchanged.`,
      );
      const listed = await invoke('pricing:list', { includeHistory: true });
      if (listed.ok) setRows(listed.data.rows);
    });
  };

  const refreshPrices = (): void => {
    setFetching(true);
    void run(async () => {
      const result = await invoke('pricing:fetch');
      if (!result.ok) {
        // §6.10 offline row — non-blocking, inline, and the table is left completely intact.
        setError(result.error);
        return;
      }
      setNotice(
        `Fetched from ${result.data.sourceUrl} — ${formatInteger(result.data.applied.length)} changed, ${formatInteger(result.data.unchanged)} unchanged.`,
      );
      const listed = await invoke('pricing:list', { includeHistory: true });
      if (listed.ok) setRows(listed.data.rows);
    }).finally(() => {
      setFetching(false);
    });
  };

  return (
    <Card
      id="pricing"
      title="Pricing"
      description="Rates are yours: stored locally, edited here, and never fetched unless you ask."
    >
      {/* §4.7 — the counterpart of the uncosted disclosure: an unpriced model is VISIBLE. */}
      <section aria-label="Models observed" className="flex flex-col gap-2">
        <h3 className="text-micro uppercase text-text-muted">Models observed</h3>
        {models.error !== null ? (
          <ErrorState error={models.error} onRetry={models.refetch} />
        ) : models.data === null ? (
          <LoadingState lines={2} label="Loading observed models" />
        ) : models.data.rows.length === 0 ? (
          <p className="text-small text-text-muted">No models observed yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="observed-models">
            {models.data.rows.map((row) => (
              <li key={row.model}>
                <Badge tone={row.priced ? 'ok' : 'warn'}>
                  {row.model} · {row.priced ? 'priced' : 'no price row'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Price table" className="flex flex-col gap-2">
        <h3 className="text-micro uppercase text-text-muted">Price table</h3>
        {prices.error !== null ? (
          <ErrorState error={prices.error} onRetry={prices.refetch} />
        ) : rows === null ? (
          <LoadingState lines={4} label="Loading price rows" />
        ) : rows.length === 0 ? (
          <p className="text-small text-text-muted" data-testid="pricing-empty">
            {PRICING_EMPTY_REASON}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-small" data-testid="price-table">
              <caption className="sr-only">Price rows, editable</caption>
              <thead>
                <tr className="text-micro uppercase text-text-muted">
                  <th scope="col" className="p-2 text-left">
                    Model
                  </th>
                  <th scope="col" className="p-2 text-left">
                    Class
                  </th>
                  <th scope="col" className="p-2 text-right">
                    USD / 1M
                  </th>
                  <th scope="col" className="p-2 text-left">
                    From
                  </th>
                  <th scope="col" className="p-2 text-left">
                    To
                  </th>
                  <th scope="col" className="p-2 text-left">
                    Source
                  </th>
                  <th scope="col" className="p-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <PriceRowEditor
                    key={row.id}
                    row={row}
                    onRate={editRate}
                    onDates={editDates}
                    onDelete={deleteRow}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <AddRateForm
          onAdd={(model, tokenClass, usdPerMillion) => {
            void run(async () => {
              const result = await invoke('pricing:upsertRate', {
                model,
                tokenClass,
                usdPerMillion,
              });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setRows(result.data.rows);
            });
          }}
        />

        <div>
          <button
            type="button"
            data-testid="reset-to-seed"
            onClick={resetToSeed}
            className="rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
          >
            Reset to bundled seed
          </button>
        </div>
      </section>

      <section aria-label="Price fetch" className="flex flex-col gap-2">
        <h3 className="text-micro uppercase text-text-muted">Price-table URL</h3>
        <label className="flex flex-col gap-1 text-small text-text-muted">
          <span className="sr-only">Price-table URL</span>
          <input
            type="url"
            data-testid="price-fetch-url"
            aria-label="Price-table URL"
            placeholder="(empty — nothing is fetched)"
            value={currentUrl}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
            onBlur={() => {
              if (url === null) return;
              void applySetting('priceFetchUrl', url).then(setError);
            }}
            className="w-full rounded-control border border-border bg-bg-surface px-3 py-2 font-mono text-small text-text-primary"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="refresh-prices"
            disabled={!canFetch}
            title={canFetch ? undefined : URL_DISABLED_NOTE}
            onClick={refreshPrices}
            className="flex items-center gap-2 rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2 disabled:opacity-60"
          >
            {fetching && <Spinner />}
            Refresh prices
          </button>
          {!canFetch && !fetching && (
            <span className="text-small text-text-muted" data-testid="refresh-disabled-note">
              {URL_DISABLED_NOTE}
            </span>
          )}
        </div>

        <p className="text-small text-text-muted">{ONLY_NETWORK_REQUEST_NOTE}</p>
        {/* §11.3's recorded rationale, in one line, on the surface. */}
        <p className="text-small text-text-primary">{URL_OPT_IN_NOTE}</p>

        <details className="text-small text-text-muted">
          <summary className="cursor-pointer">A community-maintained option you may paste</summary>
          <p className="mt-2">
            Verified 2026-07-20 to exist and to carry the four original token classes:
          </p>
          <p className="mt-1 font-mono text-micro break-all text-text-primary">
            {COMMUNITY_PRICE_URL}
          </p>
          <p className="mt-2">
            (LiteLLM&apos;s <code>model_prices_and_context_window.json</code>.) It uses its own
            field names — <code>input_cost_per_token</code>, <code>output_cost_per_token</code>,{' '}
            <code>cache_creation_input_token_cost</code>, <code>cache_read_input_token_cost</code>,
            all in USD per token — and <strong>carries no effective dates</strong>, so Claude Lens
            dates any change it applies at the moment you fetch. Adapting that shape to the document
            format Claude Lens expects is a separate, opt-in step.
          </p>
          <p className="mt-2">
            ⚠️ This is help text, not a default. Nothing is fetched, and no adapter for that shape
            ships in v1 — a raw fetch of it is rejected as an unrecognised format, leaving the price
            table intact. ⚠️ There is also a fifth token class — 1-hour cache writes — and it is
            required like the other four: a document without it is rejected by name rather than
            having its 1-hour rate guessed at.
          </p>
        </details>

        {error !== null && (
          <p className="text-small text-danger" data-testid="pricing-error" role="alert">
            {priceErrorText(error)}
          </p>
        )}
        {notice !== null && (
          <p className="text-small text-ok" data-testid="pricing-notice" role="status">
            {notice}
          </p>
        )}
      </section>
    </Card>
  );
}

function PriceRowEditor({
  row,
  onRate,
  onDates,
  onDelete,
}: {
  row: PriceRow;
  onRate: (row: PriceRow, usdPerMillion: number) => void;
  onDates: (row: PriceRow, validFrom: number, validTo: number | null) => void;
  onDelete: (row: PriceRow) => void;
}): JSX.Element {
  const [rate, setRate] = useState<string | null>(null);

  const commitRate = (): void => {
    if (rate === null) return;
    const parsed = Number.parseFloat(rate);
    setRate(null);
    if (!Number.isFinite(parsed)) return;
    onRate(row, parsed);
  };

  return (
    <tr data-testid="price-row" className="border-t border-border">
      <td className="p-2 font-mono text-micro text-text-primary">{row.model}</td>
      <td className="p-2 text-text-muted">{row.tokenClass}</td>
      <td className="p-2 text-right">
        <input
          type="number"
          step="any"
          aria-label={`${row.model} ${row.tokenClass} USD per million tokens`}
          data-testid="price-rate-input"
          value={rate ?? String(row.usdPerMillion)}
          onChange={(event) => {
            setRate(event.target.value);
          }}
          onBlur={commitRate}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRate();
          }}
          className="w-28 rounded-control border border-border bg-bg-surface px-2 py-1 text-right text-small text-text-primary"
        />
        <span className="sr-only">{formatRatePerMillion(row.usdPerMillion)}</span>
      </td>
      <td className="p-2">
        <input
          type="date"
          aria-label={`${row.model} ${row.tokenClass} valid from`}
          data-testid="price-valid-from"
          value={localDayString(row.validFrom)}
          onChange={(event) => {
            const next = parseLocalDayInput(event.target.value);
            if (next !== null) onDates(row, next, row.validTo);
          }}
          className="rounded-control border border-border bg-bg-surface px-2 py-1 text-small text-text-primary"
        />
      </td>
      <td className="p-2">
        <input
          type="date"
          aria-label={`${row.model} ${row.tokenClass} valid to`}
          data-testid="price-valid-to"
          value={row.validTo === null ? '' : localDayString(row.validTo)}
          onChange={(event) => {
            onDates(row, row.validFrom, parseLocalDayInput(event.target.value));
          }}
          className="rounded-control border border-border bg-bg-surface px-2 py-1 text-small text-text-primary"
        />
      </td>
      <td className="p-2 text-text-muted">{row.source}</td>
      <td className="p-2 text-right">
        <button
          type="button"
          data-testid="price-delete"
          aria-label={`Delete the ${row.model} ${row.tokenClass} row`}
          onClick={() => {
            onDelete(row);
          }}
          className="rounded-control border border-border px-2 py-1 text-micro text-text-muted transition-colors duration-hover hover:bg-bg-surface-2"
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

function AddRateForm({
  onAdd,
}: {
  onAdd: (model: string, tokenClass: TokenClass, usdPerMillion: number) => void;
}): JSX.Element {
  const [model, setModel] = useState('');
  const [tokenClass, setTokenClass] = useState<TokenClass>('output');
  const [rate, setRate] = useState('');

  const parsed = Number.parseFloat(rate);
  const ready = model.trim() !== '' && Number.isFinite(parsed);

  return (
    <form
      data-testid="add-rate-form"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        // ADR-025 — the exact raw model string, with no normalization or aliasing.
        onAdd(model.trim(), tokenClass, parsed);
        setModel('');
        setRate('');
      }}
    >
      <label className="flex flex-col gap-1 text-micro uppercase text-text-muted">
        Model
        <input
          type="text"
          data-testid="add-rate-model"
          value={model}
          onChange={(event) => {
            setModel(event.target.value);
          }}
          className="rounded-control border border-border bg-bg-surface px-2 py-1 font-mono text-small text-text-primary"
        />
      </label>
      <label className="flex flex-col gap-1 text-micro uppercase text-text-muted">
        Class
        <select
          data-testid="add-rate-class"
          value={tokenClass}
          onChange={(event) => {
            setTokenClass(event.target.value as TokenClass);
          }}
          className="rounded-control border border-border bg-bg-surface px-2 py-1 text-small text-text-primary"
        >
          {TOKEN_CLASSES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-micro uppercase text-text-muted">
        USD / 1M
        <input
          type="number"
          step="any"
          data-testid="add-rate-value"
          value={rate}
          onChange={(event) => {
            setRate(event.target.value);
          }}
          className="w-28 rounded-control border border-border bg-bg-surface px-2 py-1 text-small text-text-primary"
        />
      </label>
      <button
        type="submit"
        disabled={!ready}
        data-testid="add-rate-submit"
        className="rounded-control border border-border px-3 py-2 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2 disabled:opacity-60"
      >
        Add row
      </button>
    </form>
  );
}

/** `YYYY-MM-DD` from a `<input type="date">` → local midnight epoch ms (ADR-021). */
function parseLocalDayInput(value: string): number | null {
  if (value === '') return null;
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) return null;
  return new Date(year, month - 1, day).getTime();
}

// ---------------------------------------------------------------------------
// Projects you have said are the same — §6.10 (ADR-040)
// ---------------------------------------------------------------------------

/**
 * The management half of grouping. The action itself lives on Projects & Code, where the cards
 * are; this card is the permanent record: what you grouped, what is in it, rename, split apart.
 *
 * ⚠️ **Nothing here proposes a group.** §2.1's zero-inference rule is untouched: the app never
 * decides that two folders are one project, and there is no "suggested", "similar" or
 * "candidates" list on this card or behind any button on it.
 * ⚠️ Plain language only (§1a): "These are the same project", "Split apart", "not currently
 * present". No metric ids, no table names, no section numbers on screen.
 */
function SameProjectsCard(): JSX.Element {
  const groups = useQuery('groups:list', undefined);
  const [editing, setEditing] = useState<number | null>(null);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<AppError | null>(null);

  const run = async (call: Promise<Result<ProjectGroups>>): Promise<void> => {
    const result = await call;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setEditing(null);
    groups.refetch();
  };

  return (
    <Card
      id="project-groups"
      title="Projects you have said are the same"
      description="When you move a project to a new folder, Claude Code sees two projects. Tell Claude Lens they are the same one on the Projects & Code screen, and they count as one project everywhere. Nothing on disk changes, and you can split them apart again here."
    >
      {groups.error !== null ? (
        <ErrorState error={groups.error} onRetry={groups.refetch} className="border-0" />
      ) : groups.data === null ? (
        <LoadingState label="Loading grouped projects" lines={2} />
      ) : groups.data.rows.length === 0 ? (
        <p data-testid="project-groups-empty" className="text-small text-text-muted">
          You have not said that any projects are the same. To do that, tick two or more projects on
          the Projects &amp; Code screen.
        </p>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="project-groups-list">
          {groups.data.rows.map((group) => (
            <li
              key={group.id}
              data-testid={`project-group-${String(group.id)}`}
              className="flex flex-col gap-2 rounded-control border border-border p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                {editing === group.id ? (
                  <>
                    <input
                      data-testid={`project-group-name-${String(group.id)}`}
                      value={draftName}
                      autoFocus
                      onChange={(event) => {
                        setDraftName(event.target.value);
                      }}
                      className="min-w-0 flex-1 rounded-control border border-border bg-bg-surface-2 px-3 py-1 text-small text-text-primary"
                    />
                    <button
                      type="button"
                      data-testid={`project-group-save-${String(group.id)}`}
                      onClick={() => {
                        void run(invoke('groups:rename', { groupId: group.id, name: draftName }));
                      }}
                      className="rounded-control border border-border px-3 py-1 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(null);
                        setError(null);
                      }}
                      className="rounded-control px-3 py-1 text-small text-text-muted transition-colors duration-hover hover:bg-bg-surface-2"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <Badge colorIndex={group.colorIndex}>{group.name}</Badge>
                    <span className="text-micro text-text-muted">
                      {group.members.length} folders
                    </span>
                    <button
                      type="button"
                      data-testid={`project-group-rename-${String(group.id)}`}
                      onClick={() => {
                        setEditing(group.id);
                        setDraftName(group.name);
                        setError(null);
                      }}
                      className="ml-auto rounded-control border border-border px-3 py-1 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      data-testid={`project-group-ungroup-${String(group.id)}`}
                      onClick={() => {
                        void run(invoke('groups:ungroup', { groupId: group.id }));
                      }}
                      className="rounded-control border border-border px-3 py-1 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
                    >
                      Split apart
                    </button>
                  </>
                )}
              </div>
              <ul className="flex flex-col gap-1">
                {group.members.map((member) => (
                  <li
                    key={member.encodedName}
                    // §3.3, §7.8/P-33 — the encoded name is an absolute personal path (the
                    // identity). It disambiguates on hover only; it is never visible text a
                    // screenshot could leak. The display name is the only project string shown.
                    title={member.encodedName}
                    className="flex items-center gap-2 text-micro text-text-muted"
                  >
                    {/* ⚠️ A folder that is not currently present is SHOWN as such, never hidden
                        and never deleted on the app's own initiative. */}
                    <span>
                      {member.displayName ?? 'not currently present — nothing has been lost'}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <p data-testid="project-groups-error" className="text-small text-danger">
          {error.message}
        </p>
      )}

      <p className="text-micro text-text-faint">
        Splitting a group apart puts every number back exactly as it was. Claude Lens never decides
        on its own that two folders are the same project — you do.
      </p>
    </Card>
  );
}
