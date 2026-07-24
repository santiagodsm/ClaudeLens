/**
 * Projects & Code — `view-projects` (DESIGN §6.8).
 *
 * ⚠️ **"Edits", never "lines changed", and no diff is rendered anywhere** (§1.6 non-goal 3,
 * §5.9 M-15: "Never called churn, never presented as lines changed"). M-15 counts `file_touches`
 * rows — how many times a write-class tool touched a path — which is not a measure of how much
 * changed and must never be labelled as one.
 *
 * ⚠️ **Grouping lives here** (§6.8, ADR-040). Tick two or more cards and say "These are the same
 * project"; the folders then render as one card and count as one project everywhere. ⚠️ Nothing
 * on this screen suggests a grouping — no "these look similar", no name matching, no candidate
 * list. §2.1's zero-inference rule is unchanged: the user picks the folders and types the name.
 * ⚠️ Opening a group shows its member folders with their own numbers, and says in plain words why
 * those numbers do not add up to the card's active time (§1a).
 *
 * ⚠️ **There is deliberately NO overlap disclosure on this view, and its absence is provable
 * rather than assumed** (§6.8, INV-22(d)). `ProjectCard.activeSeconds` is M-07 binding (C), but
 * binding (C) restricted to one project has exactly one partition per local day and distinct
 * days' covered intervals cannot intersect, so M-20 is identically `0` here. The disclosure
 * would always read "0 hours". E1 made the omission compiler-enforced: `ProjectCards` carries no
 * `overlapSeconds` field, so this view could not render one if it tried.
 */

import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { AppError, ProjectCard as ProjectCardPayload } from '../../shared/ipc-contract';
import { invoke } from '../lib/ipc';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { useQuery } from '../hooks/use-query';
import { categoricalVar, GRADIENT } from '../lib/colors';
import { formatCost, formatDuration, formatInteger } from '../lib/format';
import { useAppStore } from '../store/app-store';
import { ViewShell } from '../shell/ViewShell';
import { EditSparkline } from './charts/EditSparkline';
import { ProjectDetailDrawer } from './shared/ProjectDetailDrawer';
import { ListPriceLine, UncostedLine } from './shared/disclosures';

/** §6.8's empty copy, verbatim (including the trailing full stop and the code span's words). */
export const PROJECTS_EMPTY_REASON = 'No projects found under projects/.';

export function ProjectsView(): JSX.Element {
  const filter = useAppStore((state) => state.filter);
  const idleGapMinutes = useAppStore((state) => state.settings?.idleGapMinutes ?? null);
  const [selected, setSelected] = useState<number | null>(null);
  // ⚠️ The tick-boxes are local to this screen and hold UNIT ids. They are not a filter and not
  // a store fact: they exist only between "I mean these two" and "call them this".
  const [ticked, setTicked] = useState<number[]>([]);
  const [naming, setNaming] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupError, setGroupError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);

  const cards = useQuery('q:projectCards', filter);

  const tickedCards = (cards.data?.rows ?? []).filter((row) => ticked.includes(row.projectId));
  // A group is made of FOLDERS (§3.3 `encoded_name` — the identity), never of unit ids, because
  // a rebuild renumbers every project. This is where the folder names are gathered.
  const tickedFolders = tickedCards.flatMap((row) => row.members.map((m) => m.encodedName));

  const toggleTick = (unitId: number): void => {
    setGroupError(null);
    setTicked((current) =>
      current.includes(unitId) ? current.filter((id) => id !== unitId) : [...current, unitId],
    );
  };

  const saveGroup = async (): Promise<void> => {
    setSaving(true);
    setGroupError(null);
    const result = await invoke('groups:create', {
      name: groupName,
      encodedNames: tickedFolders,
    });
    setSaving(false);
    if (!result.ok) {
      setGroupError(result.error);
      return;
    }
    setTicked([]);
    setNaming(false);
    setGroupName('');
    cards.refetch();
  };

  return (
    <ViewShell
      id="projects"
      secondary={
        // ⚠️ One destination, first door: a card click opens the shared project-detail surface
        // (§6.8, user directive) — the same drawer a treemap tile opens in Tokens & Cost. Its
        // files-touched panel, group folders and every stat live inside it now.
        <ProjectDetailDrawer
          projectId={selected}
          onClose={() => {
            setSelected(null);
          }}
        />
      }
    >
      {cards.error !== null ? (
        <ErrorState error={cards.error} onRetry={cards.refetch} data-testid="projects-error" />
      ) : cards.data === null ? (
        <CardSkeletons />
      ) : cards.data.rows.length === 0 ? (
        <EmptyState reason={PROJECTS_EMPTY_REASON} data-testid="projects-empty" />
      ) : (
        <div className="flex flex-col gap-4">
          <SameProjectBar
            ticked={ticked.length}
            folders={tickedFolders.length}
            naming={naming}
            name={groupName}
            saving={saving}
            error={groupError}
            onStart={() => {
              setNaming(true);
            }}
            onCancel={() => {
              setNaming(false);
              setGroupName('');
              setGroupError(null);
            }}
            onName={setGroupName}
            onSave={() => {
              void saveGroup();
            }}
            onClear={() => {
              setTicked([]);
              setNaming(false);
              setGroupError(null);
            }}
          />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {cards.data.rows.map((row, index) => (
              <ProjectCard
                key={row.projectId}
                card={row}
                index={index}
                idleGapMinutes={idleGapMinutes}
                selected={row.projectId === selected}
                ticked={ticked.includes(row.projectId)}
                onTick={() => {
                  toggleTick(row.projectId);
                }}
                onOpen={() => {
                  setSelected(row.projectId);
                }}
              />
            ))}
          </div>
          {/* INV-10 — the cards carry `costNanoUsd`, so the page carries its disclosure. */}
          {cards.data.uncosted.records > 0 && (
            <p className="text-small text-text-muted">
              <UncostedLine uncosted={cards.data.uncosted} />
            </p>
          )}
        </div>
      )}
    </ViewShell>
  );
}

