import { useEffect, useState } from "react";
import { copyText } from "../host/client.js";

// A task's or a session's id (S18): short on the page, the whole id copied on a click, to quote it to someone or to
// find the record when something in Studio goes wrong.

/** `task-dba55279-6394-…` → `dba55279`; `s-99b524f2-…` → `99b524f2`; anything else: its first 12 characters. */
export function shortId(id: string): string {
  const m = /^[a-z]+-([0-9a-f]{8})/i.exec(id);
  return m ? m[1]! : id.slice(0, 12);
}

export function CopyId({ id, label, className, testId }: { id: string; label: string; className?: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={`copy-id${className ? ` ${className}` : ""}${copied ? " copied" : ""}`}
      title={`${label} ID：${id}\n点击复制`}
      aria-label={`复制${label} ID`}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(id)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
      data-testid={testId}
      data-id={id}
    >
      {copied ? "已复制" : `#${shortId(id)}`}
    </button>
  );
}
