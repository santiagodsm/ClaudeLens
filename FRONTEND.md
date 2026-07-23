# Claude Lens — Front-End Design System

The visual contract for the app. Build the UI to match this. Goal: **vibrant, glowing, energetic
data-viz** that stays legible and accessible in both dark and light themes. Reference vibe: an
energetic analytics dashboard (Linear's polish, but with more color and motion).

Pair this with `DESIGN.md` (what to build) and `HANDOFF.md` (how/when + success criteria).
When styling charts specifically, also follow accessible data-viz color practice (categorical hues
stay distinct; sequential/diverging scales for magnitude; never rely on color alone — pair with
labels/shape).

---

## 1. Design principles

1. **Dark-first, light-aware.** Design in dark, verify light. Both must ship correct (theme toggle).
2. **One hero number per tile.** Big, tabular-figures, glowing accent. Supporting text is muted.
3. **Color carries meaning, not decoration.** Each model / project / tool keeps a **stable** hue
   across every view (a model is always the same color everywhere).
4. **Legibility beats flash.** Gradients and glow are accents on top of a readable base — never at
   the expense of axis labels, contrast, or tooltips.
5. **Motion is feedback.** Charts animate in on load; transitions on view change and hover. Nothing
   gratuitous; respect `prefers-reduced-motion`.

## 2. Color tokens

Define as CSS variables under `:root` (dark) and `:root[data-theme="light"]`. Tailwind reads them
via `theme.extend.colors`.

### Surfaces & text — DARK (default)
```
--bg-app:        #0B0D12   /* app background, near-black blue */
--bg-surface:    #12151C   /* cards / panels */
--bg-surface-2:  #1A1F2B   /* raised / hover */
--border:        #232936
--text-primary:  #F2F4F8
--text-muted:    #9AA4B2
--text-faint:    #5B6472
```

### Surfaces & text — LIGHT
```
--bg-app:        #F7F8FA
--bg-surface:    #FFFFFF
--bg-surface-2:  #F0F2F6
--border:        #E2E6EC
--text-primary:  #0E1116
--text-muted:    #55606E
--text-faint:    #8A94A3
```

### Accent / brand ramp (the "glow")
```
--accent:        #7C5CFF   /* violet — primary brand */
--accent-2:      #22D3EE   /* cyan */
--accent-3:      #F471B5   /* pink */
--glow:          0 0 24px rgba(124,92,255,0.45)   /* used sparingly on active/hero elements */
```

### Categorical palette (models, projects, tools — assign by stable index)
Order matters; assign deterministically so a series keeps its hue everywhere. Validated to stay
distinct in both themes:
```
c1 #7C5CFF  violet     c5 #F471B5  pink
c2 #22D3EE  cyan       c6 #FBBF24  amber
c3 #34D399  emerald    c7 #FB7185  rose
c4 #60A5FA  blue       c8 #A78BFA  lilac
```
Reserve semantic colors and keep them out of the categorical rotation:
```
--ok:    #34D399   --warn:  #FBBF24   --danger: #F87171   --info: #60A5FA
```

### Gradients (for area fills, hero tiles, bars)
```
--grad-violet-cyan:  linear-gradient(135deg, #7C5CFF 0%, #22D3EE 100%)
--grad-pink-violet:  linear-gradient(135deg, #F471B5 0%, #7C5CFF 100%)
/* Area charts: fill = series hue at 0.35 alpha → transparent (top→bottom). Stroke = full hue. */
```

**Contrast rule:** body text ≥ 4.5:1, large numbers ≥ 3:1 against their surface, in BOTH themes.
Verify — don't eyeball.

## 3. Typography

- **UI / body:** Inter (or system-ui fallback). **Numbers:** use `font-variant-numeric: tabular-nums`.
- **Mono (code, ids, tokens, graph labels):** JetBrains Mono / ui-monospace.
- Scale (rem): `display 2.5 / h1 2 / h2 1.5 / h3 1.25 / body 0.95 / small 0.8125 / micro 0.6875`.
- Hero stat numbers: display size, weight 700, tabular. Labels above them: micro, uppercase,
  letter-spacing 0.08em, `--text-muted`.

## 4. Layout

- **Left sidebar nav** (collapsible, ~240px): app mark + section links — Overview, Tokens & Cost,
  Sessions & Time, Tools & Agents, Graphs, Projects & Code, Harness Manager, Settings. Active item
  has an accent bar + subtle glow.
- **Top bar:** current view title, global date/project filter, Refresh button (shows last-parsed
  time + spinner during parse), theme toggle.
- **Content:** 12-column responsive grid, 24px gutter, max-width ~1440px centered. Cards snap to grid.
- **Spacing scale (px):** 4, 8, 12, 16, 24, 32, 48. **Radius:** cards 16, controls 10, pills 999.
- **Elevation:** flat borders + soft shadow on dark (`0 1px 0 rgba(255,255,255,0.03)` inset +
  `0 8px 24px rgba(0,0,0,0.4)`); on hover, raise to `--bg-surface-2` and add a faint accent ring.

## 5. Core components

- **StatTile** — label (micro/uppercase/muted) · hero number (display/tabular) · delta or sparkline ·
  optional gradient top-border in the metric's hue. Used in the Overview hero row.
- **ChartCard** — titled container: header (title + optional legend + control) · chart body ·
  footer note. Consistent padding (24), radius 16, animates in.
- **DataTable** — sortable headers, sticky header, zebra via `--bg-surface-2` at low alpha,
  row hover ring, click → drill-down. Tabular numerals in numeric columns.
- **GraphCanvas** — full-bleed React Flow / force-graph area with: zoom controls, a legend, a
  filter chip row, and a right-hand **inspector drawer** that slides in on node click (prompt,
  tokens, timing, links). Node styles: orchestrator = filled accent w/ glow; worker = outlined;
  tool = pill; file = rounded rect. Edge thickness ∝ frequency.
- **Badge/Pill** — status (ok/warn/danger), model tag (in the model's hue), count chips.
- **Gauge** — cache-efficiency; radial, gradient stroke.
- **Heatmap cell** — calendar + hour×weekday; sequential single-hue scale (violet ramp), tooltip on hover.
- **EmptyState / Loading / Error** — every view must have all three (spinner + progress % during
  parse; friendly "pick a folder" empty state; clear error with retry).

## 6. Chart styling rules

- Grid lines: `--border` at low alpha, horizontal only, no chart borders.
- Axis text: `--text-muted`, small; abbreviate large numbers (`1.2M`, `340K`).
- Tooltips: `--bg-surface-2`, 10px radius, soft shadow, show exact values + series color swatch.
- Legends: interactive (click to isolate/toggle series) where the library allows.
- Stacked areas: gradient fills (§2), 1.5px strokes. Treemap: tiles in project hues, labels inside.
- Always label series/axes; never encode meaning by color alone (add a shape/label for the colorblind).

## 7. Motion

- View transition: 200ms fade+slide (8px). Chart entrance: 400–600ms ease-out, stagger series ~40ms.
- Hover: 120ms. Graph node focus: gentle scale + glow. Drawer: 240ms slide.
- Honor `prefers-reduced-motion: reduce` → disable non-essential animation.

## 8. Accessibility

- WCAG AA contrast in both themes (verify). Focus-visible rings on all interactive elements.
- Full keyboard nav for sidebar, tables, and graph selection. `aria-label`s on icon buttons.
- Don't rely on color alone — pair with text/iconography (especially Bloat Radar severity and charts).

## 9. Deliverable expectation

A cohesive theme file (CSS variables + Tailwind config) implementing §2–§4 as tokens, a small set of
reusable primitives (§5), and consistent chart/graph styling (§6). Everything themable via a single
`data-theme` switch. It should look like one designed system, not assembled parts.
