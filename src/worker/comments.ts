import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  hallucinateIdentity,
  fallbackIdentity,
  type Identity,
} from "./identity";
import { slugify } from "./slug";
import ipaddr from "ipaddr.js";
import { rateLimit, clientIp } from "./ratelimit";
import { moderateCommentNow } from "./moderation";

export interface CommentsEnv {
  DB: D1Database;
  ARTICLES: KVNamespace;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_MODERATION_MODEL?: string;
  IDENT_PER_IP_PER_HOUR?: string;
  ARTICLE_VOTE_PER_USER_PER_HOUR?: string;
  ARTICLE_VOTE_PER_IP_PER_HOUR?: string;
  ARTICLE_VOTE_PER_SUBNET_PER_HOUR?: string;
  ARTICLE_VOTE_PER_USER_PER_MINUTE?: string;
  COMMENT_PER_IP_PER_HOUR?: string;
  COMMENT_PER_IP_PER_MINUTE?: string;
}

const COOKIE_NAME = "hu_uid";
// Browsers (and Hono) cap cookie Max-Age at 400 days per RFC 6265bis. We
// refresh the cookie on every authenticated request so active users never
// actually expire.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400;
const MAX_BODY_LEN = 2000;
const ARTICLE_VOTE_DEFAULTS = {
  userPerHour: 120,
  ipPerHour: 240,
  subnetPerHour: 600,
  userPerMinute: 30,
};

const COMMENT_CREATION_DEFAULTS = {
  ipPerHour: 90,
  ipPerMinute: 15,
};

export interface UserRow {
  id: string;
  name: string;
  username: string;
  created_at: number;
}

export interface CommentRow {
  id: string;
  slug: string;
  parent_id: string | null;
  user_id: string;
  body: string;
  created_at: number;
  score: number;
}

export interface CommentDTO {
  id: string;
  parent_id: string | null;
  user: { id: string; name: string; username: string };
  body: string;
  created_at: number;
  score: number;
  voted: boolean;
  children: CommentDTO[];
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function setIdentityCookie(c: any, userId: string, secure: boolean): void {
  setCookie(c, COOKIE_NAME, userId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure,
    maxAge: COOKIE_MAX_AGE,
  });
}

