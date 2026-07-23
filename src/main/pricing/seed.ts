// The bundled seed — DESIGN §3.11 ("Seed"), §4.7, PRD "Price source — bundled seed".
//
// "`resources/price-seed.json` ships in the repo, correct as of build date, in the canonical
// shape of §4.7. It is loaded on first run as rows with `source='seed'`, and is re-loadable on
// demand via `pricing:resetToSeed`, which is additive through the same auto-versioning path and
// never deletes a `manual` row."
//
// ⚠️ THE SEED IS THE OFFLINE GUARANTEE. §11.3 closed `priceFetchUrl` as SHIPPING EMPTY: "no
// third-party trust is baked into a published repo — the user opts into a dependency rather than
// inheriting one. The guaranteed-correct path remains the bundled seed plus manual editing."
// A fresh clone with no network runs entirely on this file.
//
// ⚠️ It goes through THE SAME VALIDATOR as a fetched document. A committed file is not more
// trustworthy than a fetched one — it is just committed. If `price-seed.json` is edited into an
// invalid shape, `loadPriceSeed()` fails loudly at the point of use rather than half-applying.

import seedText from '../../../resources/price-seed.json?raw';
import { parsePriceDocument, type ValidatedPriceDocument } from './price-document';

/** The seed's raw bytes, exactly as committed. Exported so a test can assert on the file itself. */
export const PRICE_SEED_TEXT: string = seedText;

/**
 * Parses and validates the bundled seed, converting every rate to picoUSD/token.
 *
 * Throws `PricingError` (`E_FETCH_SHAPE` / `E_PRICE_PRECISION`) if the committed file is not a
 * valid §4.7 document — which is a build-time defect, and is surfaced as one.
 */
export function loadPriceSeed(): ValidatedPriceDocument {
  return parsePriceDocument(PRICE_SEED_TEXT);
}
