/**
 * Client-side Turnstile glue.
 *
 *   - Lazily loads the Cloudflare Turnstile script the first time we
 *     actually need to challenge the visitor. Normal readers never
 *     download it.
 *   - `gatedFetch()` wraps `fetch` so any endpoint that responds with
 *     HTTP 428 `{needs_challenge:true, site_key}` triggers exactly one
 *     transparent retry with an `X-Turnstile-Token` header. After the
 *     server verifies the token it sets a 30-minute trust cookie, so
 *     subsequent gated calls bypass the challenge entirely.
 *   - `solveTurnstile()` mounts the widget in `appearance: "interaction-only"`
 *     mode: Cloudflare's Managed scoring runs invisibly in the background
 *     and resolves the promise without ever showing UI for the vast
 *     majority of visitors. Only when CF flags the session does the
 *     widget actually render an interactive challenge.
 */

const SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let siteKeyPromise: Promise<string> | null = null;
let scriptPromise: Promise<void> | null = null;

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => unknown;
      reset: (id?: unknown) => void;
      remove: (id?: unknown) => void;
    };
  }
}

/** Memoized fetch of the public site key. Empty string when Turnstile
 *  isn't configured on the server — callers should treat that as
 *  "challenge unavailable, fail open." */
export async function getTurnstileSiteKey(): Promise<string> {
  if (!siteKeyPromise) {
    siteKeyPromise = (async () => {
      try {
        const res = await fetch("/api/config", { credentials: "same-origin" });
        if (!res.ok) return "";
        const j: any = await res.json();
        return (j?.turnstile?.site_key as string) || "";
      } catch {
        return "";
      }
    })();
  }
  return siteKeyPromise;
}

function loadScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = SCRIPT_URL;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      // The script signals readiness by populating window.turnstile.
      // It's already populated by the time onload fires when using
      // render=explicit, but guard for the rare race.
      if (window.turnstile) resolve();
      else
        setTimeout(() => {
          window.turnstile ? resolve() : reject(new Error("turnstile not ready"));
        }, 200);
    };
    s.onerror = () => reject(new Error("failed to load turnstile script"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/** Solve a single Turnstile challenge and return the resulting token.
 *  Tokens are single-use; the server consumes them and (on success)
 *  hands back a trust cookie that covers the next 30 minutes. */
export async function solveTurnstile(siteKey?: string): Promise<string> {
  const key = siteKey || (await getTurnstileSiteKey());
  if (!key) throw new Error("Turnstile is not configured");
  await loadScript();
  if (!window.turnstile) throw new Error("Turnstile script did not initialize");

  return new Promise<string>((resolve, reject) => {
    // Container is a fixed overlay so an interactive challenge has
    // somewhere to render. In invisible mode the widget itself stays
    // 0×0, but we keep the small "Verifying…" label visible for
    // honesty + so a brief CPU stall isn't a silent dead-time.
    const overlay = document.createElement("div");
    overlay.className = "hp-turnstile-overlay";
    const card = document.createElement("div");
    card.className = "hp-turnstile-card";
    const label = document.createElement("p");
    label.className = "hp-turnstile-label";
    label.textContent =
      "Quick check to confirm you're human. This is automatic for most visitors and only appears once per session.";
    const host = document.createElement("div");
    host.className = "hp-turnstile-widget";
    card.appendChild(label);
    card.appendChild(host);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    let widgetId: unknown;
    const cleanup = () => {
      try {
        if (widgetId !== undefined && window.turnstile) {
          window.turnstile.remove(widgetId);
        }
      } catch {
        /* ignore */
      }
      try {
        overlay.remove();
      } catch {
        /* ignore */
      }
    };

    try {
      widgetId = window.turnstile!.render(host, {
        sitekey: key,
        // "interaction-only" keeps the widget invisible unless Managed
        // mode decides this visitor needs a real challenge.
        appearance: "interaction-only",
        callback: (token: string) => {
          cleanup();
          resolve(token);
        },
        "error-callback": () => {
          cleanup();
          reject(new Error("Turnstile reported an error"));
        },
        "expired-callback": () => {
          // Token expired in the widget before we used it. Reset and
          // wait for a fresh callback (the user is mid-interaction).
          try {
            window.turnstile?.reset(widgetId);
          } catch {
            /* ignore */
          }
        },
        "timeout-callback": () => {
          cleanup();
          reject(new Error("Turnstile timed out"));
        },
      });
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

/** Wrap `fetch` so a single 428 `{needs_challenge:true, site_key}`
 *  response is transparently retried after solving a Turnstile.
 *  Anything else (200, 4xx, 5xx, no-body 428, etc.) passes through. */
export async function gatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const first = await fetch(input, init);
  if (first.status !== 428) return first;

  // Clone before reading the JSON so a non-challenge 428 still has its
  // body intact when we hand it back.
  let body: any;
  try {
    body = await first.clone().json();
  } catch {
    return first;
  }
  if (!body?.needs_challenge) return first;

  let token: string;
  try {
    token = await solveTurnstile(body.site_key);
  } catch {
    // Couldn't solve (offline, user closed tab, etc.) — surface the
    // original 428 to the caller so it can render an error.
    return first;
  }

  const headers = new Headers(init?.headers || {});
  headers.set("x-turnstile-token", token);
  return fetch(input, { ...init, headers });
}
