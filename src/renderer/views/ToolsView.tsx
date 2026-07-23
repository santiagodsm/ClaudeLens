/**
 * Tools & Agents — `view-tools` (DESIGN §6.6).
 *
 * ⚠️ **`Agent` and `Skill` ARE tools** (§2.1, M-12: "Tool calls … **Includes `Agent` and
 * `Skill`**"). The fingerprint card says so in its own subtitle rather than leaving a reader to
 * wonder why "Agent" is in a list of tools — the alternative reading, that agents are missing
 * from the count, would make the total look wrong.
 *
 * ⚠️ **The unlinked-runs footnote states that totals are unaffected, and that is part of the
 * disclosure, not a reassurance bolted on** (§6.6, §3.7): a subagent run whose spawn point could
 * not be identified still has all of its events, attributed to the parent session by path
 * (ADR-020). The link is a graph edge, not an accounting relationship.
 */

import type { JSX } from 'react';
import { ChartCard } from '../components/ChartCard';
import { useQuery } from '../hooks/use-query';
import { formatInteger } from '../lib/format';
import { useAppStore } from '../store/app-store';
import { ViewShell } from '../shell/ViewShell';
import { GradientBars } from './charts/GradientBars';
import { OriginDonut, unlinkedRunsFootnote } from './charts/OriginDonut';
import { StackedPill } from './charts/StackedPill';

/** §6.6 — "small multiples, one stacked pill per project". Top tools per project. */
const TOOL_MIX_TOP_N = 6;

/** §6.6's empty copy, verbatim. */
export const TOOLS_EMPTY_REASON = 'No tool calls in this range.';

/** §2.1 / M-12, stated on the surface because the count depends on it. */
export const AGENT_AND_SKILL_NOTE = 'Agent and Skill are tools, and are counted here.';

export function ToolsView(): JSX.Element {
  const filter = useAppStore((state) => state.filter);

  const fingerprint = useQuery('q:toolFingerprint', filter);
  const origin = useQuery('q:originSplit', filter);
  const mix = useQuery('q:toolMixByProject', { ...filter, topN: TOOL_MIX_TOP_N });

  return (
    <ViewShell
      id="tools"
      secondary={
        <ChartCard
          title="Tool mix per project"
          subtitle={`Top ${String(TOOL_MIX_TOP_N)} tools per project, as a share of that project's calls`}
          className="col-span-12"
          index={2}
          loading={mix.loading && mix.data === null}
          error={mix.error}
          empty={mix.data !== null && mix.data.projects.length === 0}
          emptyReason={TOOLS_EMPTY_REASON}
          onRetry={mix.refetch}
          data-testid="tools-mix"
        >
          {mix.data !== null && mix.data.projects.length > 0 ? (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
              {mix.data.projects.map((project) => (
                <StackedPill
                  key={project.projectId}
                  label={project.displayName}
                  parts={project.parts}
                />
              ))}
            </div>
          ) : undefined}
        </ChartCard>
      }
    >
      <div className="grid grid-cols-12" style={{ gap: 'var(--grid-gutter)' }}>
        <ChartCard
          title="Tool fingerprint"
          subtitle={
            fingerprint.data === null
              ? AGENT_AND_SKILL_NOTE
              : `${formatInteger(fingerprint.data.total)} calls · ${formatInteger(fingerprint.data.distinct)} distinct tools · ${AGENT_AND_SKILL_NOTE}`
          }
          className="col-span-12 xl:col-span-7"
          index={0}
          loading={fingerprint.loading && fingerprint.data === null}
          error={fingerprint.error}
          empty={fingerprint.data !== null && fingerprint.data.rows.length === 0}
          emptyReason={TOOLS_EMPTY_REASON}
          onRetry={fingerprint.refetch}
          data-testid="tools-fingerprint"
        >
          {fingerprint.data !== null && fingerprint.data.rows.length > 0 ? (
            <GradientBars
              label="Tool calls by tool"
              rows={fingerprint.data.rows.map((row) => ({
                id: row.toolName,
                label: row.toolName,
                trailing: formatInteger(row.count),
                value: row.count,
                colorIndex: row.colorIndex,
              }))}
            />
          ) : undefined}
        </ChartCard>

        <ChartCard
          title="Main loop vs subagents"
          subtitle="Share of output tokens each side produced, with the subagent total shown in the centre"
          className="col-span-12 xl:col-span-5"
          index={1}
          loading={origin.loading && origin.data === null}
          error={origin.error}
          onRetry={origin.refetch}
          // §6.6 degraded — "⚠️ Totals genuinely are unaffected, and saying so is part of the
          // disclosure." Rendered beside the number, never in a tooltip (§6.12).
          disclosure={
            origin.data === null
              ? undefined
              : (unlinkedRunsFootnote(origin.data.unlinkedRuns) ?? undefined)
          }
          data-testid="tools-origin-split"
        >
          {origin.data !== null ? <OriginDonut split={origin.data} /> : undefined}
        </ChartCard>
      </div>
    </ViewShell>
  );
}
