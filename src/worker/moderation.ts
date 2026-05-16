/**
 * Content moderation. Two trigger paths:
 *
 *   1. /api/moderate sweep — drains every pending article + comment in
 *      batches until the per-invocation budget is spent. Idempotent (already
 *      checked items are skipped), so re-hitting the URL is safe.
 *   2. waitUntil hook on every fresh write — accepts the user's submission
 *      immediately and judges it asynchronously, deleting it if banned.
 *
 * Articles are judged by their TITLE only (per product decision: titles are
 * what the spam botnet weaponizes). Comments are judged by full body.
 *
 * Policy is intentionally permissive: only Nazi/fascist promotion, slurs
 * targeting protected groups, incitement to violence, and obvious keyword-
 * mashing spam get removed. Absurdity, vulgarity, mockery — all kept.
 */

export interface ModerationEnv {
  DB: D1Database;
  ARTICLES: KVNamespace;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_MODERATION_MODEL?: string;
}

const BATCH_SIZE = 30;
// Safety budget per /api/moderate invocation — workers have CPU/time limits
// and a single hammer-the-API endpoint shouldn't stall forever. Re-hits drain
// the rest, so this is just a per-call cap.
const MAX_BATCHES_PER_SWEEP = 10;
// Hard ceiling on the ?parallel= query param. OpenRouter will rate-limit if
// we go too wide; 100 fan-out × 30 items = 3,000 in flight is the practical cap.
const MAX_PARALLEL = 100;
const MODERATION_SYSTEM_PROMPT = `You are a content moderator for Halupedia, a satirical AI-generated encyclopedia of fictional, absurd entries with a public comments section. Your job is to remove griefing, hate, and spam — NOT to police taste.

ALLOW (these are the *point* of the site, do not remove):
- Absurd, silly, fictional, surreal subjects (the whole encyclopedia is fake)
- Vulgarity, profanity, dark humor, mockery of fictional characters / institutions
- Criticism of governments, religions, ideologies, corporations, public figures
- Edgy, offensive, in-poor-taste jokes that target ideas, not people
- Real-sounding nonsense like "1816 Chicken President Debacle", "1754 French Moon Landings", "17th of Floridor", "Decree of Bedding the Neighbour's Wife"

REMOVE if ANY of the following clearly applies:

(A) HATE / DEHUMANIZATION targeting a protected group — race, ethnicity, religion, nationality (incl. Jews, Muslims, Christians, etc.), sexuality, gender identity, disability. The TARGET matters: mocking "Islam" or "the Catholic Church" as institutions is fine; "Fuck Jews", "Islamists rape children", "Niggers", "Faggots", any title that asserts a slur or sexual/violent claim *about a group of people* is NOT fine. Err toward removing when the title names a protected group + a slur, sexual act, or crime.

(B) NAZI / FASCIST / GENOCIDAL promotion (not mockery — actual glorification, calls for ethnic cleansing, holocaust denial as endorsement).

(C) INCITEMENT to real-world violence against identifiable real people.

(D) SEXUAL CONTENT INVOLVING MINORS — any. Zero tolerance.

(E) SPAM / GRIEFING. Be strict here. The site is being attacked by trolls submitting numeric-prefix copypasta. Remove:
   - Pure digit strings or near-pure digit strings: "00000000000000000", "1238283882123", "1111111 Pornhub Dot Com", "0000067 Fuck This Ai Slop"
   - Titles that look like a botnet enumerating: "0 Fuck This Ai Slop", "00 Fuck This Ai Slop", "000 Fuck This Ai Slop", "0000 Fuck This Ai Slop" — the leading-digit + same-phrase pattern is a giveaway
   - Repetitive concatenation: "islamistsrapechildrenislamistsrapechildrenislamistsrapechildren..."
   - "Strama to Cwel" / "Strama jest Cwel" or any phrase clearly used as a personal-target slur or grief copypasta — these target a real person ("Strama") and are not fictional
   - Single-word vulgarities prefixed with digits: "0 Cum Penis", "01 Hentai Gooners"
   - Direct anti-AI griefing: "Fuck This Ai Slop", "Fuck Ai" (these are not encyclopedia entries, they're protest spam)

POSITIVE EXAMPLES — these are fine, do NOT remove:
- "1480s", "1816 Chicken President Debacle", "17th Century Scholasticism", "1754 Lunar Landings", "1932 London Megaflan Incident", "Marquis De Chinchilla", "Pellbrick", "Vellum School of Footnote Drift"

NEGATIVE EXAMPLES — definitely remove:
- "Fuck Niggers", "0 Islamists Suck Big Black Cocks", "014 Fuck Jews and Islamists Scale", "1111111 Pornhub Dot Com", "00000000000000000", "0 Fuck This Ai Slop", "Strama to Cwel 672253", "0 Cum Penis"

When the title is a plausible-sounding fake-history entry, ALLOW. When the title is a slur-against-a-group, a personal attack, a numeric-prefix copypasta, or pure digit gibberish, REMOVE.

Respond with ONLY a JSON array of the 1-based indices to remove, like [1,4,7] or [] if nothing should be removed. No prose, no explanation, no code fences. Just the JSON array.`;

