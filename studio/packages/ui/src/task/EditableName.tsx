import { useState } from "react";

/**
 * A name edited in place: shown as text, a click turns it into a field; Enter or leaving the field saves, Escape
 * cancels. Used for a task's title and a session's title.
 */
export function EditableName({
  value,
  placeholder,
  label,
  disabled = false,
  className = "task-title-btn",
  onSave,
}: {
  value: string;
  placeholder: string;
  /** What is being named, e.g. "任务名". */
  label: string;
  disabled?: boolean;
  className?: string;
  onSave(next: string): void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        className="rename-input"
        aria-label={label}
        defaultValue={value}
        autoFocus
        maxLength={100}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = value;
            setEditing(false);
          }
        }}
        onBlur={(e) => {
          setEditing(false);
          const next = e.target.value.trim();
          if (next && next !== value) onSave(next);
        }}
      />
    );
  }
  return (
    <button type="button" className={className} disabled={disabled} title={disabled ? undefined : `点击修改${label}`} onClick={() => setEditing(true)}>
      {value || placeholder}
    </button>
  );
}
