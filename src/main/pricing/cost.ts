// M-05 (Cost) and M-06 (Uncosted summary) — DESIGN §5.9, §4.6, INV-09/10/11, ADR-023/024/025.
//
// ⚠️ THE RULE THAT MATTERS MOST (M-05, INV-09):
//
//   "An event is costed ONLY IF EVERY token class with a non-zero count has a covering price row.
//    Otherwise the ENTIRE event is uncosted and contributes nothing."
//
// No partial costing, ever. ADR-024 gives the reason in the user's terms: "a record priced on
// three of its four classes would produce a number that is confidently wrong rather than honestly
// absent." The all-or-nothing test is implemented once, in SQL, in
// `src/main/db/repositories/cost.ts`, so the `$` figure and the disclosure beside it are computed
// from the same `costed` flag over the same rows and cannot drift apart.
//
// ⚠️ Never zero-fill. Never substitute another model's or another period's rate. Cost keys on the
// EXACT raw `message.model` string — no normalization, no aliasing, no fuzzy matching (ADR-025).
// An unpriced model must be VISIBLE (`pricing:models`, §4.7) and its records disclosed by name and
// date range (M-06), not silently mapped to something that looks similar.
//
// ⚠️ Units. SQL sums in picoUSD. This module converts to nanoUSD ONCE — integer division,
// round-half-up, in BigInt — before the value crosses IPC (§3.11, ADR-023). USD is produced only
// at the presentation edge, by dividing by 1e9, and never here.

import type { GlobalFilter, UncostedSummary } from '../../shared/ipc-contract';
import { assertSafeAggregate, picoToNanoUsd } from '../../shared/money';
import { CostRepository, type CostScope } from '../db/repositories/cost';
import type { SqliteDatabase } from '../db/sqlite';

/**
 * M-05 with its mandatory companion.
 *
 * ⚠️ INV-10: "Every IPC payload containing a `$` figure also contains its `UncostedSummary`."
 * They are returned together, from one call, so it is not possible to obtain the cost without
 * also holding its disclosure. That is the invariant expressed as a type.
 */
export interface CostResult {
  /** M-05, in nanoUSD — the §4 wire unit. `0` here means "the priced events cost nothing". */
  readonly costNanoUsd: number;
  /** How many events contributed to `costNanoUsd`. `0` alongside `uncosted.records > 0` is §6.4's "no pricing configured" state. */
  readonly costedEvents: number;
  /** M-06 / §4.6. `records: 0` means the `$` figure is complete. */
  readonly uncosted: UncostedSummary;
}

function toScope(filter: GlobalFilter): CostScope {
  return { projectIds: filter.projectIds, from: filter.from, to: filter.to };
}

export class CostCalculator {
  readonly #repo: CostRepository;

  constructor(db: SqliteDatabase) {
    this.#repo = new CostRepository(db);
  }

  /**
   * M-05 + M-06 for one scope, in one pass over one definition of "costed".
   *
   * ⚠️ `costNanoUsd` is asserted against `Number.MAX_SAFE_INTEGER` (INV-11) rather than trusted:
   * a value above 2^53−1 does not fail in JavaScript, it ROUNDS, and a plausible wrong total with
   * nothing crashing is the worst possible outcome (CLAUDE.md §1). `picoToNanoUsd` throws on
   * breach and the handler wrapper turns that into `E_INTERNAL`.
   */
  cost(filter: GlobalFilter): CostResult {
    const scope = toScope(filter);
    const totals = this.#repo.totals(scope);
    return {
      costNanoUsd: assertSafeAggregate(picoToNanoUsd(totals.costPicoUsd), 'costNanoUsd'),
      costedEvents: totals.costedEvents,
      uncosted: this.#uncostedFrom(scope, totals.uncostedEvents),
    };
  }

  /** M-06 alone, for §4.6's `q:uncosted`. */
  uncosted(filter: GlobalFilter): UncostedSummary {
    const scope = toScope(filter);
    return this.#uncostedFrom(scope, this.#repo.totals(scope).uncostedEvents);
  }

  #uncostedFrom(scope: CostScope, records: number): UncostedSummary {
    // ⚠️ Incompleteness is DATA in the success payload, never a log line and never an error
    // (§4.1 rule 4, CLAUDE.md §1). `records` comes from the same `costed` flag that produced the
    // total, so `costedEvents + uncosted.records` is exactly the priceable population.
    const byModel = this.#repo.uncostedByModel(scope).map((row) => ({
      model: row.model,
      records: row.records,
      fromTs: row.fromTs,
      toTs: row.toTs,
    }));
    return { records, byModel };
  }
}

// ⚠️ There is deliberately no `nanoUsdToUsd` here. ADR-023: "USD is produced ONCE, at the
// presentation edge, by dividing by 1e9" — and the presentation edge is `src/renderer/**`, which
// may not import `src/main/**` (INV-16). Putting the divide here would either be dead code or an
// invitation to do the conversion twice. `costNanoUsd` is the wire type; the renderer owns the
// last step.
