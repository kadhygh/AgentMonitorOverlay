/** A topic's bookmark or a project's folder: the left column's marks, also on the board's cards and topic groups. */
export function KindIcon({ kind, className }: { kind: "topic" | "workspace"; className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {kind === "topic" ? <path d="M3 2.5h8v9l-4-2.6-4 2.6z" /> : <path d="M1.5 4V11.5h11V5H7L5.6 3H1.5z" />}
    </svg>
  );
}
