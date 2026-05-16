/**
 * Admin sub-app. Mounted at /api/admin/*.
 *
 * Authentication
 * --------------
 * Admin accounts live in the `admins` D1 table (see migrations/0007_admins.sql):
 *
 *     (username TEXT PRIMARY KEY, password_sha512 TEXT, created_at INTEGER)
 *
 * Rows are inserted manually — there is intentionally no HTTP path for
 * registration. The `password_sha512` column stores the lowercase-hex
 * SHA-512 of the operator's password.
 *
 * On every admin call we expect an `Authorization: Basic …` header. The
 * middleware:
 *   1. Pre-checks a per-IP rate-limit bucket. Failed attempts increment
 *      it; successful logins don't. At 10 failures within 15 minutes the
 *      IP is locked out (429 + retry-after) regardless of credentials.
 *      The site is public to 150k visitors, so the bucket is the only
 *      thing standing between us and someone scripting the login form.
 *   2. Parses the header, looks up the username in D1, computes
 *      SHA-512(provided password), and constant-time compares against
 *      the stored hash.
 *   3. On any failure, bumps the bucket and returns 401.
 *
 * No sessions, no cookies — the SPA replays the Basic header on every
 * admin call (kept in sessionStorage; see src/client/Admin.tsx).
 *
 * Privileged actions
 * ------------------
 * The only one today is `ban`. It is intentionally comprehensive: one
 * call wipes a slug from KV, the moderation table, the `articles` +
 * `article_votes` rows (Top Folios), the full comment subtree + comment
 * votes, the `__total` counter, AND the live Presence DO so the slug
 * disappears from "Currently Being Consulted" in real time for every
 * connected reader.
 */

import { Hono } from "hono";
import { slugify } from "./slug";
import { clientIp } from "./ratelimit";
import type { Env } from "./index";

/* -------------------------------------------------------------------------- */
/*  Login throttle                                                             */
/* -------------------------------------------------------------------------- */

/** Max failed admin login attempts per IP within {@link ADMIN_LOGIN_WINDOW_SEC}.
 *  Sized for "a real operator might fat-finger their password a few times"
 *  and not much more. Successful logins do NOT consume the budget. */
const ADMIN_LOGIN_MAX_FAILS = 10;
const ADMIN_LOGIN_WINDOW_SEC = 60 * 15; // 15 minutes

interface ThrottleState {
  /** True when this IP is currently over its failure budget. */
  blocked: boolean;
  /** Seconds until the window rolls over. */
  retryAfter: number;
}

/** Look at the current fail-count bucket for this IP WITHOUT incrementing
 *  it. We intentionally keep this separate from `bumpLoginFailure` so a
 *  successful login is free — only operators with the wrong password
 *  pay the budget. */
async function checkLoginThrottle(
  kv: KVNamespace,
  ip: string
): Promise<ThrottleState> {
  if (!ip || ip === "unknown") {
    // No usable IP → can't throttle. Falls open. We rely on the global
    // dashboard-level WAF to catch unattributable floods.
    return { blocked: false, retryAfter: 0 };
  }
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / ADMIN_LOGIN_WINDOW_SEC) * ADMIN_LOGIN_WINDOW_SEC;
  const reset = window + ADMIN_LOGIN_WINDOW_SEC;
  const key = `__rl:admin_login:${window}:${ip}`;
  try {
    const raw = await kv.get(key);
    const n = raw ? parseInt(raw, 10) || 0 : 0;
    if (n >= ADMIN_LOGIN_MAX_FAILS) {
      return { blocked: true, retryAfter: Math.max(1, reset - now) };
    }
    return { blocked: false, retryAfter: 0 };
  } catch {
    return { blocked: false, retryAfter: 0 };
  }
}

/** Increment the fail counter for this IP in the current window. */
async function bumpLoginFailure(kv: KVNamespace, ip: string): Promise<void> {
  if (!ip || ip === "unknown") return;
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / ADMIN_LOGIN_WINDOW_SEC) * ADMIN_LOGIN_WINDOW_SEC;
  const key = `__rl:admin_login:${window}:${ip}`;
  try {
    const raw = await kv.get(key);
    const n = raw ? parseInt(raw, 10) || 0 : 0;
    await kv.put(key, String(n + 1), {
      // 2× the window so the key naturally expires after the next slot
      // is also drained — no orphan keys, no manual cleanup.
      expirationTtl: ADMIN_LOGIN_WINDOW_SEC * 2,
    });
  } catch {
    /* fall open on KV errors */
  }
}

