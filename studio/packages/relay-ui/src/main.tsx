import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { shell } from "./env.js";
import { Home } from "./Home.js";
import { Login, PlatformLogin } from "./Login.js";
import { Session, type Identity } from "./session.js";
import { normalizeServer, RelayClient, RelayClientError, type ShellInfo } from "./shared.js";
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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const me = restored();
    return me ? new Session(me) : null;
  });
  const [failed, setFailed] = useState<string | null>(null);
  // AMO 平台's account (2026-10-29, AGENTS.md rule 7): a shell that can read it signs in with it, and follows it — another
  // account there switches here, logging out there logs out here. "checking" until first read; "none": nobody there;
  // "off": an older shell (the login form as before).
  const [platform, setPlatform] = useState<"checking" | "none" | "off">(shell?.platformAccount ? "checking" : "off");
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const current = useRef(session);
  current.current = session;
  /** A key the service refused: not tried again until the platform has another. */
  const refused = useRef<string | null>(null);

  const follow = useCallback(async () => {
    if (!shell?.platformAccount) return;
    const a = await shell.platformAccount().catch(() => null);
    const cur = current.current;
    if (!a) {
      if (cur?.me.platform) {
        cur.stop();
        remember(null);
        setSession(null);
      }
      setPlatform("none");
      return;
    }
    if (cur?.me.platform && cur.me.key === a.key && cur.me.server === normalizeServer(a.server)) return;
    if (a.key === refused.current) return setPlatform("none");
    try {
      const client = new RelayClient(a.server, a.key);
      const me = await client.me();
      const id: Identity = { server: client.server, name: me.name, role: me.role, key: a.key, service: me.service, platform: true };
      // This machine's MCP and command line use it too.
      await shell.signedIn({ server: client.server, name: me.name, key: a.key });
      cur?.stop();
      setProblem(null);
      setFailed(null);
      remember(id);
      setSession(new Session(id));
    } catch (err) {
      if (err instanceof RelayClientError && (err.status === 401 || err.status === 403)) {
        refused.current = a.key;
        setProblem("AMO 平台里的登录在服务器上已经失效了：在 AMO 平台的「账号」里退出再登录一次。");
      } else setProblem(`连不上 ${normalizeServer(a.server)}：${errorText(err)}（会自动再试）`);
      if (!cur) setPlatform("none");
    }
  }, []);

  useEffect(() => {
    if (platform === "off" || !shell) return;
    void shell.info().then(setInfo);
    void follow();
    const timer = setInterval(() => void follow(), 5000);
    const onFocus = () => void follow();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session) return;
    session.start().catch((err: unknown) => {
      // A key the service no longer knows: back to login.
      if (session.me.platform) {
        refused.current = session.me.key;
        setProblem("AMO 平台里的登录在服务器上已经失效了：在 AMO 平台的「账号」里退出再登录一次。");
      } else setFailed(errorText(err));
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

  if (!session) {
    if (platform === "checking") return <div className="login-page" data-testid="platform-checking" />;
    // Installed by the platform: its login only. A zip unpacked by hand keeps its own form when nobody is logged in there.
    if (platform === "none" && info?.updatedBy === "platform") return <PlatformLogin server={info.server} problem={problem} onRetry={() => ((refused.current = null), void follow())} />;
    if (platform === "none" && !info) return <div className="login-page" data-testid="platform-checking" />;
    return (
      <>
        {(failed ?? problem) && <div className="toast">{failed ?? problem}</div>}
        <Login onSignedIn={(me) => (setFailed(null), remember(me), setSession(new Session(me)))} />
      </>
    );
  }
  return <Home session={session} {...(session.me.platform ? {} : { onLogout: () => void logout() })} resumeOpen={resumeOpen} updatedTo={updatedTo} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
