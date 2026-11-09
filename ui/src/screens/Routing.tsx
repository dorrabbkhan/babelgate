/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import {
  getRouting,
  planRoute,
  UiApiError,
  type RoutePlan,
  type RouteTarget,
  type RoutingInfo,
  type RoutingProvider,
} from "../api";
import { AuthPrompt } from "../components/AuthPrompt";

/**
 * §3.9 screen 4 — Routing: the /routing tables (providers with flags
 * and caps — never keys —, aliases, ordered rules, default provider,
 * prices per configured model) and the "where would <model> go?" box
 * backed by the /routing/plan dry run (no upstream call).
 */

interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function targetLabel(t: RouteTarget): string {
  return `${t.provider}/${t.model}`;
}

function flagList(p: RoutingProvider): string {
  const flags: string[] = [];
  if (p.cacheHints) flags.push("cache_hints");
  if (p.livePrices) flags.push("live_prices");
  if (p.repairToolCalls) flags.push("repair_tool_calls");
  if (p.local) flags.push("local");
  return flags.join(" ");
}

function fmtPrice(price: Price | undefined): string {
  if (price === undefined) return "—";
  const parts = [`$${price.input}/$${price.output} per 1M`];
  if (price.cacheRead !== undefined)
    parts.push(`cache read $${price.cacheRead}`);
  if (price.cacheWrite !== undefined)
    parts.push(`cache write $${price.cacheWrite}`);
  return parts.join(", ");
}

function Providers({ providers }: { providers: RoutingProvider[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>name</th>
          <th>type</th>
          <th>base url</th>
          <th>cap</th>
          <th>flags</th>
        </tr>
      </thead>
      <tbody>
        {providers.map((p) => (
          <tr key={p.name}>
            <td>{p.name}</td>
            <td>{p.type}</td>
            <td>{p.baseUrl}</td>
            <td>{p.maxOutputTokens ?? "—"}</td>
            <td>{flagList(p) || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Tables({ info }: { info: RoutingInfo }) {
  const aliases = Object.entries(info.aliases);
  return (
    <>
      <h2>providers</h2>
      <Providers providers={info.providers} />
      <p class="muted">default provider: {info.defaultProvider}</p>
      {aliases.length > 0 && (
        <>
          <h2>aliases</h2>
          <table>
            <tbody>
              {aliases.map(([alias, t]) => (
                <tr key={alias}>
                  <td>{alias}</td>
                  <td>→ {targetLabel(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {info.rules.length > 0 && (
        <>
          <h2>rules</h2>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>match</th>
                <th>route</th>
                <th>fallback</th>
                <th>when</th>
              </tr>
            </thead>
            <tbody>
              {info.rules.map((r, i) => (
                <tr key={i}>
                  <td>{i}</td>
                  <td>{r.match}</td>
                  <td>{targetLabel(r.to)}</td>
                  <td>
                    {r.fallback.map(targetLabel).join(", ") || "—"}
                  </td>
                  <td>
                    {r.when !== undefined
                      ? JSON.stringify(r.when)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {info.prices.length > 0 && (
        <>
          <h2>prices</h2>
          <table>
            <thead>
              <tr>
                <th>target</th>
                <th>price</th>
                <th>source</th>
              </tr>
            </thead>
            <tbody>
              {info.prices.map((p) => (
                <tr key={p.target}>
                  <td>{p.target}</td>
                  <td>{fmtPrice(p.price as Price | undefined)}</td>
                  <td>{p.source ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function PlanBox() {
  const [model, setModel] = useState("");
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  const run = (): void => {
    if (model.trim() === "") return;
    planRoute(model.trim())
      .then((p) => {
        setPlan(p);
        setPlanError(null);
      })
      .catch((err: unknown) => {
        setPlan(null);
        setPlanError(
          err instanceof UiApiError ? err.message : String(err),
        );
      });
  };

  return (
    <div class="panel">
      <h3>where would a model go?</h3>
      <div class="filters">
        <input
          data-plan-model
          placeholder="model"
          value={model}
          onInput={(e) =>
            setModel((e.target as HTMLInputElement).value)
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
        />
        <button data-plan-go onClick={run}>
          plan
        </button>
      </div>
      {planError !== null && <p class="error">{planError}</p>}
      {plan !== null && (
        <div>
          <div class="muted">reason: {plan.reason}</div>
          <ol>
            {plan.targets.map((t, i) => (
              <li key={i}>
                {targetLabel(t)}
                {i === 0 ? " (primary)" : " (fallback)"}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export function Routing() {
  const [info, setInfo] = useState<RoutingInfo | null>(null);
  const [error, setError] = useState<UiApiError | null>(null);

  const load = (): void => {
    getRouting()
      .then((r) => {
        setInfo(r);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof UiApiError
            ? err
            : new UiApiError(0, "ERROR", String(err)),
        );
      });
  };

  useEffect(load, []);

  if (error !== null) {
    if (error.status === 401 || error.status === 403) {
      return <AuthPrompt error={error} onRetry={load} />;
    }
    return <p class="error">{error.message}</p>;
  }
  if (info === null) return <p class="muted">loading…</p>;

  return (
    <div>
      <PlanBox />
      <Tables info={info} />
    </div>
  );
}