/* -------------------------------------------------------------------------- */
/*  Auth primitives                                                           */
/* -------------------------------------------------------------------------- */

/** Constant-time string compare. Lengths differ → still walks the longer
 *  one against a zero so the early-exit on length doesn't reveal info. */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Decode an `Authorization: Basic …` header. Returns null if missing or
 *  malformed (rather than throwing) so callers can branch on it cleanly. */
function parseBasicAuth(header: string | undefined): {
  user: string;
  pass: string;
} | null {
  if (!header) return null;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = atob(m[1]);
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

/** Lowercase-hex SHA-512 of a UTF-8 string. Web Crypto digest output is
 *  an ArrayBuffer; we hex-encode it ourselves because Workers doesn't
 *  ship Node's `Buffer.toString("hex")`. */
async function sha512Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-512", bytes);
  const arr = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, "0");
  }
  return out;
}

interface AdminRow {
  username: string;
  password_sha512: string;
}

/** Look up the username in D1 and check the password. Returns the matched
 *  row on success, null on failure. Unknown usernames still pay the cost
 *  of a dummy SHA-512 + compare so timing doesn't reveal "this username
 *  doesn't exist" vs "this password is wrong". */
async function verifyAdmin(
  db: D1Database,
  user: string,
  pass: string
): Promise<AdminRow | null> {
  if (!user || !pass) {
    // Still compute a hash so we burn the same CPU as a real attempt.
    await sha512Hex(pass || "");
    return null;
  }
  let row: AdminRow | null = null;
  try {
    row = (await db
      .prepare(
        "SELECT username, password_sha512 FROM admins WHERE username = ?"
      )
      .bind(user)
      .first<AdminRow>()) ?? null;
  } catch (e) {
    console.error("admin lookup failed", e);
  }
  // Always hash the supplied password — even if the user doesn't exist —
  // so the wall-clock cost of a probe is independent of username
  // existence. The compare target is a dummy hex string of the same
  // length when no row is found.
  const provided = await sha512Hex(pass);
  const target =
    row?.password_sha512?.toLowerCase() ?? "0".repeat(provided.length);
  const ok = timingSafeEqual(provided, target);
  return ok && row ? row : null;
}

/* -------------------------------------------------------------------------- */
/*  Ban helper — wipes a slug from every surface                              */
/* -------------------------------------------------------------------------- */

interface BanResult {
  slug: string;
  was_cached: boolean;
  comments_deleted: number;
  votes_deleted: number;
  article_row_deleted: boolean;
  article_votes_deleted: number;
  presence_notified: boolean;
}

