/**
 * §3.3 / §6.1 / FRONTEND §1.3 — the stable categorical hue.
 *
 * These run against `src/shared/color-index.ts` through the renderer's re-export, so they test
 * the ONE implementation all three consumers use (§3.3), not a renderer-local copy.
 *
 * Inline hand-checked expected values, never a snapshot (STACK ADR-012, CLAUDE.md §1). The
 * first three are the **canonical published FNV-1a 32-bit test vectors**, which is what makes
 * this suite a check on the algorithm rather than a recording of whatever the code did:
 *
 *   FNV1a32("")       = 0x811C9DC5 = 2_166_136_261   (the offset basis, nothing consumed)
 *   FNV1a32("a")      = 0xE40C292C = 3_826_002_220
 *   FNV1a32("foobar") = 0xBF9CF968 = 3_214_735_720
 */

import { describe, expect, it } from 'vitest';
import {
  CATEGORICAL_RAMP_SIZE,
  categoricalVar,
  categoricalVarFor,
  colorIndexFor,
  fnv1a32,
  sequentialVar,
} from '../../src/renderer/lib/colors';

describe('fnv1a32', () => {
  it('matches the canonical FNV-1a 32-bit test vectors', () => {
    expect(fnv1a32('')).toBe(2_166_136_261); // 0x811C9DC5
    expect(fnv1a32('a')).toBe(3_826_002_220); // 0xE40C292C
    expect(fnv1a32('foobar')).toBe(3_214_735_720); // 0xBF9CF968
  });

  it('⚠️ hashes UTF-16 code units, NOT UTF-8 bytes — pinned so the choice stays visible', () => {
    // Canonical FNV-1a is defined over BYTES. `src/shared/color-index.ts` iterates
    // `charCodeAt`, i.e. UTF-16 code units. The two agree for every ASCII name — which is why
    // the canonical vectors above still pass — and diverge for every non-ASCII one:
    //   'é' is one code unit (0x00E9) but two UTF-8 bytes (0xC3 0xA9)
    //   U+1F642 is a surrogate PAIR in UTF-16 and four UTF-8 bytes
    // A byte-oriented implementation returns 513_665_217 and 1_470_331_467 for these.
    // The values below are the shipped ones; they are pinned rather than corrected because
    // §3.3 does not state an encoding and the renderer must not fork the hash (CLAUDE.md §2).
    expect(fnv1a32('é')).toBe(1_812_687_940);
    expect(fnv1a32('🙂')).toBe(2_368_824_094);
    expect(colorIndexFor('café')).toBe(4); // 856_211_068 mod 8 = 4
  });

  it('stays inside uint32 for long inputs', () => {
    const long = 'x'.repeat(10_000);
    const hash = fnv1a32(long);
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('colorIndexFor', () => {
  it('is FNV1a32(name) mod 8 (§3.3)', () => {
    // 2_166_136_261 mod 8 = 5
    expect(colorIndexFor('')).toBe(5);
    // 3_826_002_220 mod 8 = 4
    expect(colorIndexFor('a')).toBe(4);
    // 3_214_735_720 mod 8 = 0
    expect(colorIndexFor('foobar')).toBe(0);
    // 432_193_002 mod 8 = 2
    expect(colorIndexFor('claude-opus-4-5')).toBe(2);
    // 2_713_462_591 mod 8 = 7
    expect(colorIndexFor('Bash')).toBe(7);
    // 3_267_849_393 mod 8 = 1
    expect(colorIndexFor('Edit')).toBe(1);
  });

  it('is stable across calls — the property the whole design rests on', () => {
    const names = ['Read', 'Bash', 'claude-opus-4-5', 'sonnet', '-Users-x-projects-lens'];
    for (const name of names) {
      const first = colorIndexFor(name);
      for (let repeat = 0; repeat < 5; repeat += 1) {
        expect(colorIndexFor(name)).toBe(first);
      }
    }
  });

  it('only ever returns 0..7', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const index = colorIndexFor(`project-${String(seed)}`);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(CATEGORICAL_RAMP_SIZE);
    }
  });
});

describe('categoricalVar', () => {
  it('maps the zero-based index onto the one-based --c1…--c8 ramp', () => {
    expect(categoricalVar(0)).toBe('var(--c1)');
    expect(categoricalVar(7)).toBe('var(--c8)');
  });

  it('wraps rather than throwing on an out-of-range index', () => {
    // §3.3's column is CHECK (color_index BETWEEN 0 AND 7); an out-of-range value is a
    // main-side defect, and blanking a series is a worse response than reusing a hue.
    expect(categoricalVar(8)).toBe('var(--c1)');
    expect(categoricalVar(-1)).toBe('var(--c8)');
  });

  it('agrees with colorIndexFor', () => {
    expect(categoricalVarFor('foobar')).toBe('var(--c1)');
    expect(categoricalVarFor('Bash')).toBe('var(--c8)');
  });
});

describe('sequentialVar', () => {
  it('separates "no observation" from "the lowest occupied stop"', () => {
    expect(sequentialVar(0)).toBe('var(--seq-0)');
    expect(sequentialVar(0.01)).toBe('var(--seq-1)');
    expect(sequentialVar(1)).toBe('var(--seq-4)');
  });

  it('clamps rather than producing an undefined colour', () => {
    expect(sequentialVar(-5)).toBe('var(--seq-0)');
    expect(sequentialVar(99)).toBe('var(--seq-4)');
    expect(sequentialVar(Number.NaN)).toBe('var(--seq-0)');
  });
});
