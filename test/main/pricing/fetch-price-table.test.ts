// SM-6 (§5.8) — the price-refresh lifecycle, and the one rule that makes it safe:
//
//   ⚠️ "ANY FAILURE LEAVES `price_rows` BYTE-IDENTICAL. Validation completes before a single
//    write." (§5.8 rule 3.)
//
// ⚠️⚠️ NO TEST IN THIS FILE PERFORMS REAL NETWORK I/O. Every case injects a `fetchImpl` stub or
// points at a local fixture document. `pnpm run check` must run on a plane (STACK "The check
// command": self-contained-green, "no service, no container, no env var, no network"). A test that
// reached the network would make the gate environmental, and an environmental gate teaches agents
// to disbelieve it.

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_REDIRECTS,
  fetchPriceTable,
  type FetchImpl,
} from '../../../src/main/pricing/fetch-price-table';
import { PricingService } from '../../../src/main/pricing';
import { PriceRepo } from '../../../src/main/pricing/price-repo';
import { useSandbox } from '../../support/sandbox';
import { useTestDatabases } from '../db/helpers';
import { T0, dumpPriceRows, flatRates, priceDocument } from './helpers';

const URL_OK = 'https://prices.invalid/price-table.json';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

const GOOD_DOCUMENT = priceDocument([
  {
    model: 'claude-opus-4-8',
    rates: { input: 5, output: 25, cache_write: 6.25, cache_write_1h: 10, cache_read: 0.5 },
  },
]);

