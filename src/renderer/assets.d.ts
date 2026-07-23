// Vite resolves these at build time. The renderer tsconfig sets `"types": []` on purpose
// (INV-16 — no @types/node in the renderer), so `vite/client` is not pulled in and the
// side-effect import of a stylesheet needs its own declaration.

declare module '*.css';
declare module '*.svg';
declare module '*.png';
declare module '*.woff2';
