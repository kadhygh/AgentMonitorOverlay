import { fileKind } from "./filekind.js";

// A 14px file icon by type (see filekind.ts): a coloured badge with a short label, or an outline for images, text
// and unknown files. Decorative: the name next to it says what the file is.

export function FileTypeIcon({ path }: { path: string }) {
  const kind = fileKind(path);
  if ("badge" in kind) {
    const size = kind.badge.length > 2 ? 5.6 : kind.badge.length === 2 ? 6.8 : 8.5;
    return (
      <svg className="file-type-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <rect x="0.5" y="0.5" width="13" height="13" rx="2.5" fill={kind.bg} />
        <text x="7" y="7.1" fontSize={size} fill={kind.fg ?? "#fff"} textAnchor="middle" dominantBaseline="central">
          {kind.badge}
        </text>
      </svg>
    );
  }
  return (
    <svg className={`file-type-icon shape ${kind.shape}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round">
      {kind.shape === "image" ? (
        <>
          <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
          <path d="M2 10.5l3.2-3.4 2.3 2.3 1.6-1.5 2.9 2.6" />
          <circle cx="9.3" cy="5.3" r="1" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <path d="M3 1.5h5.3L11 4.2v8.3H3z" />
          <path d="M8.2 1.6v2.7H11" />
          {kind.shape === "text" && <path d="M4.8 6.9h4.4M4.8 8.7h4.4M4.8 10.5h2.8" />}
        </>
      )}
    </svg>
  );
}