interface JudgeItem {
  index: number; // 1-based
  text: string;
}

export function topicRejectedMessage(): string {
  return "this topic was rejected by moderation";
}

/**
 * Synchronous pre-generation title check used by `/api/page/:slug`.
 *
 * The broader moderation pipeline is async and fail-open, but this gate is
 * intentionally in the hot path for fresh article generation so obvious abuse
 * does not spend article-generation tokens or enter KV. If the moderation
 * model itself fails, we still fail open and let the existing sweep catch
 * anything borderline later.
 */
export async function isTitleModerationApproved(
  title: string,
  env: ModerationEnv
): Promise<boolean> {
  const rejected = await judgeBatch(
    [{ index: 1, text: title }],
    "article title",
    env
  );
  return !rejected.has(1);
}

/* -------------------------------------------------------------------------- */
/*  Deterministic comment-spam detector                                        */
/* -------------------------------------------------------------------------- */

/**
 * Returns true if a comment body is obvious link-farm / engagement-bait spam.
 *
 * Bots are posting templated "nice article 🙂" comments with a trailing
 * `[<10-hex>-<digits>]` tracking fingerprint, which is the operator's beacon
 * to confirm placement and attribute campaigns. Format examples observed in
 * the wild:
 *     "this helped me understand it better 👌 [f292d40e12-4]"
 *     "solid post 🚀 [47b99754ba-4]"
 *     "well written article 🙂 [2d07833ce1-6]"
 *
 * Strategy:
 *   1. Trailing `[hex-digit]` fingerprint  -> instant ban (exclusively a bot
 *      signature; no real user types this).
 *   2. Empty/short body that's just a templated engagement-bait phrase ->
 *      ban (covers the same operator running silent variants without the
 *      fingerprint).
 *
 * Cheaper, faster, and more reliable than asking the LLM. Also saves tokens.
 */
const SPAM_FINGERPRINT = /\[[0-9a-f]{6,16}-\d{1,4}\]\s*$/i;
const ENGAGEMENT_BAIT_PHRASES = [
  "nice article",
  "solid post",
  "great explanation",
  "well written article",
  "thanks for writing this",
  "this helped me understand",
  "interesting point of view",
  "i enjoyed reading this",
  "very useful",
  "helpful post",
  "good read",
  "informative article",
];
export function isObviousCommentSpam(body: string): boolean {
  const trimmed = body.trim();
  if (SPAM_FINGERPRINT.test(trimmed)) return true;
  // Strip emojis/punctuation and check if what remains is ONLY a bait phrase.
  const stripped = trimmed
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Only flag if the whole comment is short AND consists of one bait phrase.
  // Real users may casually say "nice article" inside a longer comment.
  if (stripped.length > 0 && stripped.length <= 60) {
    for (const phrase of ENGAGEMENT_BAIT_PHRASES) {
      if (stripped === phrase || stripped.startsWith(phrase + " ")) return true;
      if (stripped.endsWith(" " + phrase)) return true;
    }
  }
  return false;
}

