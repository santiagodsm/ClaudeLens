/**
 * The `useQuery`-style hook every view gets its four states from (§6.12: loading, empty, error
 * and offline are specified for every view — "a view that renders zero where it does not know
 * is a defect, not a style choice").
 *
 * §7.4 in one hook: a query result is keyed by `(channel, args)`, lives for exactly as long as
 * the component that asked for it, and is invalidated by `evt:dataChanged` scopes. There is no
 * cache, no store of domain data and no background refetch — which is how P-28 ("never more
 * than 5,000 rows of any single result set, and never the full dataset") stays structural.
 *
 * ⚠️ **`data` is `null` until a real payload arrives, and goes back to `null` on error.** There
 * is no `initialData`, no `placeholderData`, no `select` default. Every one of those is a
 * mechanism for showing a number the main process did not produce (CLAUDE.md §1).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppError, IpcChannel, IpcRequest, IpcResponse } from '../../shared/ipc-contract';
import { invokeWith } from '../lib/ipc';
import { scopesFor } from '../lib/query-scopes';
import { useAppStore } from '../store/app-store';

export interface QueryState<T> {
  /**
   * A request is in flight. ⚠️ `loading === true` with `data !== null` is a **refresh in
   * place**: the view keeps rendering the numbers it has and must NOT swap in a skeleton.
   * §6.2's peripheral-vision rule — "number updates are in-place with no entrance animation" —
   * is that sentence.
   */
  loading: boolean;
  data: T | null;
  error: AppError | null;
  /** Explicit re-query. Wired to the ErrorState retry button; never called automatically. */
  refetch: () => void;
}

/**
 * Deterministic key for `(channel, args)`. Object keys are sorted so that two structurally
 * equal requests produce one key regardless of literal order, which is what stops a re-render
 * with a freshly-built request object from re-firing the query.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

export interface QueryOptions {
  /**
   * `false` parks the query without firing it — used while `dirStatus === 'unset'` (§6.2
   * onboarding) and for drill-downs whose id is not chosen yet. A disabled query is not
   * loading and has no data; it is not an error either.
   */
  enabled?: boolean;
}

/** One settled answer, tagged with the key it answers, so a stale reply cannot be mistaken. */
interface Settled<T> {
  key: string;
  data: T | null;
  error: AppError | null;
}

export function useQuery<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
  options: QueryOptions = {},
): QueryState<IpcResponse<C>> {
  const enabled = options.enabled ?? true;
  const serialized = stableStringify(request);

  // §7.4 — the invalidation signal. Summing the epochs of the scopes this channel depends on
  // gives one primitive that changes exactly when a relevant `evt:dataChanged` arrives.
  const scopes = useMemo(() => scopesFor(channel), [channel]);
  const epoch = useAppStore((state) =>
    scopes.reduce((total, scope) => total + state.epochs[scope], 0),
  );

  const [nonce, setNonce] = useState(0);
  const key = `${channel}|${serialized}|${String(epoch)}|${String(nonce)}`;

  const [settled, setSettled] = useState<Settled<IpcResponse<C>> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // Round-tripping through the cache key rather than closing over `request` is what keeps
    // `react-hooks/exhaustive-deps` honest: the effect depends on the key, and the key is the
    // request. Every request type in §4 is JSON by construction — it crosses IPC.
    const parsed = serialized === '' ? undefined : (JSON.parse(serialized) as IpcRequest<C>);

    void invokeWith(channel, parsed).then((result) => {
      if (cancelled) return;
      // ⚠️ Data is dropped on error rather than left stale. A number kept on screen after the
      // query that produced it failed is a number nothing is standing behind.
      setSettled(
        result.ok
          ? { key, data: result.data, error: null }
          : { key, data: null, error: result.error },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [channel, serialized, enabled, key]);

  const refetch = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  // `loading` is DERIVED, not stored: a request is in flight exactly when the settled answer
  // does not answer the current key. That is also what keeps the previous payload on screen
  // during a refresh — `data` reads from `settled` regardless of whether its key is current.
  const current = settled !== null && settled.key === key;
  return {
    loading: enabled && !current,
    data: enabled ? (settled?.data ?? null) : null,
    error: enabled && current ? settled.error : null,
    refetch,
  };
}
