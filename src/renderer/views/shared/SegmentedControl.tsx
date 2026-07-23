/**
 * §6.4's top control row — "a segmented toggle **All tokens** / **Cost proxy (output only)**".
 *
 * A radio group rather than a set of buttons: the choice is exclusive and exhaustive, and
 * `role="radiogroup"` is what tells assistive technology that. Arrow keys move between options
 * (P-30 — "full keyboard navigation"), which a row of buttons would not give for free.
 */

import type { JSX, KeyboardEvent } from 'react';
import { cx } from '../../lib/cx';

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
}

export interface SegmentedControlProps<Value extends string> {
  label: string;
  options: readonly SegmentedOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  'data-testid'?: string;
}

export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
  'data-testid': testId = 'segmented-control',
}: SegmentedControlProps<Value>): JSX.Element {
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = options[(index + delta + options.length) % options.length];
    if (next !== undefined) onChange(next.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      onKeyDown={move}
      className="inline-flex rounded-pill border border-border p-1"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-testid={`${testId}-${option.value}`}
            onClick={() => {
              onChange(option.value);
            }}
            className={cx(
              'rounded-pill px-3 py-1 text-small transition-colors duration-hover',
              selected ? 'bg-bg-surface-2 text-text-primary' : 'text-text-muted',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