async function adminBanSlug(slug: string, env: Env): Promise<BanResult> {
  const now = Date.now();

  // 1. KV: drop the cached HTML. Capture whether it was present so we can
  //    decide whether the __total counter needs to be decremented.
  const wasCached = (await env.ARTICLES.get(slug)) !== null;
  if (wasCached) {
    try {
      await env.ARTICLES.delete(slug);
    } catch (e) {
      console.error("admin ban: KV delete failed", slug, e);
    }
  }

  // 2. Moderation table: mark banned (upsert). Reason is fixed so it's
  //    obvious in the DB later who decided this — distinct from the
  //    "auto-flagged…" reasons the LLM sweep writes.
  try {
    await env.DB
      .prepare(
        `INSERT INTO article_moderation (slug, status, reason, enqueued_at, checked_at)
         VALUES (?, 'banned', 'admin ban', ?, ?)
         ON CONFLICT(slug) DO UPDATE SET status='banned', reason='admin ban', checked_at=excluded.checked_at`
      )
      .bind(slug, now, now)
      .run();
  } catch (e) {
    console.error("admin ban: moderation upsert failed", slug, e);
  }

  // 3. Top Folios: nuke the denormalized score row and every vote that
  //    fed into it. Without this the slug keeps topping the sidebar even
  //    after the article itself is gone (see step 1).
  let articleVotesDeleted = 0;
  let articleRowDeleted = false;
  try {
    const r1 = await env.DB
      .prepare("DELETE FROM article_votes WHERE slug = ?")
      .bind(slug)
      .run();
    articleVotesDeleted = Number(r1.meta?.changes ?? 0);
    const r2 = await env.DB
      .prepare("DELETE FROM articles WHERE slug = ?")
      .bind(slug)
      .run();
    articleRowDeleted = Number(r2.meta?.changes ?? 0) > 0;
  } catch (e) {
    console.error("admin ban: articles delete failed", slug, e);
  }

  // 4. Comments + their votes. Order matters: votes first because of the
  //    FK from votes(comment_id) → comments(id) (no ON DELETE CASCADE).
  //    We delete every comment for the slug — not a subtree-by-id — so
  //    the self-referential parent_id FK can't trip either.
  let commentsDeleted = 0;
  let commentVotesDeleted = 0;
  try {
    const v = await env.DB
      .prepare(
        "DELETE FROM votes WHERE comment_id IN (SELECT id FROM comments WHERE slug = ?)"
      )
      .bind(slug)
      .run();
    commentVotesDeleted = Number(v.meta?.changes ?? 0);
    const c2 = await env.DB
      .prepare("DELETE FROM comments WHERE slug = ?")
      .bind(slug)
      .run();
    commentsDeleted = Number(c2.meta?.changes ?? 0);
  } catch (e) {
    console.error("admin ban: comments delete failed", slug, e);
  }

  // 5. __total counter (best-effort; only if it was actually present and
  //    we removed a cached row, so the count stays honest).
  if (wasCached) {
    try {
      const cur = await env.ARTICLES.get("__total");
      if (cur !== null) {
        const n = parseInt(cur, 10);
        if (Number.isFinite(n) && n > 0) {
          await env.ARTICLES.put("__total", String(n - 1));
        }
      }
    } catch {}
  }

  // 6. Presence DO: kick any live readers off this slug so it disappears
  //    from the "Currently Being Consulted" panel for everyone else in
  //    real time. The DO clears its in-memory title for the slug and
  //    re-broadcasts the top-N immediately.
  let presenceNotified = false;
  try {
    const id = env.PRESENCE.idFromName("global");
    const stub = env.PRESENCE.get(id);
    const resp = await stub.fetch(
      new Request("https://presence-do/__admin/ban", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      })
    );
    presenceNotified = resp.ok;
  } catch (e) {
    console.error("admin ban: presence notify failed", slug, e);
  }

  return {
    slug,
    was_cached: wasCached,
    comments_deleted: commentsDeleted,
    votes_deleted: commentVotesDeleted,
    article_row_deleted: articleRowDeleted,
    article_votes_deleted: articleVotesDeleted,
    presence_notified: presenceNotified,
  };
}

/* -------------------------------------------------------------------------- */
/*  Hono routes                                                                */
/* -------------------------------------------------------------------------- */

export function createAdminApp() {
  const app = new Hono<{ Bindings: Env }>();

  // Gate every route. The `WWW-Authenticate` header is intentionally
  // omitted — we don't want the browser's native auth dialog popping up
  // for the SPA's fetch calls; the SPA renders its own login form.
  //
  // Failure path always returns 401 with the same body / timing as a
  // bad-credentials response so a probe can't tell "blocked" from
  // "wrong password" beyond the 429 vs 401 status code.
  app.use("/api/admin/*", async (c, next) => {
    const ip = clientIp(c);

    // 1. Pre-check the bucket. If we're already over, refuse outright.
    const throttle = await checkLoginThrottle(c.env.ARTICLES, ip);
    if (throttle.blocked) {
      return c.json(
        { error: "too many failed attempts; try again later" },
        429,
        { "retry-after": String(throttle.retryAfter) }
      );
    }

    // 2. Verify the Basic header. Any failure here pays the bucket.
    const creds = parseBasicAuth(c.req.header("authorization"));
    if (!creds) {
      await bumpLoginFailure(c.env.ARTICLES, ip);
      return c.json({ error: "unauthorized" }, 401);
    }
    const admin = await verifyAdmin(c.env.DB, creds.user, creds.pass);
    if (!admin) {
      await bumpLoginFailure(c.env.ARTICLES, ip);
      return c.json({ error: "unauthorized" }, 401);
    }

    // Make the authenticated identity available to downstream handlers
    // in case we ever want to log "who banned what".
    (c as any).set?.("admin_user", admin.username);

    await next();
  });

  /** Login probe. SPA hits this after the user submits the login form;
   *  200 means "your Basic header is good, store it and unlock the UI". */
  app.post("/api/admin/check", (c) => {
    const user = (c as any).get?.("admin_user") as string | undefined;
    return c.json({ ok: true, user: user ?? null });
  });

  /** Comprehensive ban. Body: { slug: string }. The slug is normalized
   *  with the same `slugify` the rest of the app uses, so the operator
   *  can paste either "Foo Bar" or "foo-bar". */
  app.post("/api/admin/ban", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const slug = slugify(String(body?.slug ?? ""));
    if (!slug) return c.json({ error: "missing or invalid slug" }, 400);
    const result = await adminBanSlug(slug, c.env);
    return c.json(result);
  });

  return app;
}