/**
 * Send a batch of items to the moderator LLM. Returns the set of 1-based
 * indices the model wants removed. On any error we fail OPEN (return empty
 * set) — better to leave borderline content up than to mass-delete because
 * of a transient API hiccup.
 */
async function judgeBatch(
  items: JudgeItem[],
  kind: "article title" | "comment",
  env: ModerationEnv
): Promise<Set<number>> {
  if (items.length === 0) return new Set();

  const numbered = items
    .map((it) => `${it.index}. ${it.text.replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n");

  const userMsg = `Review the following ${items.length} ${kind}${items.length === 1 ? "" : "s"} and return the JSON array of 1-based indices to remove (or [] if all are acceptable):\n\n${numbered}`;

  const model =
    env.OPENROUTER_MODERATION_MODEL ||
    env.OPENROUTER_MODEL ||
    "google/gemini-2.5-flash-lite";

  let raw = "";
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://hallupedia.com",
        "X-Title": "Halupedia Moderation",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: MODERATION_SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
      }),
    });
    if (!res.ok) {
      console.error("moderation: openrouter error", res.status);
      return new Set();
    }
    const json: any = await res.json();
    raw = json?.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    console.error("moderation: fetch failed", e);
    return new Set();
  }

  // Robust parse: find first [...] in the response.
  const m = raw.match(/\[[^\]]*\]/);
  if (!m) return new Set();
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return new Set();
  }
  if (!Array.isArray(arr)) return new Set();

  const valid = new Set(items.map((it) => it.index));
  const out = new Set<number>();
  for (const v of arr) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && valid.has(n)) out.add(n);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Per-write enqueue helpers                                                  */
/* -------------------------------------------------------------------------- */

/** Insert (or upsert to pending) a moderation row for a freshly-stored slug.
 *
 *  The originating IP is stored so a later sweep ban contributes a "strike"
 *  attributable to that IP — see {@link countRecentBansByIp}. On conflict we
 *  only refresh status/timestamps; the original `created_ip` is preserved so
 *  re-generations don't reset attribution. */
export async function enqueueArticleForModeration(
  db: D1Database,
  slug: string,
  ip: string | null
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO article_moderation (slug, status, enqueued_at, created_ip)
         VALUES (?, 'pending', ?, ?)
         ON CONFLICT(slug) DO UPDATE SET status='pending', enqueued_at=excluded.enqueued_at, checked_at=NULL, reason=NULL`
      )
      .bind(slug, Date.now(), ip && ip !== "unknown" ? ip : null)
      .run();
  } catch (e) {
    console.error("enqueueArticleForModeration failed", e);
  }
}

/** Count how many articles created by this IP have been banned within the
 *  last `windowMs` milliseconds. Used to short-circuit generation for IPs
 *  that have already shown a pattern. */
