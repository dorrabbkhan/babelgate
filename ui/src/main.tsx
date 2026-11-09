/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Inspector } from "./screens/Inspector";
import { Playground } from "./screens/Playground";
import { Requests } from "./screens/Requests";
import { Routing } from "./screens/Routing";
import { Usage } from "./screens/Usage";

/**
 * SPA entry (spec §3.9). Hash routes only — `#/requests`,
 * `#/requests/:id`, `#/usage`, `#/routing`, `#/playground` — so the
 * Express side needs nothing beyond the static SPA fallback to
 * index.html.
 */

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function App() {
  const hash = useHash();
  const inspector = /^#\/requests\/([^/]+)$/.exec(hash);
  const nav = (route: string, label: string) => (
    <a
      href={`#${route}`}
      class={
        inspector === null && hash === `#${route}` ? "active" : ""
      }
    >
      {label}
    </a>
  );
  return (
    <>
      <header>
        <span class="brand">babelgate</span>
        {nav("/requests", "requests")}
        {nav("/usage", "usage")}
        {nav("/routing", "routing")}
        {nav("/playground", "playground")}
      </header>
      <main>
        {inspector !== null ? (
          <Inspector id={decodeURIComponent(inspector[1] ?? "")} />
        ) : hash === "#/usage" ? (
          <Usage />
        ) : hash === "#/routing" ? (
          <Routing />
        ) : hash === "#/playground" ? (
          <Playground />
        ) : (
          <Requests />
        )}
      </main>
    </>
  );
}

const root = document.getElementById("app");
if (root !== null) render(<App />, root);
