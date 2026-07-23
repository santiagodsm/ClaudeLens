/**
 * The icon set — hand-drawn inline SVG, no icon package (STACK ADR-004: bespoke, no component
 * library) and no remote asset (INV-15, §7.5).
 *
 * Every icon is `stroke="currentColor"` and `aria-hidden`, because meaning is carried by the
 * `aria-label` on the button around it, never by the glyph (FRONTEND §8, P-30).
 */

import type { JSX, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function Icon({ children, ...props }: IconProps & { children: JSX.Element }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function OverviewIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </g>
    </Icon>
  );
}

export function TokensIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
        <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </g>
    </Icon>
  );
}

export function SessionsIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </g>
    </Icon>
  );
}

export function ToolsIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M14.5 6.5a3.5 3.5 0 0 0 4.6 4.6L21 13l-8 8-2-2 1.9-1.9a3.5 3.5 0 0 0-4.6-4.6L6 10.5l8-8 2 2z" />
      </g>
    </Icon>
  );
}

export function GraphsIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="9" r="2.5" />
        <circle cx="9" cy="18" r="2.5" />
        <path d="M8.2 7.2 15.8 8.4M7.4 8.3l1.3 7.3M16.6 11.1 10.9 16.4" />
      </g>
    </Icon>
  );
}

export function ProjectsIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </g>
    </Icon>
  );
}

export function HarnessIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M12 3 4 7v6c0 4.4 3.4 7.4 8 8 4.6-.6 8-3.6 8-8V7z" />
        <path d="m9 12 2.2 2.2L15.5 10" />
      </g>
    </Icon>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2.5v2.2M12 19.3v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6" />
      </g>
    </Icon>
  );
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M20 12a8 8 0 1 1-2.6-5.9" />
        <path d="M20 4v4.5h-4.5" />
      </g>
    </Icon>
  );
}

export function MoonIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </Icon>
  );
}

export function SunIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.2 4.2l1.5 1.5M18.3 18.3l1.5 1.5M2 12h2M20 12h2M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5" />
      </g>
    </Icon>
  );
}

export function CollapseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </g>
    </Icon>
  );
}

export function FolderIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M12 11.5v5M9.5 14h5" />
      </g>
    </Icon>
  );
}

export function AlertIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M12 4 2.8 20h18.4z" />
        <path d="M12 10v4M12 17h.01" />
      </g>
    </Icon>
  );
}

export function InboxIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <g>
        <path d="M3 13h5l1.5 3h5L16 13h5" />
        <path d="M5.5 5h13l2.5 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z" />
      </g>
    </Icon>
  );
}

export function SortIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4" />
    </Icon>
  );
}
