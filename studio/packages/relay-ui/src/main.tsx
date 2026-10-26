import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { shell } from "./env.js";
import { Home } from "./Home.js";
import { Login } from "./Login.js";
import { Session, type Identity } from "./session.js";
import "./styles.css";

// The AMO 中转 client's content: the login screen, then the conversations. In a browser a reload keeps the login for
// the tab (sessionStorage); the desktop client asks at each start (its saved password fills the form), which is also
// where it offers an update.

function restored(): Identity | null {
  if (shell) return null;
  try {
    return JSON.parse(sessionStorage.getItem("amo-relay.session") ?? "null") as Identity | null;
  } catch {
    return null;
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
      try {
        sessionStorage.removeItem("amo-relay.session");
      } catch {
        // nothing kept
      }
    });
    return () => session.stop();
  }, [session]);

  const logout = async () => {
    if (!session) return;
    await session.client.logout().catch(() => undefined);
    await shell?.signedIn(null);
    try {
      sessionStorage.removeItem("amo-relay.session");
    } catch {
      // nothing kept
    }
    setSession(null);
  };

  if (!session)
    return (
      <>
        {failed && <div className="toast">{failed}</div>}
        <Login onSignedIn={(me) => (setFailed(null), setSession(new Session(me)))} />
      </>
    );
  return <Home session={session} onLogout={() => void logout()} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