describe('SM-6 — fetch-price-table', () => {
  const sandbox = useSandbox();
  const databases = useTestDatabases(sandbox);

  // -----------------------------------------------------------------------------------------
  // §5.8 rule 1 + `E_FETCH_NO_URL`
  // -----------------------------------------------------------------------------------------

  it('fails with E_FETCH_NO_URL when priceFetchUrl is empty — the NORMAL fresh-clone state', () => {
    const fetchImpl = vi.fn<FetchImpl>();
    // §11.3 (closed): "`priceFetchUrl` SHIPS EMPTY and the fetch button stays disabled until the
    // user fills it. No third-party trust is baked into a published repo."
    return expect(fetchPriceTable('', { fetchImpl }))
      .rejects.toMatchObject({ code: 'E_FETCH_NO_URL' })
      .then(() => {
        // ⚠️ And nothing was attempted. "Only the user starts this" (§5.8 rule 1) is worth
        // nothing if an unconfigured URL still produces a request.
        expect(fetchImpl).not.toHaveBeenCalled();
      });
  });

  it('rejects a non-http(s) URL as an invalid setting, without attempting anything', async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    await expect(fetchPriceTable('file:///etc/passwd', { fetchImpl })).rejects.toMatchObject({
      code: 'E_INVALID_SETTING',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------------------------
  // §5.8 rule 2 — one request, GET only, no retry, ≤ 3 redirects, 10 s
  // -----------------------------------------------------------------------------------------

  it('issues exactly ONE GET and does not retry on failure', async () => {
    const fetchImpl = vi.fn<FetchImpl>(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(fetchPriceTable(URL_OK, { fetchImpl })).rejects.toMatchObject({
      code: 'E_FETCH_NETWORK',
    });
    // ⚠️ ONE call. No retry library, no backoff, no second attempt (§5.8 rule 2).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('follows at most 3 redirects and then stops with E_FETCH_HTTP', async () => {
    const fetchImpl = vi.fn<FetchImpl>((url) => Promise.resolve(redirectResponse(`${url}/next`)));
    await expect(fetchPriceTable(URL_OK, { fetchImpl })).rejects.toMatchObject({
      code: 'E_FETCH_HTTP',
    });
    // The original request plus MAX_REDIRECTS follows = 4 calls, then it gives up.
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('follows a redirect chain within the cap and validates the final document', async () => {
    const fetchImpl = vi.fn<FetchImpl>((url) =>
      Promise.resolve(
        url === URL_OK
          ? redirectResponse('https://cdn.invalid/price-table.json')
          : jsonResponse(GOOD_DOCUMENT),
      ),
    );
    const document = await fetchPriceTable(URL_OK, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(document.entries).toHaveLength(5); // all five token classes (A-05)
  });

  it('reports a timeout as E_FETCH_TIMEOUT, not as a generic network failure', async () => {
    const fetchImpl: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    await expect(fetchPriceTable(URL_OK, { fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'E_FETCH_TIMEOUT',
    });
  });

  // -----------------------------------------------------------------------------------------
  // Shape validation — §4.7, and §11.3's LiteLLM note
  // -----------------------------------------------------------------------------------------

  it('rejects a non-§4.7 document with E_FETCH_SHAPE', async () => {
    const cases: { name: string; body: unknown }[] = [
      {
        name: 'wrong schema string',
        body: { schema: 'something/else@1', generatedAt: '2026-01-01T00:00:00.000Z', models: [] },
      },
      {
        name: 'models not an array',
        body: {
          schema: 'claude-lens/price-table@1',
          generatedAt: '2026-01-01T00:00:00.000Z',
          models: {},
        },
      },
      {
        name: 'models empty',
        body: {
          schema: 'claude-lens/price-table@1',
          generatedAt: '2026-01-01T00:00:00.000Z',
          models: [],
        },
      },
      { name: 'no generatedAt', body: { schema: 'claude-lens/price-table@1', models: [] } },
      {
        // ⚠️ ADR-024: all five classes are REQUIRED. A document with fewer is not an invitation
        // to derive the fourth from the input rate — the user explicitly rejected that.
        name: 'missing cache_read',
        body: priceDocument([
          { model: 'x', rates: { input: 1, output: 2, cache_write: 3 } as never },
        ]),
      },
      {
        name: 'rate is a string',
        body: priceDocument([
          {
            model: 'x',
            rates: {
              input: '1' as never,
              output: 2,
              cache_write: 3,
              cache_write_1h: 6,
              cache_read: 4,
            },
          },
        ]),
      },
      {
        name: 'unparseable effectiveFrom',
        body: priceDocument([{ model: 'x', rates: flatRates(1), effectiveFrom: 'yesterday' }]),
      },
    ];

    for (const testCase of cases) {
      const fetchImpl: FetchImpl = () => Promise.resolve(jsonResponse(testCase.body));
      await expect(fetchPriceTable(URL_OK, { fetchImpl }), testCase.name).rejects.toMatchObject({
        code: 'E_FETCH_SHAPE',
      });
    }
  });

  it('rejects a LiteLLM-shaped document cleanly — §11.3 says this is the expected outcome in v1', async () => {
    // §6.10's help text names `model_prices_and_context_window.json` as a VERIFIED source the
    // user may paste, and §11.3 records that no adapter ships in v1: "a raw fetch of it fails
    // cleanly with `E_FETCH_SHAPE`, leaving the price table intact."
    const liteLlmShaped = {
      'claude-opus-4-8': {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 2.5e-5,
        cache_creation_input_token_cost: 6.25e-6,
        cache_read_input_token_cost: 5e-7,
      },
    };
    const fetchImpl: FetchImpl = () => Promise.resolve(jsonResponse(liteLlmShaped));
    await expect(fetchPriceTable(URL_OK, { fetchImpl })).rejects.toMatchObject({
      code: 'E_FETCH_SHAPE',
    });
  });

  it('rejects a body that is not JSON at all', async () => {
    const fetchImpl: FetchImpl = () => Promise.resolve(textResponse('<html>404</html>'));
    await expect(fetchPriceTable(URL_OK, { fetchImpl })).rejects.toMatchObject({
      code: 'E_FETCH_SHAPE',
    });
  });

  it('reports an HTTP error as E_FETCH_HTTP', async () => {
    const fetchImpl: FetchImpl = () => Promise.resolve(jsonResponse(GOOD_DOCUMENT, 500));
    await expect(fetchPriceTable(URL_OK, { fetchImpl })).rejects.toMatchObject({
      code: 'E_FETCH_HTTP',
    });
  });

  // -----------------------------------------------------------------------------------------
  // ⚠️ §5.8 rule 3 — the assertion this whole file exists for.
  // -----------------------------------------------------------------------------------------

  it('leaves price_rows BYTE-IDENTICAL after a network failure, an HTTP error and a shape mismatch', async () => {
    const db = databases.openMigrated();

    // Give the table real content first, including a `manual` row, so "unchanged" is a claim
    // about something rather than about an empty table.
    const prices = new PriceRepo(db);
    prices.upsertRate(
      { model: 'claude-opus-4-8', tokenClass: 'input', usdPerMillion: 4.5, note: 'hand-corrected' },
      T0,
    );
    prices.upsertRate({ model: 'claude-haiku-4-5', tokenClass: 'output', usdPerMillion: 5 }, T0);
    const before = dumpPriceRows(db);
    expect(before).toHaveLength(2);

    const failures: { name: string; fetchImpl: FetchImpl; code: string }[] = [
      {
        name: 'network failure',
        fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
        code: 'E_FETCH_NETWORK',
      },
      {
        name: 'HTTP 503',
        fetchImpl: () => Promise.resolve(jsonResponse({}, 503)),
        code: 'E_FETCH_HTTP',
      },
      {
        name: 'shape mismatch',
        fetchImpl: () => Promise.resolve(jsonResponse({ schema: 'nope' })),
        code: 'E_FETCH_SHAPE',
      },
    ];

    for (const failure of failures) {
      const service = new PricingService({
        db,
        settings: { priceFetchUrl: URL_OK },
        now: () => T0 + 1_000,
        fetchImpl: failure.fetchImpl,
      });
      const result = await service.handlers()['pricing:fetch']();

      // §4.1 / ADR-031: no exception crosses the boundary — a `Result` with a specific code.
      expect(result.ok, failure.name).toBe(false);
      expect(result.ok ? null : result.error.code, failure.name).toBe(failure.code);

      // ⚠️ BYTE-IDENTICAL. Every column of every row, including `updated_at`.
      expect(dumpPriceRows(db), failure.name).toEqual(before);
    }
  });

  it('applies a good document and reports every change, then is a no-op on a second identical fetch', async () => {
    const db = databases.openMigrated();
    const fetchImpl: FetchImpl = () => Promise.resolve(jsonResponse(GOOD_DOCUMENT));
    const service = new PricingService({
      db,
      settings: { priceFetchUrl: URL_OK },
      now: () => T0,
      fetchImpl,
    });

    const first = await service.handlers()['pricing:fetch']();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // §5.8 rule 4: "The response reports every change so the user can see what moved."
    expect(first.data.applied).toHaveLength(5);
    expect(first.data.unchanged).toBe(0);
    expect(first.data.sourceUrl).toBe(URL_OK);
    expect(first.data.applied[0]?.fromUsdPerMillion).toBeNull();

    const afterFirst = dumpPriceRows(db);

    // §3.11: "If nothing differs, NOTHING IS WRITTEN."
    const second = await service.handlers()['pricing:fetch']();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.applied).toEqual([]);
    expect(second.data.unchanged).toBe(5); // five token classes since A-05
    expect(dumpPriceRows(db)).toEqual(afterFirst);
  });

  it('emits evt:pricingChanged only when something was actually written', async () => {
    const db = databases.openMigrated();
    const changed: { at: number }[] = [];
    const service = new PricingService({
      db,
      settings: { priceFetchUrl: URL_OK },
      now: () => T0,
      fetchImpl: () => Promise.resolve(jsonResponse(GOOD_DOCUMENT)),
      onPricingChanged: (payload) => changed.push(payload),
    });

    await service.handlers()['pricing:fetch']();
    expect(changed).toEqual([{ at: T0 }]);

    await service.handlers()['pricing:fetch']();
    expect(changed).toHaveLength(1); // nothing differed the second time, so nothing announced
  });
});