export async function countRecentBansByIp(
  db: D1Database,
  ip: string,
  windowMs: number
): Promise<number> {
  if (!ip || ip === "unknown") return 0;
  try {
    const since = Date.now() - windowMs;
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM article_moderation
          WHERE created_ip = ? AND status = 'banned' AND checked_at > ?`
      )
      .bind(ip, since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch (e) {
    console.error("countRecentBansByIp failed", e);
    return 0;
  }
}

/** Comments default to status='pending' via the column default; this is a no-op stub kept for symmetry / future hooks. */
export function enqueueCommentForModeration(): void {
  /* column default handles it */
}

/** True if the slug has been moderated and banned. */
export async function isSlugBanned(
  db: D1Database,
  slug: string
): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT 1 AS x FROM article_moderation WHERE slug = ? AND status = 'banned'")
      .bind(slug)
      .first<{ x: number }>();
    return !!row;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Single-item background check (waitUntil after a write)                     */
/* -------------------------------------------------------------------------- */

/** Cheap synchronous spam-fingerprint check on a freshly-posted comment.
 *  Deletes the comment outright if it matches the engagement-bait botnet
 *  pattern. Anything that passes this check stays 'pending' (column default)
 *  for the next sweep to judge in a 30-item batch — that amortizes the
 *  ~990-token moderation system prompt across the whole batch instead of
 *  paying it once per comment. */
export async function moderateCommentNow(
  commentId: string,
  body: string,
  env: ModerationEnv
): Promise<void> {
  if (isObviousCommentSpam(body)) {
    await deleteComment(commentId, env.DB, "spam-fingerprint on creation");
  }
  // Otherwise: nothing. The row is already 'pending'; the sweep handles it.
}

/* -------------------------------------------------------------------------- */
/*  Sweep (drains pending in batches)                                          */
/* -------------------------------------------------------------------------- */

interface SweepResult {
  articles: { checked: number; banned: number; remaining: number };
  comments: { checked: number; banned: number; remaining: number };
  backfilled: number;
  parallel: number;
  rounds: number;
}

export async function runSweep(
  env: ModerationEnv,
  parallel: number = 1
): Promise<SweepResult> {
  const fanout = Math.max(1, Math.min(MAX_PARALLEL, Math.floor(parallel) || 1));

  const backfilled = await backfillArticleModerationRows(env);

  // Recovery: any rows stuck in 'checking' from a crashed previous sweep
  // (worker timeout, exception, etc.) older than 5 minutes get reset to
  // 'pending' so they're picked up again. Fresh claims (this sweep) are safe
  // because we run synchronously and can't be older than 'now'.
  const staleCutoff = Date.now() - 5 * 60 * 1000;
  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE article_moderation SET status='pending'
            WHERE status='checking' AND (checked_at IS NULL OR checked_at < ?)`
        )
        .bind(staleCutoff),
      env.DB
        .prepare(
          `UPDATE comments SET moderation_status='pending'
            WHERE moderation_status='checking'
              AND created_at < ?`
        )
        .bind(staleCutoff),
    ]);
  } catch (e) {
    console.error("stale recovery failed", e);
  }

  // Each round fires `fanout` article batches + `fanout` comment batches
  // concurrently. Items are atomically claimed (status='checking') before
  // dispatch so parallel batches don't fight over the same rows.
  let articlesChecked = 0;
  let articlesBanned = 0;
  let commentsChecked = 0;
  let commentsBanned = 0;
  let rounds = 0;

  for (let i = 0; i < MAX_BATCHES_PER_SWEEP; i++) {
    rounds++;
    const tasks: Promise<BatchOutcome>[] = [];
    for (let p = 0; p < fanout; p++) tasks.push(sweepOneArticleBatch(env));
    for (let p = 0; p < fanout; p++) tasks.push(sweepOneCommentBatch(env));
    const results = await Promise.all(tasks);
    let roundChecked = 0;
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      if (k < fanout) {
        articlesChecked += r.checked;
        articlesBanned += r.banned;
      } else {
        commentsChecked += r.checked;
        commentsBanned += r.banned;
      }
      roundChecked += r.checked;
    }
    if (roundChecked === 0) break;
  }

  const aRem = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM article_moderation WHERE status IN ('pending','checking')")
    .first<{ n: number }>();
  const cRem = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM comments WHERE moderation_status IN ('pending','checking')")
    .first<{ n: number }>();

  return {
    articles: {
      checked: articlesChecked,
      banned: articlesBanned,
      remaining: aRem?.n ?? 0,
    },
    comments: {
      checked: commentsChecked,
      banned: commentsBanned,
      remaining: cRem?.n ?? 0,
    },
    backfilled,
    parallel: fanout,
    rounds,
  };
}

/**
 * Find KV article slugs that have no row in article_moderation and seed them
 * as 'pending'. Walks the *entire* KV namespace each call (idempotent via
 * INSERT OR IGNORE) — listing 5k keys is roughly 25 list ops which is fast.
 * The previous bounded-by-scan-count version restarted from cursor=undefined
 * each call and got stuck re-walking the first 500 keys forever, so deeper
 * slugs were never queued.
 */