async function lookupUser(
  db: D1Database,
  id: string | undefined
): Promise<UserRow | null> {
  if (!id) return null;
  const row = await db
    .prepare("SELECT id, name, username, created_at FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  return row ?? null;
}

/**
 * Ensure the request has an associated user row. If the cookie points at an
 * unknown id (or there's no cookie at all) we hallucinate a fresh identity,
 * persist it, and stamp the cookie. Returns the user.
 *
 * Username collisions are extremely unlikely but cheap to retry: we attempt
 * insertion up to 4 times with progressively varied usernames.
 */
async function ensureUser(
  c: any,
  env: CommentsEnv
): Promise<UserRow> {
  const secure = new URL(c.req.url).protocol === "https:";
  const existingId = getCookie(c, COOKIE_NAME);
  const existing = await lookupUser(env.DB, existingId);
  if (existing) {
    // Refresh the cookie so its 400-day window slides forward on every visit.
    setIdentityCookie(c, existing.id, secure);
    return existing;
  }

  const id = crypto.randomUUID();

  // Per-IP guard on identity creation — stops UA-forging botnets from
  // burning tokens by repeatedly minting fresh users.
  const ip = clientIp(c);
  const perHour = parseInt(env.IDENT_PER_IP_PER_HOUR || "10", 10);
  const rl = await rateLimit({
    kv: env.ARTICLES,
    bucket: "ident",
    ip,
    limit: perHour,
    windowSec: 3600,
  });
  if (!rl.ok) {
    const err: any = new Error(
      `slow down — at most ${rl.limit} new identities per hour from one address`
    );
    err.status = 429;
    err.retryAfter = rl.retryAfter;
    throw err;
  }

  // Try AI first; fall back to local generator on error.
  let identity: Identity;
  try {
    identity = await hallucinateIdentity(
      env.OPENROUTER_API_KEY,
      env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite"
    );
  } catch {
    identity = fallbackIdentity(id);
  }

  const created_at = Date.now();
  let attempt = 0;
  let usernameToTry = identity.username;
  while (attempt < 5) {
    try {
      await env.DB
        .prepare(
          "INSERT INTO users (id, name, username, created_at) VALUES (?, ?, ?, ?)"
        )
        .bind(id, identity.name, usernameToTry, created_at)
        .run();
      setIdentityCookie(c, id, secure);
      return {
        id,
        name: identity.name,
        username: usernameToTry,
        created_at,
      };
    } catch (err: any) {
      // UNIQUE constraint on username — retry with a numeric suffix.
      const msg = String(err?.message ?? err);
      if (!/UNIQUE|constraint/i.test(msg)) throw err;
      attempt++;
      const suffix = Math.floor(Math.random() * 9999);
      usernameToTry = `${identity.username.slice(0, 18)}_${suffix}`;
    }
  }
  throw new Error("could not allocate username after retries");
}

function rowToDTO(
  row: CommentRow,
  user: { id: string; name: string; username: string },
  voted: boolean
): CommentDTO {
  return {
    id: row.id,
    parent_id: row.parent_id,
    user,
    body: row.body,
    created_at: row.created_at,
    score: row.score,
    voted,
    children: [],
  };
}

type SortMode = "recommended" | "top" | "newest";

function parseSort(raw: string | undefined): SortMode {
  if (raw === "top" || raw === "newest" || raw === "recommended") return raw;
  return "recommended";
}

/**
 * "Hot score" used for the default Recommended ranking.
 *
 *     hot = sqrt(score) / (age_hours + 2) ^ 0.8
 *
 * sqrt-scaling the score keeps a runaway 40-pt comment from completely
 * burying solid 5–10-pt comments while still letting it win — the gap
 * narrows from 40× (linear) to ~6× (sqrt(40) vs sqrt(1)). The softer 0.8
 * gravity (vs HN's 1.5) suits a small site where vote traffic is sparse:
 * well-loved comments stay near the top for a couple of days instead of
 * dropping off in hours. Tiebreak on recency.
 *
 * No additive floor: every comment author gets a guaranteed score=1
 * auto-upvote, and adding `1 +` to that doubled fresh-comment ranking,
 * which let brand-new 1-pt comments leapfrog 40-pt ones from earlier in
 * the day. Pure sqrt(score) over softened gravity gives fresh comments
 * a foothold without overrunning genuinely well-loved ones.
 *
 * Why sqrt and not log10: D1's local miniflare doesn't authorize log10;
 * sqrt and pow are always available, and the ranking shape is similar.
 */
function rootOrderClause(sort: SortMode): string {
  switch (sort) {
    case "newest":
      return "ORDER BY created_at DESC";
    case "top":
      return "ORDER BY score DESC, created_at DESC";
    case "recommended":
    default:
  return (
        "ORDER BY (sqrt(CAST(score AS REAL)) / " +
        "pow(((? - created_at) / 3600000.0) + 2.0, 0.8)) DESC, " +
        "created_at DESC"
      );
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ipToSubnet(ip: string): string {
  if (!ip || ip === "unknown") return "unknown";
  try {
    const parsed = ipaddr.parse(ip);
    if (parsed.kind() === "ipv4") {
      const bytes = parsed.toByteArray();
      return `${bytes[0]}.${bytes[1]}.${bytes[2]}.0/24`;
    }

    if (parsed.kind() === "ipv6") {
      if (parsed.isIPv4MappedAddress && parsed.isIPv4MappedAddress()) {
        const ipv4 = parsed.toIPv4Address();
        const bytes = ipv4.toByteArray();
        return `${bytes[0]}.${bytes[1]}.${bytes[2]}.0/24`;
      }

      const bytes = parsed.toByteArray();
      const parts = [
        (bytes[0] << 8) | bytes[1],
        (bytes[2] << 8) | bytes[3],
        (bytes[4] << 8) | bytes[5],
        (bytes[6] << 8) | bytes[7],
      ].map((n) => n.toString(16));
      return `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}::/64`;
    }
  } catch {
    return ip;
  }
  return ip;
}

async function enforceArticleVoteRateLimits(
  c: any,
  env: CommentsEnv,
  userId: string
): Promise<void> {
  const ip = clientIp(c);
  const subnet = ipToSubnet(ip);

  const checks = [
    {
      scope: "user/hour",
      run: () =>
        rateLimit({
          kv: env.ARTICLES,
          bucket: "article-vote",
          ip: `user:${userId}`,
          limit: parsePositiveInt(
            env.ARTICLE_VOTE_PER_USER_PER_HOUR,
            ARTICLE_VOTE_DEFAULTS.userPerHour
          ),
          windowSec: 3600,
        }),
    },
    {
      scope: "ip/hour",
      run: () =>
        rateLimit({
          kv: env.ARTICLES,
          bucket: "article-vote",
          ip: `ip:${ip}`,
          limit: parsePositiveInt(
            env.ARTICLE_VOTE_PER_IP_PER_HOUR,
            ARTICLE_VOTE_DEFAULTS.ipPerHour
          ),
          windowSec: 3600,
        }),
    },
    {
      scope: "subnet/hour",
      run: () =>
        rateLimit({
          kv: env.ARTICLES,
          bucket: "article-vote",
          ip: `subnet:${subnet}`,
          limit: parsePositiveInt(
            env.ARTICLE_VOTE_PER_SUBNET_PER_HOUR,
            ARTICLE_VOTE_DEFAULTS.subnetPerHour
          ),
          windowSec: 3600,
        }),
    },
    {
      scope: "user/minute",
      run: () =>
        rateLimit({
          kv: env.ARTICLES,
          bucket: "article-vote",
          ip: `user:${userId}:burst`,
          limit: parsePositiveInt(
            env.ARTICLE_VOTE_PER_USER_PER_MINUTE,
            ARTICLE_VOTE_DEFAULTS.userPerMinute
          ),
          windowSec: 60,
        }),
    },
  ];

  for (const { scope, run } of checks) {
    const result = await run();
    if (result.ok) continue;
    const err: any = new Error(
      `vote limit exceeded (${scope}), max ${result.limit} per window`
    );
    err.status = 429;
    err.retryAfter = result.retryAfter;
    throw err;
  }
}

async function enforceCommentCreationRateLimits(
  c: any,
  env: CommentsEnv
): Promise<void> {
  const ip = clientIp(c);

  const checks = [
    {
      scope: "ip/hour",
      run: () =>
        rateLimit({
          kv: env.ARTICLES,
          bucket: "comment-create",
          ip: `ip:${ip}`,
          limit: parsePositiveInt(
            env.COMMENT_PER_IP_PER_HOUR,
            COMMENT_CREATION_DEFAULTS.ipPerHour
          ),
          windowSec: 3600,
        }),
    },
    {
      scope: "ip/minute",
      run: () =>
        rateLimit({
          kv: env.ARTICLES,
          bucket: "comment-create",
          ip: `ip:${ip}:burst`,
          limit: parsePositiveInt(
            env.COMMENT_PER_IP_PER_MINUTE,
            COMMENT_CREATION_DEFAULTS.ipPerMinute
          ),
          windowSec: 60,
        }),
    },
  ];

  for (const { scope, run } of checks) {
    const result = await run();
    if (result.ok) continue;
    const err: any = new Error(
      `comment limit exceeded (${scope}), max ${result.limit} per window`
    );
    err.status = 429;
    err.retryAfter = result.retryAfter;
    throw err;
  }
}

function compareDTO(sort: SortMode): (a: CommentDTO, b: CommentDTO) => number {
  if (sort === "newest") return (a, b) => b.created_at - a.created_at;
  if (sort === "top")
    return (a, b) => b.score - a.score || b.created_at - a.created_at;
  // recommended — must mirror rootOrderClause exactly
  return (a, b) => {
    const now = Date.now();
    const ha =
      Math.sqrt(a.score) /
      Math.pow((now - a.created_at) / 3600000 + 2, 0.8);
    const hb =
      Math.sqrt(b.score) /
      Math.pow((now - b.created_at) / 3600000 + 2, 0.8);
    return hb - ha || b.created_at - a.created_at;
  };
}

function buildTree(flat: CommentDTO[], sort: SortMode): CommentDTO[] {
  const byId = new Map<string, CommentDTO>();
  for (const c of flat) byId.set(c.id, c);
  const roots: CommentDTO[] = [];
  for (const c of flat) {
    if (c.parent_id && byId.has(c.parent_id)) {
      byId.get(c.parent_id)!.children.push(c);
    } else {
      roots.push(c);
    }
  }
  // The page_roots CTE picks the right roots for this page in the chosen
  // order, but the outer query has to ORDER BY created_at ASC to satisfy
  // the recursive descendant join — so by the time `flat` reaches us, root
  // order is lost. Re-apply the chosen sort here (and recursively to every
  // descendant subtree).
  const cmp = compareDTO(sort);
  const sortRecursive = (list: CommentDTO[]) => {
    list.sort(cmp);
    list.forEach((c) => sortRecursive(c.children));
  };
  sortRecursive(roots);
  return roots;
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                     */
/* -------------------------------------------------------------------------- */

export function createCommentsApp() {
  const app = new Hono<{ Bindings: CommentsEnv }>();

  /** Current viewer; null until they comment for the first time. */
  app.get("/api/me", async (c) => {
    const id = getCookie(c, COOKIE_NAME);
    const user = await lookupUser(c.env.DB, id);
    if (!user) return c.json({ user: null });
    return c.json({
      user: { id: user.id, name: user.name, username: user.username },
    });
  });

  /** Threaded comments for an article slug, paginated by ROOT comment.
   *
   *   ?offset=0&limit=50&sort=recommended|top|newest
   *
   * Each page returns up to `limit` top-level comments plus their full
   * descendant subtrees. Default sort is "recommended" (HN-style hot score
   * — score / (age_hours+2)^1.5), so brand-new comments surface immediately
   * before sliding down as they age. */
  app.get("/api/comments/:slug", async (c) => {
    const slug = slugify(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);

    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1),
      200
    );
    const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
    const sort = parseSort(c.req.query("sort"));

    const viewerId = getCookie(c, COOKIE_NAME);
    const viewer = await lookupUser(c.env.DB, viewerId);

    // Counts come from SQL — the previous client-side counter blew up with
    // O(n) work in JS for slugs with thousands of comments.
    const [totalRow, rootsRow] = await Promise.all([
      c.env.DB
        .prepare("SELECT COUNT(*) AS n FROM comments WHERE slug = ?")
        .bind(slug)
        .first<{ n: number }>(),
      c.env.DB
        .prepare(
          "SELECT COUNT(*) AS n FROM comments WHERE slug = ? AND parent_id IS NULL"
        )
        .bind(slug)
        .first<{ n: number }>(),
    ]);
    const total = totalRow?.n ?? 0;
    const rootsTotal = rootsRow?.n ?? 0;

    // Pull a page of top-level comments + every descendant in their threads
    // via a recursive CTE. One round trip, regardless of thread depth.
    const orderClause = rootOrderClause(sort);
    const now = Date.now();
    // Recommended sort needs an extra ?-bind for the current timestamp; the
    // others don't. Build the bind list accordingly.
    const rootBinds: any[] =
      sort === "recommended" ? [slug, now, limit, offset] : [slug, limit, offset];

    const { results } = await c.env.DB
      .prepare(
        `WITH RECURSIVE
           page_roots AS (
             SELECT id FROM comments
              WHERE slug = ? AND parent_id IS NULL
              ${orderClause}
              LIMIT ? OFFSET ?
           ),
           thread(id) AS (
             SELECT id FROM page_roots
             UNION ALL
             SELECT c.id FROM comments c JOIN thread t ON c.parent_id = t.id
           )
         SELECT c.id, c.slug, c.parent_id, c.user_id, c.body, c.created_at, c.score,
                u.name AS u_name, u.username AS u_username
           FROM comments c
           JOIN users u ON u.id = c.user_id
          WHERE c.id IN (SELECT id FROM thread)
          ORDER BY c.created_at ASC`
      )
      .bind(...rootBinds)
      .all<CommentRow & { u_name: string; u_username: string }>();

    let votedSet = new Set<string>();
    if (viewer && results.length > 0) {
      const ids = results.map((r) => r.id);
      // SQLite default param limit is 999. Page sizes are bounded so this
      // is rarely an issue, but huge subtrees + 200 roots could approach it.
      const CHUNK = 800;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const placeholders = slice.map(() => "?").join(",");
        const v = await c.env.DB
          .prepare(
            `SELECT comment_id FROM votes WHERE user_id = ? AND comment_id IN (${placeholders})`
          )
          .bind(viewer.id, ...slice)
          .all<{ comment_id: string }>();
        for (const r of v.results) votedSet.add(r.comment_id);
      }
    }

    const flat = results.map((r) =>
      rowToDTO(
        r,
        { id: r.user_id, name: r.u_name, username: r.u_username },
        votedSet.has(r.id)
      )
    );
    const tree = buildTree(flat, sort);

    return c.json({
      slug,
      sort,
      total,
      roots_total: rootsTotal,
      offset,
      limit,
      has_more: offset + tree.length < rootsTotal,
      comments: tree,
      user: viewer
        ? { id: viewer.id, name: viewer.name, username: viewer.username }
        : null,
    });
  });

  /** Post a comment (creates a user on first contact). */
  app.post("/api/comments/:slug", async (c) => {
    const slug = slugify(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);

    let payload: any;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const body = typeof payload?.body === "string" ? payload.body.trim() : "";
    const parent_id =
      typeof payload?.parent_id === "string" && payload.parent_id
        ? payload.parent_id
        : null;

    if (!body) return c.json({ error: "comment is empty" }, 400);
    if (body.length > MAX_BODY_LEN) {
      return c.json({ error: `comment exceeds ${MAX_BODY_LEN} chars` }, 400);
    }

    if (parent_id) {
      const parent = await c.env.DB
        .prepare("SELECT id, slug FROM comments WHERE id = ?")
        .bind(parent_id)
        .first<{ id: string; slug: string }>();
      if (!parent || parent.slug !== slug) {
        return c.json({ error: "parent not found" }, 400);
      }
    }

    let user: UserRow;
    try {
      user = await ensureUser(c, c.env);
      await enforceCommentCreationRateLimits(c, c.env);
    } catch (e: any) {
      if (e?.status === 429) {
        return c.json({ error: e.message }, 429, {
          "retry-after": String(e.retryAfter ?? 60),
        });
      }
      throw e;
    }

    const id = crypto.randomUUID();
    const created_at = Date.now();

    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO comments (id, slug, parent_id, user_id, body, created_at, score)
           VALUES (?, ?, ?, ?, ?, ?, 1)`
        )
        .bind(id, slug, parent_id, user.id, body, created_at),
      // Author auto-upvotes their own post (matches HN behavior).
      c.env.DB
        .prepare(
          `INSERT INTO votes (user_id, comment_id, created_at) VALUES (?, ?, ?)`
        )
        .bind(user.id, id, created_at),
    ]);

    const dto: CommentDTO = {
      id,
      parent_id,
      user: { id: user.id, name: user.name, username: user.username },
      body,
      created_at,
      score: 1,
      voted: true,
      children: [],
    };

    // Background moderation: accept the comment immediately, then judge it
    // out-of-band. If banned, moderateCommentNow deletes it (and its votes).
    c.executionCtx.waitUntil(
      moderateCommentNow(id, body, c.env).catch((e) =>
        console.error("comment moderation failed", e)
      )
    );

    return c.json({
      comment: dto,
      user: { id: user.id, name: user.name, username: user.username },
    });
  });

  /** Toggle upvote on a comment. */
  app.post("/api/comments/:id/vote", async (c) => {
    const commentId = c.req.param("id");
    const target = await c.env.DB
      .prepare("SELECT id, score FROM comments WHERE id = ?")
      .bind(commentId)
      .first<{ id: string; score: number }>();
    if (!target) return c.json({ error: "comment not found" }, 404);

    let user: UserRow;
    try {
      user = await ensureUser(c, c.env);
      await enforceArticleVoteRateLimits(c, c.env, user.id);
    } catch (e: any) {
      if (e?.status === 429) {
        return c.json({ error: e.message }, 429, {
          "retry-after": String(e.retryAfter ?? 60),
        });
      }
      throw e;
    }

    const existing = await c.env.DB
      .prepare(
        "SELECT user_id FROM votes WHERE user_id = ? AND comment_id = ?"
      )
      .bind(user.id, commentId)
      .first();

    if (existing) {
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            "DELETE FROM votes WHERE user_id = ? AND comment_id = ?"
          )
          .bind(user.id, commentId),
        c.env.DB
          .prepare(
            "UPDATE comments SET score = MAX(score - 1, 0) WHERE id = ?"
          )
          .bind(commentId),
      ]);
      return c.json({
        voted: false,
        score: Math.max(target.score - 1, 0),
        user: { id: user.id, name: user.name, username: user.username },
      });
    } else {
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            "INSERT INTO votes (user_id, comment_id, created_at) VALUES (?, ?, ?)"
          )
          .bind(user.id, commentId, Date.now()),
        c.env.DB
          .prepare("UPDATE comments SET score = score + 1 WHERE id = ?")
          .bind(commentId),
      ]);
      return c.json({
        voted: true,
        score: target.score + 1,
        user: { id: user.id, name: user.name, username: user.username },
      });
    }
  });

  /* ------------------------------------------------------------------ */
  /*  Article-level upvotes                                              */
  /*                                                                     */
  /*  KV stores the article HTML; D1 stores the score + per-user vote    */
  /*  rows. Rows in `articles` are created lazily on the first upvote so */
  /*  we don't have a table entry for every generated slug — most never  */
  /*  attract a vote and don't need one.                                 */
  /* ------------------------------------------------------------------ */

  /** Vote state for one article: { score, voted }. Cheap call (no auth
   *  required if the user has no cookie — they just see voted=false). */
  app.get("/api/articles/:slug/meta", async (c) => {
    const slug = slugify(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);

    const row = await c.env.DB
      .prepare("SELECT score FROM articles WHERE slug = ?")
      .bind(slug)
      .first<{ score: number }>();

    let voted = false;
    const viewerId = getCookie(c, COOKIE_NAME);
    if (viewerId) {
      const v = await c.env.DB
        .prepare(
          "SELECT 1 AS x FROM article_votes WHERE user_id = ? AND slug = ?"
        )
        .bind(viewerId, slug)
        .first<{ x: number }>();
      voted = !!v;
    }

    return c.json({ slug, score: row?.score ?? 0, voted });
  });

  /** Top-N articles by score. Used by the "Top Folios" sidebar panel.
   *  ?limit=5 default, capped at 25. Cheap: indexed scan on (score DESC). */
  app.get("/api/articles/top", async (c) => {
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") || "5", 10) || 5, 1),
      25
    );
    const { results } = await c.env.DB
      .prepare(
        `SELECT slug, title, score
           FROM articles
          WHERE score > 0
          ORDER BY score DESC, created_at ASC
          LIMIT ?`
      )
      .bind(limit)
      .all<{ slug: string; title: string; score: number }>();
    return c.json({ items: results });
  });

  /** Toggle an upvote on an article. Mirrors the comment-vote flow:
   *  ensureUser → check existing → INSERT/DELETE in a batch with the
   *  score update. Returns the new {score, voted} so the client can
   *  reconcile its optimistic update. */
  app.post("/api/articles/:slug/vote", async (c) => {
    const slug = slugify(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);

    // Refuse to vote on slugs the SPA owns (search/all-entries) or the
    // homepage. The client doesn't expose the button on those views, but
    // a hand-rolled POST should still get 400'd.
    if (slug === "all-entries" || slug === "search" || slug === "halupedia") {
      return c.json({ error: "this entry is not votable" }, 400);
    }

    // Confirm the article actually exists in KV before letting anyone
    // vote on it. This stops a malicious POST from inserting an
    // articles-row for a never-generated slug, polluting the top panel.
    const exists = await c.env.ARTICLES.get(slug);
    if (!exists) return c.json({ error: "entry not found" }, 404);

    let user: UserRow;
    try {
      user = await ensureUser(c, c.env);
      await enforceArticleVoteRateLimits(c, c.env, user.id);
    } catch (e: any) {
      if (e?.status === 429) {
        return c.json({ error: e.message }, 429, {
          "retry-after": String(e.retryAfter ?? 60),
        });
      }
      throw e;
    }

    const existing = await c.env.DB
      .prepare(
        "SELECT user_id FROM article_votes WHERE user_id = ? AND slug = ?"
      )
      .bind(user.id, slug)
      .first();

    if (existing) {
      // Retract upvote.
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            "DELETE FROM article_votes WHERE user_id = ? AND slug = ?"
          )
          .bind(user.id, slug),
        c.env.DB
          .prepare(
            "UPDATE articles SET score = MAX(score - 1, 0) WHERE slug = ?"
          )
          .bind(slug),
      ]);
      const row = await c.env.DB
        .prepare("SELECT score FROM articles WHERE slug = ?")
        .bind(slug)
        .first<{ score: number }>();
      return c.json({
        voted: false,
        score: row?.score ?? 0,
        user: { id: user.id, name: user.name, username: user.username },
      });
    }

    // First-time vote: lazily create the articles row if missing. Title
    // comes from KV metadata so the top-N panel doesn't need extra
    // lookups. We INSERT with score=1 and OR IGNORE on conflict; if the
    // row already existed, the subsequent UPDATE bumps its score.
    let title = slug;
    try {
      const stored = (await c.env.ARTICLES.get(slug, "json")) as
        | { title?: string }
        | null;
      if (stored?.title) title = stored.title;
    } catch {
      /* fallback to slug as title */
    }

    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT OR IGNORE INTO articles (slug, title, score, created_at)
           VALUES (?, ?, 0, ?)`
        )
        .bind(slug, title, now),
      c.env.DB
        .prepare(
          `INSERT INTO article_votes (user_id, slug, created_at)
           VALUES (?, ?, ?)`
        )
        .bind(user.id, slug, now),
      c.env.DB
        .prepare("UPDATE articles SET score = score + 1 WHERE slug = ?")
        .bind(slug),
    ]);

    const row = await c.env.DB
      .prepare("SELECT score FROM articles WHERE slug = ?")
      .bind(slug)
      .first<{ score: number }>();

    return c.json({
      voted: true,
      score: row?.score ?? 1,
      user: { id: user.id, name: user.name, username: user.username },
    });
  });

  return app;
}
