import { useEffect, useRef, useState } from "react";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

const SAVE_DELAY_MS = 500;

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** Global scratchpad at the bottom of the right column. Saves shortly after typing stops; other windows follow live. */
export function Scratchpad({ link }: { link: HostLink }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      call(link, "GET /api/scratchpad")
        .then((s) => {
          if (!cancelled && !dirty.current) setText(s.text);
        })
        .catch(() => undefined);
    // Edits from another window replace the text unless this one has unsaved typing.
    const offEvent = onHostEvent((e) => {
      if (e.type === "scratchpad.updated" && !dirty.current) setText(e.scratchpad.text);
    });
    const offReconnect = onHostReconnect(() => void load());
    void load();
    return () => {
      cancelled = true;
      offEvent();
      offReconnect();
    };
  }, [link]);

  function save(value: string) {
    setState("saving");
    call(link, "PUT /api/scratchpad", {}, { text: value })
      .then(() => {
        dirty.current = false;
        setState("saved");
      })
      .catch(() => setState("error"));
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const status = { idle: "", dirty: "", saving: "保存中…", saved: "已保存", error: "保存失败，稍后会重试" }[state];

  return (
    <section className="scratchpad" aria-label="草稿区">
      <div className="anno-head">
        <span className="anno-title">草稿区</span>
        <span className="anno-count" data-testid="scratchpad-status">
          {status}
        </span>
      </div>
      <textarea
        value={text}
        aria-label="草稿"
        placeholder="随手记点什么，所有任务共用这一份。"
        rows={6}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          dirty.current = true;
          setState("dirty");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => save(value), SAVE_DELAY_MS);
        }}
        onBlur={() => {
          if (!dirty.current) return;
          if (timer.current) clearTimeout(timer.current);
          save(text);
        }}
      />
    </section>
  );
}