async function backfillArticleModerationRows(
  env: ModerationEnv
): Promise<number> {
  let cursor: string | undefined;
  let inserted = 0;
  // Hard ceiling so a runaway namespace can't stall the worker. 200 pages
  // × 1000 keys per page = up to 200,000 slugs scanned.
  const MAX_PAGES = 200;
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    const page = await env.ARTICLES.list({ cursor, limit: 1000 });
    const slugs = page.keys
      .map((k) => k.name)
      .filter((n) => !n.startsWith("__"));
    if (slugs.length > 0) {
      // D1 batch handles ~100 stmts comfortably; chunk to stay under that.
      const CHUNK = 100;
      for (let i = 0; i < slugs.length; i += CHUNK) {
        const chunk = slugs.slice(i, i + CHUNK);
        const stmts = chunk.map((s) =>
          env.DB
            .prepare(
              `INSERT OR IGNORE INTO article_moderation (slug, status, enqueued_at) VALUES (?, 'pending', ?)`
            )
            .bind(s, Date.now())
        );
        try {
          const results = await env.DB.batch(stmts);
          for (const r of results) {
            // D1 result has `meta.changes` (1 if inserted, 0 if ignored).
            inserted += (r as any)?.meta?.changes ?? 0;
          }
        } catch (e) {
          console.error("backfill batch failed", e);
        }
      }
    }
    if (page.list_complete) break;
    cursor = (page as any).cursor;
    if (!cursor) break;
  }
  return inserted;
}

interface BatchOutcome { checked: number; banned: number }

async function sweepOneArticleBatch(env: ModerationEnv): Promise<BatchOutcome> {
  // Atomically claim a batch by flipping status pending → checking and
  // returning the affected rows. UPDATE…RETURNING is one statement so
  // concurrent batches in the same sweep get disjoint sets.
  const { results } = await env.DB
    .prepare(
      `UPDATE article_moderation
          SET status='checking', checked_at=?
        WHERE slug IN (
          SELECT slug FROM article_moderation
           WHERE status='pending'
           LIMIT ?
        )
        RETURNING slug`
    )
    .bind(Date.now(), BATCH_SIZE)
    .all<{ slug: string }>();
  if (!results || results.length === 0) return { checked: 0, banned: 0 };

  // Resolve titles. Cheap path: KV metadata. Fallback: deslugify.
  const slugs: string[] = results.map((r) => r.slug);
  const titles = await Promise.all(slugs.map((s) => readTitle(env.ARTICLES, s)));
  const items: JudgeItem[] = titles.map((t, i) => ({ index: i + 1, text: t }));

  const banned = await judgeBatch(items, "article title", env);

  let bannedCount = 0;
  // Apply verdicts. Bans first (so a partial failure leaves marks consistent).
  for (let i = 0; i < slugs.length; i++) {
    const idx = i + 1;
    if (banned.has(idx)) {
      await banArticle(slugs[i], "auto-flagged in sweep", env);
      bannedCount++;
    } else {
      await markArticleOk(slugs[i], env.DB);
    }
  }
  return { checked: slugs.length, banned: bannedCount };
}

async function sweepOneCommentBatch(env: ModerationEnv): Promise<BatchOutcome> {
  const { results } = await env.DB
    .prepare(
      `UPDATE comments
          SET moderation_status='checking'
        WHERE id IN (
          SELECT id FROM comments
           WHERE moderation_status='pending'
           LIMIT ?
        )
        RETURNING id, body`
    )
    .bind(BATCH_SIZE)
    .all<{ id: string; body: string }>();
  if (!results || results.length === 0) return { checked: 0, banned: 0 };

  // Pre-filter with the deterministic spam detector. Anything matching is
  // banned without consulting the LLM — saves ~30 tokens × N items per batch
  // and is 100% reliable for the templated engagement-bait botnet.
  const remaining: { id: string; body: string }[] = [];
  let bannedCount = 0;
  for (const r of results) {
    if (isObviousCommentSpam(r.body)) {
      await deleteComment(r.id, env.DB, "spam-fingerprint in sweep");
      bannedCount++;
    } else {
      remaining.push(r);
    }
  }

  if (remaining.length === 0) {
    return { checked: results.length, banned: bannedCount };
  }

  const items: JudgeItem[] = remaining.map((r, i) => ({
    index: i + 1,
    text: r.body,
  }));

  const banned = await judgeBatch(items, "comment", env);

  for (let i = 0; i < remaining.length; i++) {
    const idx = i + 1;
    if (banned.has(idx)) {
      await deleteComment(remaining[i].id, env.DB, "auto-flagged in sweep");
      bannedCount++;
    } else {
      await markCommentOk(remaining[i].id, env.DB);
    }
  }
  return { checked: results.length, banned: bannedCount };
}

