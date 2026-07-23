// src/shared — the vocabulary both processes compile against (STACK ADR-003).
// E1 lands `ipc-contract.ts`, `tool-taxonomy.ts` and `language-map.ts` here.

/**
 * The application version, stated once. `docs-sync` keeps this in step with
 * `package.json#version`; nothing reads it from disk, because the renderer has no
 * filesystem vocabulary (INV-16).
 */
export const APP_VERSION = '0.0.0';

/** Product name, used by the window title and the shell (DESIGN §6.2). */
export const APP_NAME = 'Claude Lens';
