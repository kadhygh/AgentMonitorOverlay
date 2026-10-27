import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { shell } from "./env.js";
import { Home } from "./Home.js";
import { Login } from "./Login.js";
import { Session, type Identity } from "./session.js";
import { applyFontSize, applyTheme, readFontSize, readTheme } from "./theme.js";
import { takeResume } from "./update.js";
// AMO Studio's fonts and theme variables, so the client looks like Studio (stage 2a).
import "@fontsource-variable/noto-serif-sc";
import "@fontsource-variable/jetbrains-mono";
import "../../ui/src/styles/base.css";
import "./styles.css";

applyTheme(readTheme());
applyFontSize(readFontSize());

// The AMO 中转 client's content: the login screen, then the conversations. The login is kept for the window
// (sessionStorage), so a reload — an update applying itself — comes back signed in, with the same conversation open
// (update.ts). The desktop client still asks at each start (its saved password fills the form).

const SESSION = "amo-relay.session";
/** What was open before an update reloaded the page: for the first conversations screen only, not after a re-login. */
const resumed = takeResume();
let resumeOpen = resumed?.openId ?? null;
let updatedTo = resumed?.updatedTo ?? null;

function restored(): Identity | null {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION) ?? "null") as Identity | null;
  } catch {
    return null;
  }
}

function remember(me: Identity | null): void {
  try {
    if (me) sessionStorage.setItem(SESSION, JSON.stringify(me));
    else sessionStorage.removeItem(SESSION);
  } catch {
    // no session storage: a reload asks again
  }
}

function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const me = restored();
    return me ? new Session(me) : null;
  });
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    session.start().catch((err: unknown) => {
      // A key the service no longer knows: back to login.
      setFailed(err instanceof Error ? err.message : String(err));
      session.stop();
      setSession(null);
      remember(null);
    });
    return () => session.stop();
  }, [session]);

  const logout = async () => {
    if (!session) return;
    await session.client.logout().catch(() => undefined);
    await shell?.signedIn(null);
    remember(null);
    resumeOpen = null;
    updatedTo = null;
    setSession(null);
  };

  if (!session)
    return (
      <>
        {failed && <div className="toast">{failed}</div>}
        <Login onSignedIn={(me) => (setFailed(null), remember(me), setSession(new Session(me)))} />
      </>
    );
  return <Home session={session} onLogout={() => void logout()} resumeOpen={resumeOpen} updatedTo={updatedTo} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
