// `resources/price-seed.json` is imported as TEXT with Vite's `?raw` suffix, exactly as
// `src/main/db/migrations/*.sql` is (`src/main/db/sql.d.ts`), and for the same two reasons:
//
//   1. `electron-vite build` emits `out/main/index.cjs` as a single bundle, and a `readFileSync`
//      of `resources/price-seed.json` relative to that bundle would resolve to nothing in the
//      packaged app — a failure that appears only after a green build. `?raw` makes the seed a
//      string literal inside the bundle, and Vitest resolves the same specifier through the same
//      Vite pipeline (STACK ADR-012), so the seed under test is byte-identical to the one that
//      ships.
//   2. It is an AMBIENT module declaration, so TypeScript never treats `resources/price-seed.json`
//      as a program input. `tsconfig.main.json` sets `rootDir: "src/main"`; a real import of a
//      file outside that root would be a TS6059. This keeps the seed where CLAUDE.md §5 says it
//      lives (`resources/`) without widening the main program's root.
//
// ⚠️ Text, not `resolveJsonModule`. The seed is validated at load time by
// `price-document.ts` — the same validator a FETCHED document goes through (§4.7). Importing it
// as a typed object would let a malformed committed seed typecheck its way past the one gate that
// exists to catch it.

declare module '*.json?raw' {
  const content: string;
  export default content;
}
