/**
 * Admin panel — single-page React surface for the privileged operator.
 *
 * Auth model:
 *   - Operator accounts live in the D1 `admins` table (manually seeded).
 *     The username + SHA-512(password) row gates access — see
 *     src/worker/admin.ts for the verifier and the per-IP login throttle.
 *   - We POST credentials base64-encoded as HTTP Basic to /api/admin/check.
 *     A 200 response means the password is good; we stash the encoded
 *     header in sessionStorage so we can resend it on subsequent admin
 *     calls (without keeping the plaintext password around). sessionStorage
 *     (not localStorage) so closing the tab logs out.
 *   - Every admin API call carries `Authorization: Basic …`. A 401 anywhere
 *     drops us back to the login screen.
 *
 * The only privileged action wired up today is `ban`, which calls
 * /api/admin/ban. That endpoint comprehensively nukes a slug from
 * everywhere it could be lingering (KV, articles, article_votes,
 * article_moderation, comments, votes, the __total counter, AND the
 * live Presence DO's "Currently Being Consulted" list). See
 * src/worker/admin.ts for the breakdown.
 */

import { useCallback, useEffect, useState } from "react";

const AUTH_STORAGE_KEY = "halupedia_admin_auth";

function loadStoredAuth(): string | null {
  try {
    return window.sessionStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeAuth(header: string | null): void {
  try {
    if (header == null) {
      window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(AUTH_STORAGE_KEY, header);
    }
  } catch {
    /* private mode / quota — auth survives only in-memory for this session */
  }
}

/** Helper: every admin fetch must carry the Basic header. Returns the
 *  Response so callers can branch on status (and reset auth on 401). */
async function adminFetch(
  authHeader: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers || {});
  headers.set("authorization", authHeader);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

interface BanResult {
  slug: string;
  was_cached: boolean;
  comments_deleted: number;
  votes_deleted: number;
  article_row_deleted: boolean;
  article_votes_deleted: number;
  presence_notified: boolean;
}

export function Admin() {
  // Initialize from sessionStorage so a page refresh inside the same tab
  // keeps you signed in. null = logged out; non-null = the Basic header
  // we should attach to admin calls.
  const [auth, setAuth] = useState<string | null>(() => loadStoredAuth());

  // Validate any stored auth once on mount. If the password rotated since
  // the last session, the stored header is stale — drop it.
  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await adminFetch(auth, "/api/admin/check", {
          method: "POST",
        });
        if (cancelled) return;
        if (res.status === 401) {
          storeAuth(null);
          setAuth(null);
        }
      } catch {
        /* network blip; keep the header optimistically */
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally only re-run this when `auth` flips between
    // null and non-null, not on every render.
  }, [auth]);

  const onLogout = useCallback(() => {
    storeAuth(null);
    setAuth(null);
  }, []);

  return (
    <section className="admin-panel" aria-label="Admin panel">
      <header className="admin-header">
        <h1>Admin</h1>
        {auth && (
          <button
            type="button"
            className="admin-logout"
            onClick={onLogout}
          >
            Log out
          </button>
        )}
      </header>

      {!auth ? (
        <LoginForm onSuccess={(h) => { storeAuth(h); setAuth(h); }} />
      ) : (
        <BanForm
          authHeader={auth}
          onAuthExpired={() => {
            storeAuth(null);
            setAuth(null);
          }}
        />
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Login form                                                                 */
/* -------------------------------------------------------------------------- */

function LoginForm({ onSuccess }: { onSuccess: (authHeader: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!password) {
        setError("Password required.");
        return;
      }
      setSubmitting(true);
      setError(null);
      // btoa handles ASCII fine. The password is operator-set so we don't
      // need to worry about non-ASCII bytes in practice; if we ever did,
      // we'd switch to TextEncoder + manual base64.
      const header = `Basic ${btoa(`${username}:${password}`)}`;
      try {
        const res = await adminFetch(header, "/api/admin/check", {
          method: "POST",
        });
        if (res.status === 401) {
          setError("Wrong username or password.");
          return;
        }
        if (res.status === 429) {
          const j: any = await res.json().catch(() => ({}));
          setError(j?.error || "Too many attempts. Try again later.");
          return;
        }
        if (!res.ok) {
          setError(`Login failed (${res.status}).`);
          return;
        }
        onSuccess(header);
      } catch (err: any) {
        setError(err?.message || "Network error.");
      } finally {
        setSubmitting(false);
      }
    },
    [username, password, onSuccess]
  );

  return (
    <form className="admin-login" onSubmit={onSubmit}>
      <label className="admin-field">
        <span>Username</span>
        <input
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={submitting}
          autoFocus
        />
      </label>
      <label className="admin-field">
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
        />
      </label>
      {error && <p className="admin-error">{error}</p>}
      <button type="submit" className="admin-submit" disabled={submitting}>
        {submitting ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ban form                                                                   */
/* -------------------------------------------------------------------------- */

function BanForm({
  authHeader,
  onAuthExpired,
}: {
  authHeader: string;
  onAuthExpired: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BanResult | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const cleaned = slug.trim();
      if (!cleaned) {
        setError("Enter a slug.");
        return;
      }
      // Mild client-side confirmation. Server normalises again anyway.
      if (
        !window.confirm(
          `Ban "${cleaned}"?\n\nThis deletes the article HTML, all comments and votes for it, its score row, and removes it from the "Currently Being Consulted" panel for all live readers. The slug will be refused if regenerated.`
        )
      ) {
        return;
      }
      setSubmitting(true);
      setError(null);
      setResult(null);
      try {
        const res = await adminFetch(authHeader, "/api/admin/ban", {
          method: "POST",
          body: JSON.stringify({ slug: cleaned }),
        });
        if (res.status === 401) {
          onAuthExpired();
          return;
        }
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          setError(j?.error || `Ban failed (${res.status}).`);
          return;
        }
        const j = (await res.json()) as BanResult;
        setResult(j);
        setSlug("");
      } catch (err: any) {
        setError(err?.message || "Network error.");
      } finally {
        setSubmitting(false);
      }
    },
    [slug, authHeader, onAuthExpired]
  );

  return (
    <div className="admin-section">
      <h2>Ban a slug</h2>
      <p className="admin-section-blurb">
        Comprehensive nuke. Wipes the article HTML, comments, votes, score
        row, and live-presence entry. The slug is added to the moderation
        ban list so any future regeneration request returns the redacted
        notice.
      </p>
      <form className="admin-ban-form" onSubmit={onSubmit}>
        <input
          type="text"
          className="admin-slug-input"
          placeholder="slug-to-ban or 'Original Title'"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          disabled={submitting}
          autoFocus
        />
        <button
          type="submit"
          className="admin-submit admin-submit-danger"
          disabled={submitting || !slug.trim()}
        >
          {submitting ? "Banning…" : "Ban"}
        </button>
      </form>
      {error && <p className="admin-error">{error}</p>}
      {result && <BanResultPanel result={result} />}
    </div>
  );
}

function BanResultPanel({ result }: { result: BanResult }) {
  return (
    <div className="admin-result">
      <p className="admin-result-headline">
        Banned <code>{result.slug}</code>.
      </p>
      <ul className="admin-result-list">
        <li>
          KV cache:{" "}
          <strong>{result.was_cached ? "deleted" : "was not present"}</strong>
        </li>
        <li>
          Top Folios row:{" "}
          <strong>
            {result.article_row_deleted ? "deleted" : "no row to delete"}
          </strong>{" "}
          ({result.article_votes_deleted} article votes removed)
        </li>
        <li>
          Comments: <strong>{result.comments_deleted} removed</strong>{" "}
          ({result.votes_deleted} comment votes removed)
        </li>
        <li>
          Live presence:{" "}
          <strong>
            {result.presence_notified
              ? "notified — sidebars refreshed"
              : "notify failed (DO unreachable?)"}
          </strong>
        </li>
      </ul>
    </div>
  );
}
