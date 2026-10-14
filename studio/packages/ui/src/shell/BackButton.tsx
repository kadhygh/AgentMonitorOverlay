/**
 * The way back from a task or new-task page (2026-10-15): a chevron, the icon of where it returns (看板: columns,
 * 画布: linked cards) and its name. Named 「返回看板」 / 「返回画布」 for screen readers.
 */
export function BackButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button type="button" className="back-btn" onClick={onClick} aria-label={`返回${label}`} title={`返回${label}`} data-testid="back">
      <svg className="back-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M10 3 5 8l5 5" />
      </svg>
      {label === "画布" ? (
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.8" y="2.5" width="5" height="3.6" rx="0.8" />
          <rect x="9.2" y="9.9" width="5" height="3.6" rx="0.8" />
          <path d="M6.8 4.3h2.4a2 2 0 0 1 2 2v3.6" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="1" />
          <path d="M6 2.5v11M10 2.5v11" />
        </svg>
      )}
      <span>{label}</span>
    </button>
  );
}
