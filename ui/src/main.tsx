/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Inspector } from "./screens/Inspector";
import { Requests } from "./screens/Requests";

/**
 * SPA entry (spec §3.9). Hash routes only — `#/requests` and
 * `#/requests/:id` — so the Express side needs nothing beyond the
 * static SPA fallback to index.html. Usage (3), Routing (4) and
 * Playground (5) are Tasks 14–15.
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
  return (
    <>
      <header>
        <span class="brand">babelgate</span>
        <a href="#/requests">requests</a>
      </header>
      <main>
        {inspector !== null ? (
          <Inspector id={decodeURIComponent(inspector[1] ?? "")} />
        ) : (
          <Requests />
        )}
      </main>
    </>
  );
}

const root = document.getElementById("app");
if (root !== null) render(<App />, root);
