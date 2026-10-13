import type { ReactNode } from "react";

// Line icons of the attachment pieces (same drawing as chat/icons.tsx: 16-unit box, stroke follows the text colour).

function Svg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const IconClose = () => (
  <Svg size={10}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);
export const IconFile = () => (
  <Svg size={12}>
    <path d="M4 1.8h5l3 3v9.4H4z" />
    <path d="M9 1.8v3h3" />
  </Svg>
);
export const IconPaperclip = () => (
  <Svg size={16}>
    <path d="m13 7.6-5.1 5.1a3.2 3.2 0 0 1-4.6-4.6l5.3-5.3a2.1 2.1 0 0 1 3 3l-5.2 5.2a1 1 0 0 1-1.5-1.5l4.8-4.8" />
  </Svg>
);
