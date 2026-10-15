import { useEffect, useLayoutEffect, useState } from "react";
import { shapeRects } from "./attention.js";
import { PixelBot } from "./PixelBot.js";
import { usePetSkin } from "./petSkin.js";
import "./focus.css";

// The angry robot's own window (#bot, app/src/bot-window.ts): it flies about the screen until clicked or until what
// it is angry about is dealt with. A click lands it, and Focus opens what needs the person.

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
  // Only the robot and its bubble take clicks; the rest of its window lets them through.
  useLayoutEffect(() => {
    const parts = [...document.querySelectorAll<HTMLElement>(".bot-root .pixel-bot-say, .bot-root .pixel-bot-art")].map((el) => el.getBoundingClientRect());
    const rects = shapeRects(parts, { width: window.innerWidth, height: window.innerHeight }, 4);
    if (rects.length) window.amo?.bot?.setShape(rects);
  }, [message, skin]);
  return (
    <div className="bot-root" data-testid="bot-root">
      <PixelBot mood="angry" skin={skin} message={message || "……"} onClick={() => window.amo?.bot?.caught()} />
    </div>
  );
}
