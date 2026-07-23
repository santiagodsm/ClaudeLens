/**
 * Payload factories for the six analytics-view suites (E8/E9).
 *
 * ⚠️ **These are hand-written §4.5 payloads, not fixtures and not snapshots.** The views are
 * tested against the contract's shapes with values chosen to make a rule visible — a `null`
 * cost, a non-zero `overlapSeconds`, an `UncostedSummary` with records — because what these
 * suites assert is the *presentation rule*, and a rule is only observable when the condition
 * that triggers it is present in the payload.
 *
 * Every factory takes overrides so a test can state the one field it is about.
 */

import type {
  ActivityCalendar,
  CacheEfficiency,
  CostBreakdown,
  FileMetricRow,
  ModelTimeline,
  ObservedModelRow,
  OriginSplit,
  Paged,
  OverviewTiles,
  PriceRow,
  ProjectCard,
  ProjectCards,
  RhythmHeatmap,
  SessionDetail,
  SessionHistogram,
  SessionRow,
  SessionsPage,
  ToolFingerprint,
  ToolMixByProject,
  TokenBreakdown,
  TokensByProject,
  UncostedSummary,
  WorkingDayRow,
} from '../../../src/shared/ipc-contract';

/** A fixed instant, so a formatted date is a property of the value and not of the clock. */
export const T0 = Date.UTC(2026, 2, 2, 9, 0, 0);
const HOUR = 3_600_000;

export const NO_UNCOSTED: UncostedSummary = { records: 0, byModel: [] };

export function uncosted(records = 3): UncostedSummary {
  return {
    records,
    byModel: [{ model: 'claude-test-1', records, fromTs: T0, toTs: T0 + 24 * HOUR }],
  };
}

export function tokens(overrides: Partial<TokenBreakdown> = {}): TokenBreakdown {
  // A-05 — five classes. `cacheWrite` is the 5-minute one, `cacheWrite1h` the 1-hour one.
  return {
    input: 1000,
    output: 2000,
    cacheWrite: 300,
    cacheWrite1h: 120,
    cacheRead: 40_000,
    ...overrides,
  };
}

export function overviewTiles(overrides: Partial<OverviewTiles> = {}): OverviewTiles {
  return {
    outputTokens: 1_234_567,
    costNanoUsd: 12_340_000_000, // $12.34
    activeSeconds: 77_820, // 21h 37m
    toolCalls: 4_321,
    sessions: 42,
    cacheReadTokens: 9_000_000,
    distinctTools: 11,
    uncosted: NO_UNCOSTED,
    overlapSeconds: 0,
    ...overrides,
  };
}

export function activityCalendar(days = 12): ActivityCalendar {
  return {
    days: Array.from({ length: days }, (_unused, index) => ({
      day: `2026-03-${String(index + 1).padStart(2, '0')}`,
      messages: (index + 1) * 3,
    })),
  };
}

export function modelTimeline(overrides: Partial<ModelTimeline> = {}): ModelTimeline {
  return {
    buckets: ['2026-02-23', '2026-03-02', '2026-03-09'],
    series: [
      { model: 'claude-test-1', colorIndex: 0, data: [10, 20, 30] },
      { model: 'claude-test-2', colorIndex: 3, data: [5, 6, 7] },
    ],
    ...overrides,
  };
}

export function cacheEfficiency(overrides: Partial<CacheEfficiency> = {}): CacheEfficiency {
  return {
    cacheReadTokens: 40_000,
    inputTokens: 10_000,
    cacheWriteTokens: 2_000,
    outputTokens: 3_000,
    hitRatio: 0.8,
    ...overrides,
  };
}

export function tokensByProject(overrides: Partial<TokensByProject> = {}): TokensByProject {
  return {
    rows: [
      {
        projectId: 1,
        displayName: 'demo-alpha',
        colorIndex: 0,
        outputTokens: 900_000,
        costNanoUsd: 9_000_000_000,
      },
      {
        projectId: 2,
        displayName: 'demo-beta',
        colorIndex: 2,
        outputTokens: 300_000,
        costNanoUsd: null,
      },
    ],
    uncosted: NO_UNCOSTED,
    ...overrides,
  };
}

export function costBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    rows: [
      { key: 'claude-test-1', costNanoUsd: 10_000_000_000, tokensByClass: tokens() },
      { key: 'claude-test-2', costNanoUsd: 2_340_000_000, tokensByClass: tokens() },
    ],
    uncosted: NO_UNCOSTED,
    ...overrides,
  };
}

export function originSplit(overrides: Partial<OriginSplit> = {}): OriginSplit {
  return {
    main: { ...tokens({ output: 28_000 }), messages: 120, toolCalls: 300 },
    subagent: { ...tokens({ output: 72_000 }), messages: 60, toolCalls: 140 },
    unlinkedRuns: 0,
    ...overrides,
  };
}

export function sessionHistogram(counts = [3, 7, 4, 1, 0, 0]): SessionHistogram {
  const labels = ['<5m', '5–15m', '15–30m', '30–60m', '1–2h', '2h+'];
  return {
    buckets: labels.map((label, index) => ({
      label,
      lowerSeconds: index * 300,
      upperSeconds: index === labels.length - 1 ? null : (index + 1) * 300,
      count: counts[index] ?? 0,
    })),
  };
}

export function rhythmHeatmap(): RhythmHeatmap {
  return {
    cells: [
      { weekday: 1, hour: 9, events: 40 },
      { weekday: 1, hour: 10, events: 25 },
      { weekday: 3, hour: 14, events: 60 },
    ],
  };
}

