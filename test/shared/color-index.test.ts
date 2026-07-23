// §3.3 — `color_index = FNV1a32(encoded_name) mod 8`.
//
// "A pure function of the name, so hues survive a full rebuild." The point of testing it is
// that a rebuild must not repaint the charts, so the values are pinned against an independent
// FNV-1a implementation written out longhand below rather than against whatever the code
// currently returns.

import { describe, expect, it } from 'vitest';
import { colorIndexFor, COLOR_RAMP_SIZE, fnv1a32 } from '../../src/shared/color-index';

/** FNV-1a 32-bit, computed with BigInt so it cannot share a bug with the implementation. */
function referenceFnv1a32(value: string): number {
  const MASK = (1n << 32n) - 1n;
  let hash = 0x811c9dc5n;
  for (const unit of value.split('').map((char) => BigInt(char.charCodeAt(0)))) {
    hash = (hash ^ unit) & MASK;
    hash = (hash * 0x01000193n) & MASK;
  }
  return Number(hash);
}

describe('fnv1a32 / colorIndexFor', () => {
  it('matches an independent implementation', () => {
    for (const name of ['', 'a', '-work-demo-alpha', 'claude-test-1', 'Edit', 'Bash']) {
      expect(fnv1a32(name)).toBe(referenceFnv1a32(name));
    }
    // The canonical FNV-1a 32-bit test vector.
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  it('always lands inside the §3.3 CHECK (color_index BETWEEN 0 AND 7)', () => {
    for (const name of ['-work-demo-alpha', '-work-demo-beta', 'x', 'y', 'z', 'Agent', 'Skill']) {
      const index = colorIndexFor(name);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(COLOR_RAMP_SIZE);
    }
  });

  it('is stable — the same name gives the same hue, every time', () => {
    expect(colorIndexFor('-work-demo-alpha')).toBe(colorIndexFor('-work-demo-alpha'));
    expect(colorIndexFor('-work-demo-alpha')).toBe(referenceFnv1a32('-work-demo-alpha') % 8);
  });
});
