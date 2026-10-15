import { useEffect, useState } from "react";
import { ClerkProvider, Show, SignIn, SignUp, UserButton, useAuth, useClerk } from "@clerk/react";
import { dark } from "@clerk/ui/themes";
import { App } from "../App";
import { HttpError, api, realBackend, setBackend, setTokenProvider } from "../api";
import { linkProps, navigate } from "../router";
import { Mark, Splash } from "../ui";

// ---------- /app, /sign-in, /sign-up: the real thing ----------

interface Config { authEnabled: boolean; publishableKey: string | null }

export default function ServerRoot({ path }: { path: string }) {
  const [config, setConfig] = useState<Config | null | "offline">(null);
  useEffect(() => {
    setBackend(realBackend);
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setConfig)
      .catch(() => setConfig("offline"));
  }, []);

  if (config === null) return <Splash text="Connecting to Octave…" />;
  if (config === "offline") return <Offline />;
  if (!config.authEnabled || !config.publishableKey) {
    if (!path.startsWith("/app")) { navigate("/app", true); return null; }
    return <App mode="local" />;
  }
  return (
    <ClerkProvider
      publishableKey={config.publishableKey}
      routerPush={(to: string) => navigate(to)}
      routerReplace={(to: string) => navigate(to, true)}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
      afterSignOutUrl="/"
      appearance={{
        theme: dark,
        variables: { colorPrimary: "#9AA8FF", colorBackground: "#222A3C", colorForeground: "#E3E8F3", colorMutedForeground: "#8E99B3", colorInput: "#151A27", colorPrimaryForeground: "#18203A", borderRadius: "10px", fontFamily: '"Schibsted Grotesk", system-ui, sans-serif' },
      }}
    >
      {path.startsWith("/sign-in") ? (
        <AuthPage><SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" /></AuthPage>
      ) : path.startsWith("/sign-up") ? (
        <AuthPage><SignUp routing="path" path="/sign-up" signInUrl="/sign-in" /></AuthPage>
      ) : (
        <Show when="signed-in" fallback={<ToSignIn />}>
          <AuthedApp />
        </Show>
      )}
    </ClerkProvider>
  );
}

function ToSignIn() {
  const { isLoaded } = useAuth();
  useEffect(() => { if (isLoaded) navigate("/sign-in", true); }, [isLoaded]);
  return <Splash text="Checking your session…" />;
}

function AuthedApp() {
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  setTokenProvider(() => getToken());
  const [access, setAccess] = useState<"checking" | "ok" | { error: string }>("checking");
  useEffect(() => {
    api("/api/me")
      .then(() => setAccess("ok"))
      .catch((e) => setAccess({ error: e instanceof HttpError && e.status === 403 ? e.message : `Couldn't reach Octave: ${e.message}` }));
  }, []);
  if (access === "checking") return <Splash text="Opening your workspaces…" />;
  if (access !== "ok") {
    return (
      <div className="boot">
        <h2>You can't use this Octave</h2>
        <p className="muted narrow">{access.error}</p>
        <button onClick={() => signOut({ redirectUrl: "/sign-in" })}>Sign in with a different account</button>
      </div>
    );
  }
  return <App mode="authed" account={<UserButton appearance={{ elements: { avatarBox: { width: 26, height: 26 } } }} />} />;
}

function AuthPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <a className="brand" {...linkProps("/")}><Mark /> Octave</a>
      {children}
      <p className="muted small narrow">
        Octave runs agents on this machine. The first account to sign in becomes its owner; other accounts are refused.
      </p>
    </div>
  );
}

function Offline() {
  return (
    <div className="boot">
      <Mark />
      <h2>Octave runs on your machine</h2>
      <p className="muted narrow">This page talks to the Octave server on your computer, and none is reachable here. Install it locally, or explore the live demo first.</p>
      <pre className="install">git clone https://github.com/codewithsupra/octave{"\n"}cd octave && npm install && npm start</pre>
      <div className="row">
        <a className="btn" {...linkProps("/demo")}>Try the live demo</a>
        <a className="btn ghost" {...linkProps("/")}>Back to the homepage</a>
      </div>
    </div>
  );
}


