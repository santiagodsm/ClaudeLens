// ⚠️⚠️ THE ONLY OUTBOUND CALL IN THE ENTIRE APPLICATION. ⚠️⚠️
//
// DESIGN §7.5, INV-15, STACK ADR-015. `eslint.config.js` bans `fetch`, `XMLHttpRequest`,
// `WebSocket`, `EventSource`, `node:http(s)`, `node:net`, `node:tls`, `node:dgram`, `axios`,
// `undici` and `node-fetch` across the whole repository, with a single-file allowlist override
// for exactly this path. That override turns off `no-restricted-globals` HERE AND NOWHERE ELSE.
//
// If you are about to add a network call to another file: stop. "A second egress point is a PRD
// change, not a config change" (STACK ADR-015). No telemetry, no analytics, no crash reporting,
// no update check, no remote font, no remote asset (§7.5).
//
// Implements SM-6's FETCHING → VALIDATING transition (§5.8). The rules, verbatim:
//
//   1. ⚠️ ONLY THE USER STARTS THIS. No fetch on launch, on a timer, on a cache miss, or on a
//      price gap. This module exports a plain async function and registers nothing — no
//      `setInterval`, no `app.whenReady` hook, no lazy-load-on-miss. The only caller is the
//      `pricing:fetch` handler, which is the Refresh button (§6.10 card 5).
//   2. ONE request, 10 s timeout, NO RETRY, no redirect chain beyond 3 hops, `GET` only (P-26).
//   3. ⚠️ ANY FAILURE LEAVES `price_rows` BYTE-IDENTICAL. This module never touches the database
//      — it has no database in scope, by construction. It returns a fully validated document or
//      throws; the caller only opens a write transaction on success (§5.8 rule 3).
//
// `E_FETCH_NO_URL` when `priceFetchUrl` is empty — and note that it SHIPS EMPTY BY DECISION
// (§3.13, §6.10, §11.3 closed). That is the NORMAL case on a fresh clone, not an error state: the
// button is disabled, the help text explains why, and the bundled seed is the guaranteed-correct
// path. It is an error only because the user asked for something that is not configured.

import { PricingError } from './errors';
import { parsePriceDocument, type ValidatedPriceDocument } from './price-document';

/** SM-6 rule 2 — one request, ten seconds, then stop. */
export const FETCH_TIMEOUT_MS = 10_000;

/** SM-6 rule 2 — "no redirect chain beyond 3 hops". Counted as redirect responses followed. */
export const MAX_REDIRECTS = 3;

/**
 * A price document is a small JSON file. A body far larger than that is not one, and reading it
 * unbounded would let a misconfigured URL pull an arbitrary amount of memory into the main
 * process — the one place this application is exposed to a remote party.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The `fetch` surface this module needs. Injected in tests so no test performs real network I/O. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchPriceTableOptions {
  /** Defaults to the global `fetch`. Tests pass a stub; there is no other production value. */
  readonly fetchImpl?: FetchImpl | undefined;
  readonly timeoutMs?: number | undefined;
}

