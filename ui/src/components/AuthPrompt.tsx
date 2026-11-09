/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import { UiApiError } from "../api";
import { setKey } from "../auth";

/**
 * What a 401/403 from /ui/api renders (plan Interfaces): a key prompt
 * when the server asks for PROXY_API_KEY, else the access hint text
 * the server sent (loopback/UI_ALLOW_REMOTE/Host refusals — cases a
 * key cannot fix). Files-block note: shared by both screens; recorded
 * in docs/decisions.md.
 */
export function AuthPrompt({
  error,
  onRetry,
}: {
  error: UiApiError;
  onRetry: () => void;
}) {
  const wantsKey =
    error.status === 401 || /api key/i.test(error.message);
  const [value, setValue] = useState("");

  if (!wantsKey) {
    return (
      <div class="prompt">
        <p class="error">{error.message}</p>
      </div>
    );
  }

  return (
    <div class="prompt">
      <p>This UI needs the proxy API key (PROXY_API_KEY).</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setKey(value === "" ? null : value);
          onRetry();
        }}
      >
        <input
          type="password"
          aria-label="api key"
          placeholder="PROXY_API_KEY"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />{" "}
        <button type="submit">save</button>
      </form>
      <p class="muted">{error.message}</p>
    </div>
  );
}
