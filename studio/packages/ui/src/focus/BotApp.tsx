import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { shapeRects } from "./attention.js";
import { PixelBot } from "./PixelBot.js";
import { usePetSkin } from "./petSkin.js";
import "./focus.css";

// The angry robot's own window (#bot, app/src/bot-window.ts): it flies about the screen until clicked or until what
// it is angry about is dealt with. A click lands it, and Focus opens what needs the person.

/** Room around the pet for its shake (a few degrees and pixels) and its drop shadow. */
const PET_ROOM = 16;

export function BotApp() {
  const [message, setMessage] = useState("");
  const skin = usePetSkin();
  useEffect(() => {
    void window.amo?.bot?.message().then(setMessage);
    return window.amo?.bot?.onSay(setMessage);
  }, []);
  useEffect(() => {
    const pressed = () => window.amo?.bot?.pressed();
    document.addEventListener("pointerdown", pressed, true);
    return () => document.removeEventListener("pointerdown", pressed, true);
  }, []);
  // Only the robot and its bubble take clicks (and get drawn); the rest of its window lets them through. The pet is
  // measured by its slot, not its shaking self, with room for the shake and its shadow (2026-10-16: they were cut off).
  const art = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const send = () => {
      const win = { width: window.innerWidth, height: window.innerHeight };
      const say = document.querySelector<HTMLElement>(".bot-root .pixel-bot-say");
      const rects = [...shapeRects(say ? [say.getBoundingClientRect()] : [], win, 10), ...shapeRects(art.current ? [art.current.getBoundingClientRect()] : [], win, PET_ROOM)];
      if (rects.length) window.amo?.bot?.setShape(rects);
    };
    send();
    // Its bubble grows once the font is in; and 界面大小 changes the zoom.
    void document.fonts?.ready.then(send);
    window.addEventListener("resize", send);
    return () => window.removeEventListener("resize", send);
  }, [message, skin]);
  return (
    <div className="bot-root" data-testid="bot-root">
      <PixelBot mood="angry" skin={skin} message={message || "……"} onClick={() => window.amo?.bot?.caught()} artRef={art} />
    </div>
  );
}