function networkError(cause: unknown, url: string): PricingError {
  // §6.10's "Offline" row: this is the only place offline is visible. It fails inline, leaves the
  // price table completely intact, and every other control keeps working.
  return new PricingError(
    'E_FETCH_NETWORK',
    'Could not reach the price-table URL. Your existing prices are unchanged.',
    {
      cause,
      // §4.1: retryable means "the same call may succeed if repeated unchanged" — true of a
      // network blip. ⚠️ It does NOT mean this module retries: SM-6 rule 2 says no retry, and
      // §4.1 rule 3 forbids any caller retrying automatically. It is the user's button.
      retryable: true,
      detail: `${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
    },
  );
}

/** Only `http`/`https` — anything else is a setting the user must fix, not a network failure. */
function requireHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (cause) {
    throw new PricingError('E_INVALID_SETTING', 'That price-table URL is not a valid URL.', {
      cause,
      detail: rawUrl,
    });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PricingError('E_INVALID_SETTING', 'A price-table URL must be http or https.', {
      detail: `${rawUrl} uses ${parsed.protocol}`,
    });
  }
  return parsed;
}

/**
 * SM-6 (§5.8): FETCHING → VALIDATING. Returns a fully validated, fully converted document, or
 * throws a `PricingError` carrying its §4.1 code. **Writes nothing, ever.**
 *
 * @param url `settings.priceFetchUrl` (§3.13). Empty ⇒ `E_FETCH_NO_URL`.
 */
export async function fetchPriceTable(
  url: string,
  options: FetchPriceTableOptions = {},
): Promise<ValidatedPriceDocument> {
  if (url.trim() === '') {
    throw new PricingError(
      'E_FETCH_NO_URL',
      'Set a price-table URL in Settings to enable fetching.',
      {
        detail:
          'priceFetchUrl ships empty by decision (§11.3, closed): no third-party trust is baked ' +
          'into a published repo. The bundled seed plus manual editing is the guaranteed path.',
      },
    );
  }

  const doFetch: FetchImpl = options.fetchImpl ?? ((target, init) => fetch(target, init));
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  // ⚠️ ONE AbortSignal for the WHOLE operation, redirects included. A per-hop timeout would let a
  // 3-hop chain take 3× the budget; §5.8 rule 2 is a wall-clock bound on the request, not on each
  // leg of it.
  const signal = AbortSignal.timeout(timeoutMs);

  let target = requireHttpUrl(url).toString();
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      response = await doFetch(target, {
        method: 'GET', // P-26: GET only. Nothing is ever sent anywhere.
        // `manual` rather than `follow`: the platform default follows up to 20 hops, and SM-6
        // caps the chain at 3. Following it ourselves is the only way to enforce the cap.
        redirect: 'manual',
        signal,
        headers: { accept: 'application/json' },
        // No credentials, no cookies, no cache. Nothing about this user leaves the machine.
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (cause) {
      if (signal.aborted) {
        throw new PricingError(
          'E_FETCH_TIMEOUT',
          `The price-table request took longer than ${String(Math.round(timeoutMs / 1000))} seconds.`,
          { cause, retryable: true, detail: target },
        );
      }
      throw networkError(cause, target);
    }

    if (response.status < 300 || response.status >= 400) break;

    const location = response.headers.get('location');
    if (location === null || location === '') {
      throw new PricingError(
        'E_FETCH_HTTP',
        `The price-table URL returned a ${String(response.status)} with no destination.`,
        { detail: `${target} → HTTP ${String(response.status)}, no Location header` },
      );
    }
    if (hop === MAX_REDIRECTS) {
      throw new PricingError('E_FETCH_HTTP', 'The price-table URL redirected too many times.', {
        detail: `${url}: more than ${String(MAX_REDIRECTS)} redirects (§5.8 rule 2)`,
      });
    }
    target = requireHttpUrl(new URL(location, target).toString()).toString();
  }

  if (response === undefined) {
    throw networkError(new Error('no response'), target);
  }

  if (!response.ok) {
    throw new PricingError(
      'E_FETCH_HTTP',
      `The price-table URL returned HTTP ${String(response.status)}. Your existing prices are unchanged.`,
      { retryable: response.status >= 500, detail: `${target} → HTTP ${String(response.status)}` },
    );
  }

  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    if (signal.aborted) {
      throw new PricingError(
        'E_FETCH_TIMEOUT',
        'The price-table response did not finish in time.',
        {
          cause,
          retryable: true,
          detail: target,
        },
      );
    }
    throw networkError(cause, target);
  }

  if (body.length > MAX_BODY_BYTES) {
    throw new PricingError('E_FETCH_SHAPE', 'That document is far too large to be a price table.', {
      detail: `${target}: ${String(body.length)} chars exceeds ${String(MAX_BODY_BYTES)}`,
    });
  }

  // ⚠️ VALIDATION COMPLETES IN FULL BEFORE A SINGLE WRITE (§5.8 rule 3). This throws on anything
  // that is not a §4.7 document — including LiteLLM's `model_prices_and_context_window.json`,
  // which §6.10 offers as help text and §11.3 explicitly leaves unadapted in v1: "a raw fetch of
  // it fails cleanly with `E_FETCH_SHAPE`, leaving the price table intact."
  return parsePriceDocument(body);
}