function ProjectCard({
  card,
  index,
  idleGapMinutes,
  selected,
  ticked,
  onTick,
  onOpen,
}: {
  card: ProjectCardPayload;
  index: number;
  idleGapMinutes: number | null;
  selected: boolean;
  ticked: boolean;
  onTick: () => void;
  onOpen: () => void;
}): JSX.Element {
  const grouped = card.groupId !== null;
  return (
    <section
      data-testid="project-card"
      data-selected={selected ? 'true' : undefined}
      className="relative overflow-hidden rounded-card border border-border bg-bg-surface p-6 shadow-card"
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1"
        style={{ background: index === 0 ? GRADIENT.violetCyan : categoricalVar(card.colorIndex) }}
      />

      <div className="flex items-center gap-2">
        {/* A real checkbox. Selection is a tick, never a background tint (FRONTEND §8). */}
        <label className="flex shrink-0 items-center gap-2 text-micro text-text-muted">
          <input
            type="checkbox"
            data-testid={`project-card-tick-${String(card.projectId)}`}
            checked={ticked}
            onChange={onTick}
            aria-label={`Select ${card.displayName}`}
            className="size-4"
            style={{ accentColor: 'var(--accent)' }}
          />
        </label>
        <button
          type="button"
          onClick={onOpen}
          data-testid="project-card-open"
          // §3.3, §7.8/P-33 — a lone project's encoded name is an absolute personal path
          // (username, home dir). It is the identity, so it disambiguates two folders that share
          // a display name, but only on hover (title), never as visible text that a screenshot
          // could leak. The display name is the only project string that may be rendered.
          title={card.encodedName ?? undefined}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Badge colorIndex={card.colorIndex}>{card.displayName}</Badge>
          {/* ADR-040 — a group has no folder of its own, so it says how many it stands for.
              A lone project shows nothing here: its encoded name lives in the button's title. */}
          {card.encodedName === null && (
            <span className="ml-auto truncate font-mono text-micro text-text-faint">
              {`${String(card.members.length)} folders`}
            </span>
          )}
        </button>
      </div>
      {grouped && (
        <p data-testid="project-card-grouped" className="mt-2 text-micro text-text-muted">
          You said these {String(card.members.length)} folders are the same project. Open the card
          to see them.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3">
        <Metric label="Sessions" value={formatInteger(card.sessions)} />
        <Metric label="Output" value={formatInteger(card.outputTokens)} />
        <Metric label="Tool calls" value={formatInteger(card.toolCalls)} />
        {/* M-07 binding (C) for one project. No overlap disclosure: INV-22(d) proves it is 0. */}
        <Metric
          label="Active"
          value={formatDuration(card.activeSeconds)}
          note={
            idleGapMinutes === null
              ? 'summed per day'
              : `idle gaps >${String(idleGapMinutes)}m removed`
          }
        />
      </dl>

      <div className="mt-4 flex flex-col gap-1">
        <p className="text-micro uppercase text-text-muted">Edits</p>
        <EditSparkline buckets={card.editSparkline} colorIndex={card.colorIndex} />
      </div>

      {/*
        §6.8 / §6.12 / §1a — the card's `$`, labelled and captioned like every other money surface.
        Before this it was a bare `formatCost(...)` with no label at all, sitting under a sparkline
        among four labelled siblings: a number with no answer to "what is this".

        ⚠️ **Why the `Metric` shape and not `costDisclosureBlock`.** The block is three-to-five
        lines; repeated across a 3-column grid of cards it would be more caveat than card, and §6.8
        loading promises "skeleton cards at final height". So the card takes the lightest treatment
        that still answers the question *on the card*: the same `<dt>/<dd>` label its siblings use,
        plus the STANDING list-price line in the `note` slot the Active metric already uses. That
        line is the only one that is unconditionally true, so it is the only one that has to be on
        every card. The data-dependent lines are not dropped — the uncosted line renders once
        beneath the grid (above), and the full block renders in the detail drawer a card click
        opens, which is one click and no screen away.

        ⚠️ Rendered in EVERY state, `—` when nothing is costed (§6.4: no `$` at all, never `$0.00`),
        so the caveat cannot disappear with the data and the card cannot change height.
      */}
      <dl className="mt-4">
        <Metric
          label="Cost"
          value={card.costNanoUsd === null ? '—' : formatCost(card.costNanoUsd)}
          note={<ListPriceLine />}
          testId="project-card-cost"
        />
      </dl>
    </section>
  );
}

/**
 * One labelled figure on a card. `note` is a `ReactNode` rather than a `string` so the Cost metric
 * can put the shared `ListPriceLine` element in the same slot the Active metric puts its idle-gap
 * sentence in — one caption slot, one style, whatever the caption happens to be (§6.12).
 *
 * ⚠️ It renders a `<dt>/<dd>` pair, so every caller must sit inside a `<dl>`. The Cost metric is
 * wrapped in its own `<dl>` because §6.8 fixes the stat grid at a 2×2 and a fifth cell would leave
 * a dangling half-row.
 */
function Metric({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <div>
      <dt className="text-micro uppercase text-text-muted">{label}</dt>
      <dd className="text-h3 font-bold text-text-primary" data-testid={testId}>
        {value}
      </dd>
      {note !== undefined && <dd className="text-micro text-text-faint">{note}</dd>}
    </div>
  );
}

/** §6.8 loading row — "Skeleton cards at final height." */
function CardSkeletons(): JSX.Element {
  return (
    <div
      className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3"
      data-testid="project-card-skeletons"
    >
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-card border border-border bg-bg-surface shadow-card">
          <LoadingState lines={5} label="Loading projects" />
        </div>
      ))}
    </div>
  );
}

