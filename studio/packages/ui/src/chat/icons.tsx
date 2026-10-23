import type { ReactNode } from "react";
import type { Activity } from "./turns.js";

// Line icons for the conversation (14px, stroke follows the text colour).

function Svg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const IconThink = () => (
  <Svg>
    <path d="M8 2.2a4.3 4.3 0 0 0-2.6 7.7c.5.4.8.9.8 1.5v.4h3.6v-.4c0-.6.3-1.1.8-1.5A4.3 4.3 0 0 0 8 2.2Z" />
    <path d="M6.4 14h3.2" />
  </Svg>
);
/** Opens in a window of its own (查看包, Review). */
export const IconOpenWindow = () => (
  <Svg size={12}>
    <path d="M9.5 2.5h4v4M13.5 2.5 8 8" />
    <path d="M12 9.5v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8h3.2" />
  </Svg>
);
export const IconRead = () => (
  <Svg>
    <path d="M4 1.8h5l3 3v9.4H4z" />
    <path d="M9 1.8v3h3M6 8h4M6 10.5h4" />
  </Svg>
);
export const IconSearch = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3.4 3.4" />
  </Svg>
);
export const IconEdit = () => (
  <Svg>
    <path d="M10.6 2.6a1.6 1.6 0 0 1 2.3 2.3L5.6 12.2l-3 .7.7-3z" />
  </Svg>
);
export const IconTerminal = () => (
  <Svg>
    <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2" />
    <path d="m4.6 6.2 2 1.8-2 1.8M8.4 10h3" />
  </Svg>
);
export const IconGlobe = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.7 1.8 2.4 3.8 2.4 6S9.7 12.2 8 14C6.3 12.2 5.6 10.2 5.6 8S6.3 3.8 8 2Z" />
  </Svg>
);
export const IconAgent = () => (
  <Svg>
    <rect x="3" y="5" width="10" height="8" rx="2.5" />
    <path d="M8 5V2.8M6.2 9h.01M9.8 9h.01" />
  </Svg>
);
export const IconPlan = () => (
  <Svg>
    <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    <path d="m2.4 4 .9.9L5 3.2M2.4 8l.9.9L5 7.2M2.6 12h1.8" />
  </Svg>
);
export const IconSparkle = () => (
  <Svg>
    <path d="M8 2.2 9.3 6.7 13.8 8 9.3 9.3 8 13.8 6.7 9.3 2.2 8l4.5-1.3z" />
  </Svg>
);
export const IconShield = () => (
  <Svg>
    <path d="M8 1.8 13 3.7v4c0 3.1-2.1 5.5-5 6.5-2.9-1-5-3.4-5-6.5v-4z" />
    <path d="m5.8 8 1.6 1.6 2.9-3" />
  </Svg>
);
export const IconChevronDown = () => (
  <Svg>
    <path d="m4 6 4 4 4-4" />
  </Svg>
);
export const IconChevronUp = () => (
  <Svg>
    <path d="m4 10 4-4 4 4" />
  </Svg>
);
export const IconChevronRight = () => (
  <Svg>
    <path d="m6 4 4 4-4 4" />
  </Svg>
);
export const IconCopy = () => (
  <Svg>
    <rect x="5.2" y="5.2" width="8.6" height="8.6" rx="1.8" />
    <path d="M10.8 5.2V3.6c0-1-.8-1.8-1.8-1.8H3.6c-1 0-1.8.8-1.8 1.8V9c0 1 .8 1.8 1.8 1.8h1.6" />
  </Svg>
);
export const IconCheck = () => (
  <Svg>
    <path d="m3 8.4 3.2 3.1L13 4.6" />
  </Svg>
);
export const IconX = () => (
  <Svg>
    <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" />
  </Svg>
);
export const IconArrowUp = () => (
  <Svg size={16}>
    <path d="M8 13V3M3.8 7.2 8 3l4.2 4.2" />
  </Svg>
);
export const IconArrowDown = () => (
  <Svg size={16}>
    <path d="M8 3v10M3.8 8.8 8 13l4.2-4.2" />
  </Svg>
);
export const IconStop = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="currentColor" />
  </svg>
);
export const IconClock = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.6V8l2.2 1.4" />
  </Svg>
);

export const ACTIVITY_ICON: Record<Activity, () => ReactNode> = {
  thinking: IconThink,
  read: IconRead,
  search: IconSearch,
  edit: IconEdit,
  commands: IconTerminal,
  webSearch: IconGlobe,
  webFetch: IconGlobe,
  subagents: IconAgent,
  plan: IconPlan,
  review: IconShield,
  tools: IconSparkle,
};
