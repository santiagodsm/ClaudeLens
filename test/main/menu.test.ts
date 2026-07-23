// `src/main/menu.ts` — §6.2, the macOS application menu and the native About panel.
//
// These are pure-data assertions: `menu.ts` imports only *types* from electron, so its template
// builder and About-panel options are testable in the `main` Vitest project (node env) without an
// electron binary or a window. The E2E smoke suite (ADR-018) covers the fact that setting the menu
// does not wedge window creation; here we only prove the shape and the copy.

import { describe, expect, it } from 'vitest';
import { aboutPanelOptions, buildAppMenuTemplate } from '../../src/main/menu';
import { APP_NAME, APP_VERSION } from '../../src/shared/version';

/** Flattens every `label` in a menu template (top level and one submenu deep) for easy assertions. */
function labels(template: ReturnType<typeof buildAppMenuTemplate>): string[] {
  const out: string[] = [];
  for (const item of template) {
    if (typeof item.label === 'string') out.push(item.label);
    const submenu = item.submenu;
    if (Array.isArray(submenu)) {
      for (const child of submenu) {
        if (typeof child.label === 'string') out.push(child.label);
      }
    }
  }
  return out;
}

/** Every `role` used anywhere in the template. */
function roles(template: ReturnType<typeof buildAppMenuTemplate>): string[] {
  const out: string[] = [];
  for (const item of template) {
    if (typeof item.role === 'string') out.push(item.role);
    const submenu = item.submenu;
    if (Array.isArray(submenu)) {
      for (const child of submenu) {
        if (typeof child.role === 'string') out.push(child.role);
      }
    }
  }
  return out;
}

describe('§6.2 — the application menu is Claude Lens, not Electron', () => {
  it('carries an "About Claude Lens" item and a "Quit Claude Lens" item', () => {
    const found = labels(buildAppMenuTemplate({ dev: false }));
    expect(found).toContain(`About ${APP_NAME}`);
    expect(found).toContain(`Quit ${APP_NAME}`);
    expect(`About ${APP_NAME}`).toBe('About Claude Lens');
    expect(`Quit ${APP_NAME}`).toBe('Quit Claude Lens');
  });

  it('names the top-level app menu after the product', () => {
    const template = buildAppMenuTemplate({ dev: false });
    expect(template[0]?.label).toBe(APP_NAME);
  });

  it('uses native roles so shortcuts and text-field editing are real', () => {
    // A role-driven menu is the whole point (roles, not hand-rolled handlers): ⌘Q quits, clipboard
    // works inside the renderer's inputs, and the platform owns the shortcuts.
    const used = roles(buildAppMenuTemplate({ dev: false }));
    for (const role of [
      'about',
      'quit',
      'undo',
      'copy',
      'paste',
      'selectAll',
      'minimize',
      'close',
    ]) {
      expect(used).toContain(role);
    }
  });

  it('exposes dev affordances only in a dev run', () => {
    expect(roles(buildAppMenuTemplate({ dev: false }))).not.toContain('toggleDevTools');
    expect(roles(buildAppMenuTemplate({ dev: true }))).toContain('toggleDevTools');
  });
});

describe('§6.2 / §1a — the About panel names the app, shows a version, and has no jargon', () => {
  it('carries the app name and a version', () => {
    const about = aboutPanelOptions();
    expect(about.applicationName).toBe(APP_NAME);
    expect(about.applicationVersion).toBe(APP_VERSION);
    expect(about.applicationVersion).toBe('0.0.0');
  });

  it('has non-empty descriptive and credits text that says what the app is', () => {
    const about = aboutPanelOptions();
    expect(about.credits && about.credits.length).toBeGreaterThan(80);
    expect(about.copyright && about.copyright.length).toBeGreaterThan(0);
    // Plain-language substance, not a placeholder.
    expect(about.credits).toMatch(/local dashboard/i);
    expect(about.credits).toMatch(/offline/i);
  });

  it('contains no internal jargon id (§1a — nothing that needs DESIGN.md to read)', () => {
    // The forbidden vocabulary from §1a: metric/invariant/ADR/rule ids, channel-shaped names, and
    // state-machine ids. None of it may reach a screen the user sees, and the About panel is one.
    const text = `${aboutPanelOptions().credits ?? ''} ${aboutPanelOptions().copyright ?? ''}`;
    expect(text).not.toMatch(/\bM-\d/);
    expect(text).not.toMatch(/\bINV-\d/);
    expect(text).not.toMatch(/\bADR-\d/);
    expect(text).not.toMatch(/\bBR-\d/);
    expect(text).not.toMatch(/\bACT-\d/);
    expect(text).not.toMatch(/\bSM-\d/);
    // Channel-shaped ids like `evt:dataChanged` / `q:overview`.
    expect(text).not.toMatch(/\b(evt|q|cmd):[a-z]/i);
  });
});