/* -------------------------------------------------------------------------- */
/*  Mutators                                                                   */
/* -------------------------------------------------------------------------- */

async function readTitle(kv: KVNamespace, slug: string): Promise<string> {
  // Metadata is the cheapest path; falls back to slug if missing.
  try {
    const list = await kv.list({ prefix: slug, limit: 1 });
    const k = list.keys.find((x) => x.name === slug);
    const t = (k?.metadata as any)?.title;
    if (typeof t === "string" && t.length > 0) return t;
  } catch {}
  // Fallback: read the JSON.
  try {
    const v = await kv.get(slug, "json") as { title?: string } | null;
    if (v?.title) return v.title;
  } catch {}
  return slug.replace(/-/g, " ");
}

async function banArticle(
  slug: string,
  reason: string,
  env: ModerationEnv
): Promise<void> {
  const now = Date.now();
  try {
    await env.ARTICLES.delete(slug);
  } catch (e) {
    console.error("ban: KV delete failed", slug, e);
  }
  try {
    await env.DB
      .prepare(
        `INSERT INTO article_moderation (slug, status, reason, enqueued_at, checked_at)
         VALUES (?, 'banned', ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET status='banned', reason=excluded.reason, checked_at=excluded.checked_at`
      )
      .bind(slug, reason, now, now)
      .run();
  } catch (e) {
    console.error("ban: DB write failed", slug, e);
  }
  // Also decrement the cached __total counter if present, so the index
  // doesn't lie about how many entries exist.
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

async function markArticleOk(slug: string, db: D1Database): Promise<void> {
  const now = Date.now();
  try {
    await db
      .prepare(
        `UPDATE article_moderation SET status='ok', checked_at=?, reason=NULL WHERE slug=?`
      )
      .bind(now, slug)
      .run();
  } catch (e) {
    console.error("markArticleOk failed", e);
  }
}

async function deleteComment(
  id: string,
  db: D1Database,
  _reason: string
): Promise<void> {
  try {
    // A comment with replies can't be deleted directly — the comments table
    // has FOREIGN KEY (parent_id) REFERENCES comments(id), so deleting the
    // parent before the children violates the constraint and the row stays
    // forever (the moderation queue then loops on it indefinitely). Walk the
    // descendant tree via a recursive CTE and nuke bottom-up.
    const { results } = await db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM comments WHERE id = ?
           UNION ALL
           SELECT c.id FROM comments c JOIN descendants d ON c.parent_id = d.id
         )
         SELECT id FROM descendants`
      )
      .bind(id)
      .all<{ id: string }>();
    const ids = (results ?? []).map((r) => r.id);
    if (ids.length === 0) return;

    // Build IN-clause statements. SQLite has a 999-param default limit; chunk
    // defensively (huge thread bombs are unlikely but cheap to guard).
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      await db.batch([
        db
          .prepare(`DELETE FROM votes WHERE comment_id IN (${placeholders})`)
          .bind(...slice),
        db
          .prepare(`DELETE FROM comments WHERE id IN (${placeholders})`)
          .bind(...slice),
      ]);
    }
  } catch (e) {
    console.error("deleteComment failed", id, e);
  }
}

async function markCommentOk(id: string, db: D1Database): Promise<void> {
  try {
    await db
      .prepare(`UPDATE comments SET moderation_status='ok' WHERE id=?`)
      .bind(id)
      .run();
  } catch (e) {
    console.error("markCommentOk failed", e);
  }
}
