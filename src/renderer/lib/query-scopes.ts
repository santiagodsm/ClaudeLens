/**
 * §7.4 / §4.9 — which `evt:dataChanged` scopes invalidate which query.
 *
 * "Everything else is query results keyed by `(channel, args)` and invalidated by
 * `evt:dataChanged` scopes." This table is the second half of that sentence. It is a table and
 * not a heuristic on the channel name, because a wrong guess here shows a stale number after a
 * sync — and a stale number is a wrong number.
 *
 * ⛔ The four INV-13 channels (`q:skills`, `q:claudeMdFiles`, `q:plugins`, `q:memories`) and
 * `q:harnessGraph` are keyed to `harness`, not to `events`: they ignore the global filter and
 * are computed over the full dataset, so an events-only change does not move them.
 */

import type { DataScope, IpcChannel } from '../../shared/ipc-contract';

/** Every scope — used by the handful of channels that read from most of the schema. */
const ALL: DataScope[] = ['events', 'sessions', 'projects', 'tools', 'prompts', 'harness', 'bloat'];

const SCOPES: Partial<Record<IpcChannel, DataScope[]>> = {
  'app:bootstrap': ALL,
  'q:overviewTiles': ['events', 'sessions', 'projects', 'tools'],
  'q:activityCalendar': ['events'],
  'q:modelMixTimeline': ['events'],
  'q:tokensByModel': ['events'],
  'q:tokensByProject': ['events', 'projects'],
  'q:cacheEfficiency': ['events'],
  'q:costBreakdown': ['events', 'projects'],
  'q:sessionHistogram': ['sessions', 'events'],
  'q:rhythmHeatmap': ['events'],
  'q:workingDays': ['sessions', 'events', 'projects'],
  'q:sessions': ['sessions', 'events'],
  'q:sessionDetail': ['sessions', 'events', 'tools'],
  'q:toolFingerprint': ['tools'],
  'q:originSplit': ['events'],
  'q:toolMixByProject': ['tools', 'projects'],
  'q:projectCards': ['projects', 'events', 'sessions'],
  'q:fileMetrics': ['tools', 'projects'],
  // ADR-040 — grouping changes what a project IS, so every group mutation announces `projects`
  // and every project-shaped query above already listens for it.
  'groups:list': ['projects'],
  'q:harnessGraph': ['harness'],
  'q:executionTrace': ['sessions', 'events', 'tools'],
  'q:toolTransition': ['tools'],
  'q:flowSankey': ['tools', 'events'],
  'q:skills': ['harness', 'tools'],
  'q:claudeMdFiles': ['harness'],
  'q:plugins': ['harness'],
  'q:memories': ['harness'],
  'q:disclosures': ALL,
  'q:uncosted': ['events'],
  'bloat:list': ['bloat', 'harness'],
  'audit:list': [],
  'backups:summary': [],
  'archives:list': [],
};

/**
 * The scopes a channel is sensitive to. An unmapped channel returns every scope: erring toward
 * re-querying is cheap (§8.3 budgets a query at 200 ms) and erring toward not re-querying shows
 * a stale number.
 */
export function scopesFor(channel: IpcChannel): DataScope[] {
  return SCOPES[channel] ?? ALL;
}
