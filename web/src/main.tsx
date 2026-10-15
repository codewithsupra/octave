import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./landing/Landing";
import { usePath } from "./router";
import { Splash } from "./ui";
import "./styles.css";

// Route-level code splitting: the landing page ships alone; the demo (xterm.js,
// simulator) and the real app (Clerk, xterm.js) load only when visited.
const DemoRoot = lazy(() => import("./roots/demo"));
const ServerRoot = lazy(() => import("./roots/server"));

function Root() {
  const path = usePath();
  if (path === "/" || path === "") return <Landing />;
  return (
    <Suspense fallback={<Splash text="Loading Octave…" />}>
      {path.startsWith("/demo") ? <DemoRoot /> : <ServerRoot path={path} />}
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
