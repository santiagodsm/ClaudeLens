// Migration files are imported as text with Vite's `?raw` suffix, so the schema is part of
// the module graph rather than a file the runtime has to find on disk.
//
// This matters at exactly one moment: `electron-vite build` emits `out/main/index.cjs` as a
// single bundle, and a `readFileSync` of `src/main/db/migrations/*.sql` relative to the
// bundle would resolve to nothing in the packaged app — a failure that appears only after a
// green build. `?raw` makes the SQL a string literal in the bundle, and Vitest resolves the
// same specifier through the same Vite pipeline (STACK ADR-012), so the migration under test
// is byte-identical to the migration that ships.
//
// The renderer's equivalent declaration lives in `src/renderer/assets.d.ts`; this one is
// scoped to `src/main` because migrations are database-layer artefacts (STACK ADR-008).

declare module '*.sql?raw' {
  const content: string;
  export default content;
}