/**
 * §6.8 — the "these are the same project" action bar.
 *
 * ⚠️ Plain language only (§1a). The button says what it does in the user's own words; nowhere on
 * this bar is there a "merge", an "entity", a metric id or a section number.
 * ⚠️ It appears only once the user has ticked two or more cards. It never appears on its own
 * initiative and it never proposes a pairing — §2.1's zero-inference rule.
 */
function SameProjectBar({
  ticked,
  folders,
  naming,
  name,
  saving,
  error,
  onStart,
  onCancel,
  onName,
  onSave,
  onClear,
}: {
  ticked: number;
  folders: number;
  naming: boolean;
  name: string;
  saving: boolean;
  error: AppError | null;
  onStart: () => void;
  onCancel: () => void;
  onName: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
}): JSX.Element | null {
  if (ticked === 0) return null;
  return (
    <section
      data-testid="same-project-bar"
      className="flex flex-col gap-2 rounded-card border border-border bg-bg-surface p-4 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-small text-text-primary">
          {ticked === 1
            ? '1 project selected. Pick another one to say they are the same project.'
            : `${String(ticked)} projects selected (${String(folders)} folders).`}
        </p>
        {!naming && ticked >= 2 && (
          <button
            type="button"
            data-testid="same-project-start"
            onClick={onStart}
            className="rounded-control border border-border px-3 py-1 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2"
          >
            These are the same project
          </button>
        )}
        <button
          type="button"
          data-testid="same-project-clear"
          onClick={onClear}
          className="ml-auto rounded-control px-2 py-1 text-micro text-text-muted transition-colors duration-hover hover:bg-bg-surface-2"
        >
          Clear selection
        </button>
      </div>

      {naming && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-small text-text-muted" htmlFor="group-name">
            What should this project be called?
            <input
              id="group-name"
              data-testid="same-project-name"
              value={name}
              autoFocus
              onChange={(event) => {
                onName(event.target.value);
              }}
              className="rounded-control border border-border bg-bg-surface-2 px-3 py-2 text-small text-text-primary"
            />
          </label>
          <p className="text-micro text-text-faint">
            From now on these folders count as one project everywhere. The folders themselves stay
            exactly as they are, and you can split them apart again at any time in Settings.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="same-project-save"
              disabled={saving || name.trim().length === 0}
              onClick={onSave}
              className="rounded-control border border-border px-3 py-1 text-small text-text-primary transition-colors duration-hover hover:bg-bg-surface-2 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              data-testid="same-project-cancel"
              onClick={onCancel}
              className="rounded-control px-3 py-1 text-small text-text-muted transition-colors duration-hover hover:bg-bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* The failure is stated where the action was taken, in the words the main process chose. */}
      {error !== null && (
        <p data-testid="same-project-error" className="text-small text-danger">
          {error.message}
        </p>
      )}
    </section>
  );
}