export function workingDays(rows = 3): Paged<WorkingDayRow> {
  return {
    rows: Array.from({ length: rows }, (_unused, index) => ({
      day: `2026-03-${String(index + 1).padStart(2, '0')}`,
      projectId: index + 1,
      displayName: `demo-${String(index + 1)}`,
      colorIndex: index,
      activeSeconds: 30_000 - index * 5_000,
      spanSeconds: 40_000 - index * 5_000,
      sessions: 2,
    })),
    nextCursor: null,
    totalKnown: rows,
  };
}

export function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-0000-1111',
    projectId: 1,
    displayName: 'demo-alpha',
    colorIndex: 0,
    primaryModel: 'claude-test-1',
    firstTs: T0,
    lastTs: T0 + 2 * HOUR,
    spanSeconds: 7_200,
    activeSeconds: 5_400,
    messages: 24,
    toolCalls: 40,
    subagentRuns: 2,
    tokens: tokens(),
    costNanoUsd: 1_500_000_000,
    isPartial: false,
    // §4.5 (amended E9) — `null`/`null` is a LIVE session. A fixture that defaulted these to a
    // value would make the §6.5 "archived" badge render everywhere and prove nothing.
    archiveId: null,
    archiveRoot: null,
    ...overrides,
  };
}

export function sessionsPage(overrides: Partial<SessionsPage> = {}): SessionsPage {
  return {
    page: {
      rows: [
        sessionRow(),
        sessionRow({ id: 'sess-2222-3333', displayName: 'demo-beta', colorIndex: 2, messages: 8 }),
      ],
      nextCursor: null,
      totalKnown: 42,
    },
    uncosted: NO_UNCOSTED,
    ...overrides,
  };
}

export function sessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  const row = sessionRow();
  return {
    ...row,
    gitBranch: 'main',
    cliVersion: '1.0.0',
    originSplit: { main: tokens(), subagent: tokens({ output: 500 }) },
    toolCounts: [
      { toolName: 'Read', count: 20 },
      { toolName: 'Agent', count: 3 },
    ],
    subagentRuns: [
      {
        id: 1,
        subagentType: 'reviewer',
        description: null,
        firstTs: T0,
        lastTs: T0 + HOUR,
        linked: true,
        tokens: tokens(),
      },
      {
        id: 2,
        subagentType: null,
        description: null,
        firstTs: T0,
        lastTs: T0 + HOUR,
        linked: false,
        tokens: tokens(),
      },
    ],
    uncosted: NO_UNCOSTED,
    ...overrides,
  };
}

export function toolFingerprint(overrides: Partial<ToolFingerprint> = {}): ToolFingerprint {
  return {
    total: 500,
    distinct: 6,
    rows: [
      { toolName: 'Read', count: 220, colorIndex: 0 },
      { toolName: 'Edit', count: 140, colorIndex: 1 },
      { toolName: 'Agent', count: 90, colorIndex: 2 },
      { toolName: 'Skill', count: 50, colorIndex: 3 },
    ],
    ...overrides,
  };
}

export function toolMixByProject(overrides: Partial<ToolMixByProject> = {}): ToolMixByProject {
  return {
    projects: [
      {
        projectId: 1,
        displayName: 'demo-alpha',
        parts: [
          { toolName: 'Read', count: 60, colorIndex: 0 },
          { toolName: 'Edit', count: 40, colorIndex: 1 },
        ],
      },
    ],
    ...overrides,
  };
}

export function projectCard(overrides: Partial<ProjectCard> = {}): ProjectCard {
  return {
    projectId: 1,
    displayName: 'demo-alpha',
    encodedName: '-work-demo-alpha',
    colorIndex: 0,
    sessions: 12,
    outputTokens: 450_000,
    costNanoUsd: 4_500_000_000,
    toolCalls: 300,
    activeSeconds: 36_000,
    editSparkline: [1, 2, 0, 4, 3, 5, 0, 2, 6, 1, 0, 3],
    // ADR-040 — an ungrouped project is its own single-folder unit.
    groupId: null,
    members: [
      {
        projectId: 1,
        displayName: 'demo-alpha',
        encodedName: '-work-demo-alpha',
        colorIndex: 0,
        outputTokens: 450_000,
        sessions: 12,
        toolCalls: 300,
        activeSeconds: 36_000,
      },
    ],
    ...overrides,
  };
}

export function projectCards(overrides: Partial<ProjectCards> = {}): ProjectCards {
  return { rows: [projectCard()], uncosted: NO_UNCOSTED, ...overrides };
}

export function fileMetrics(): Paged<FileMetricRow> {
  return {
    rows: [
      {
        path: 'src/index.ts',
        basename: 'index.ts',
        language: 'TypeScript',
        edits: 12,
        lastTs: T0,
      },
      { path: 'notes.txt', basename: 'notes.txt', language: null, edits: 2, lastTs: T0 },
    ],
    nextCursor: null,
    totalKnown: 2,
  };
}

export function priceRows(): PriceRow[] {
  return [
    {
      id: 1,
      model: 'claude-test-1',
      tokenClass: 'output',
      usdPerMillion: 75,
      validFrom: T0,
      validTo: null,
      source: 'seed',
      sourceUrl: null,
      note: null,
    },
  ];
}

export function observedModels(): ObservedModelRow[] {
  return [
    { model: 'claude-test-1', events: 400, firstTs: T0, lastTs: T0 + HOUR, priced: true },
    { model: 'claude-test-2', events: 12, firstTs: T0, lastTs: T0 + HOUR, priced: false },
  ];
}
