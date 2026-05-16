import { Hono } from "hono";
import { slugify, slugToTitle } from "./slug";
import { sanitizeHTML, extractSummary, extractTitle, looksLikeArticle, extractLinkHints } from "./sanitize";
import {
  streamGeneration,
  generateOnce,
  hallucinateSearchTitles,
  type GenerateOptions,
} from "./llm";
import { HOMEPAGE_ARTICLE } from "./seed";
import { createCommentsApp } from "./comments";
import { rateLimit, clientIp } from "./ratelimit";
import { isLikelyVpn } from "./vpn";
import { isPermanentlyBlockedSlug } from "./blocklist";
import { loadHints, saveHints } from "./hints";
import {
  countRecentBansByIp,
  enqueueArticleForModeration,
  isSlugBanned,
  isTitleModerationApproved,
  topicRejectedMessage,
  runSweep,
} from "./moderation";
import { createAdminApp } from "./admin";
import {
  requireHuman,
  challengeResponse,
  turnstileSiteKey,
  turnstileConfigured,
} from "./turnstile";

export interface Env {
  ARTICLES: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_MODERATION_MODEL?: string;
  MAX_ARTICLES_PER_DAY: string;
  GEN_PER_IP_PER_HOUR?: string;
  IDENT_PER_IP_PER_HOUR?: string;
  // IP-strike block: if an IP gets BAN_STRIKES_THRESHOLD articles banned
  // within BAN_STRIKES_WINDOW_HOURS hours, it's blocked from generating
  // until the oldest strike rolls out of the window.
  BAN_STRIKES_THRESHOLD?: string;
  BAN_STRIKES_WINDOW_HOURS?: string;
  // Per-IP rate limit for /api/search LLM-backed suggestions. Over the
  // limit, search still returns DB matches but skips the hallucination call.
  SEARCH_PER_IP_PER_HOUR?: string;
  // Single Durable Object tracking live readers per slug. See presence.ts.
  PRESENCE: DurableObjectNamespace;
  // Admin accounts live in D1 (`admins` table). No env-based password.
  //
  // Turnstile bot gating. Public site key + secret key from Cloudflare,
  // plus a 32-byte random HMAC secret for signing the trust cookie. All
  // three must be present for gating to be active; missing any of them
  // falls open (lets all requests through).
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_TRUST_SECRET?: string;
  TURNSTILE_TRUST_TTL_SEC?: string;
  TURNSTILE_RISKY_RATIO?: string;
}

interface StoredArticle {
  html: string;
  title: string;
  summary: string;
  generatedAt: number;
  sourceContext?: { fromSlug: string; fromTitle: string } | null;
}

const app = new Hono<{ Bindings: Env }>();

// Comments / users / votes (D1-backed). Mounted at root so route paths like
// `/api/comments/:slug` and `/api/me` are stable.
app.route("/", createCommentsApp());

// Admin panel API (basic-auth gated). Mounted at root so the routes inside
// keep their canonical /api/admin/* paths.
app.route("/", createAdminApp());

/* -------------------------------------------------------------------------- */
/*  Bot detection                                                              */
/*                                                                             */
/*  Crawlers love internal-link rabbit holes. Each Halupedia article has  */
/*  20–40 outbound links, so an unrestricted bot would explode our token bill. */
/*  Policy: cached articles are served to anyone (cheap KV read), but bots     */
/*  cannot trigger fresh generation. They get a 404 and move on.               */
/* -------------------------------------------------------------------------- */

const BOT_UA_RE =
  /bot|crawler|spider|crawling|slurp|bingpreview|gptbot|claudebot|claude-web|ccbot|perplexity|anthropic|openai|google-?(?:bot|other|extended)|amazonbot|applebot|duckduck|yandex|baidu|sogou|exabot|mj12|ahrefs|semrush|dotbot|petalbot|bytespider|facebookexternalhit|meta-externalagent|linkedinbot|twitterbot|discordbot|telegrambot|whatsapp|slackbot|skypeuripreview|embedly|preview|curl|wget|python-(?:requests|urllib|httpx)|aiohttp|node-fetch|axios|got|httpie|java-http|okhttp|libwww|scrapy|headlesschrome|puppeteer|playwright/i;

function isBot(ua: string | null | undefined): boolean {
  if (!ua) return true; // missing UA → treat as bot
  return BOT_UA_RE.test(ua);
}

/** robots.txt — allow everything; the worker enforces no-generate for bots. */
app.get("/robots.txt", (c) => {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Crawl-delay: 5",
    "",
  ].join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
});

/* -------------------------------------------------------------------------- */
/*  Reserved slugs                                                             */
/* -------------------------------------------------------------------------- */

// Reserved slugs are non-article paths the SPA owns. The worker refuses to
// generate them and the article handler short-circuits with 404 so accidental
// or malicious hits to /api/page/all-entries don't burn tokens or pollute KV.
const RESERVED_SLUGS = new Set(["all-entries", "search", "admin"]);

/* -------------------------------------------------------------------------- */
/*  GET /api/index  — paginated list of every cached article                  */
/* -------------------------------------------------------------------------- */

const TOTAL_KEY = "__total";

async function readTotal(env: Env): Promise<number | null> {
  const v = await env.ARTICLES.get(TOTAL_KEY);
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Walk every key once to seed __total. Cheap if we have <few thousand. */
async function backfillTotal(env: Env): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  for (let i = 0; i < 50; i++) {
    const page = await env.ARTICLES.list({ cursor, limit: 1000 });
    count += page.keys.filter((k) => !k.name.startsWith("__")).length;
    if (page.list_complete) {
      try { await env.ARTICLES.put(TOTAL_KEY, String(count)); } catch {}
      return count;
    }
    cursor = (page as any).cursor;
    if (!cursor) break;
  }
  return count;
}

async function filterModeratedIndexItems(
  db: D1Database,
  items: { slug: string; title: string; generatedAt: number | null }[]
): Promise<{ slug: string; title: string; generatedAt: number | null }[]> {
  if (items.length === 0) return items;

  const safeItems = items.filter((it) => !isPermanentlyBlockedSlug(it.slug));
  if (safeItems.length === 0) return [];

  const slugs = safeItems.map((it) => it.slug);
  const placeholders = slugs.map(() => "?").join(",");
  try {
    const { results } = await db
      .prepare(
        `SELECT slug FROM article_moderation
         WHERE status IN ('banned', 'pending', 'checking')
           AND slug IN (${placeholders})`
      )
      .bind(...slugs)
      .all<{ slug: string }>();
    if (!results || results.length === 0) return safeItems;
    const blocked = new Set(results.map((r) => r.slug));
    return safeItems.filter((it) => !blocked.has(it.slug));
  } catch (e) {
    console.error("index: moderation filter failed", e);
    throw e;
  }
}

app.get("/api/index", async (c) => {
  const cursorRaw = c.req.query("cursor");
  const cursor = cursorRaw && cursorRaw.length > 0 ? cursorRaw : undefined;
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || "100", 10) || 100, 1),
    200
  );

  const list = await c.env.ARTICLES.list<{
    title?: string;
    generatedAt?: number;
  }>({ cursor, limit });

  const items = list.keys
    .filter((k) => !k.name.startsWith("__")) // drop counters / rate-limit buckets
    .map((k) => ({
      slug: k.name,
      title: k.metadata?.title ?? slugToTitle(k.name),
      generatedAt: k.metadata?.generatedAt ?? null,
    }));
  let filteredItems = items;
  try {
    filteredItems = await filterModeratedIndexItems(c.env.DB, items);
  } catch {
    return c.json(
      {
        error: "index temporarily unavailable",
        items: [],
        cursor: list.list_complete ? null : ((list as any).cursor ?? null),
        complete: false,
        total: null,
      },
      503
    );
  }

  // Total is only computed on the first page request — subsequent paginated
  // calls don't need it, and it costs an extra KV read (or full sweep).
  let total: number | null = null;
  const forceRefresh = c.req.query("refresh") === "1";
  if (!cursor) {
    total = forceRefresh ? null : await readTotal(c.env);
    if (total === null) {
      // Counter missing or refresh requested. Backfill (full KV sweep).
      total = await backfillTotal(c.env);
    }
    // If this first page is the entire dataset, opportunistically reconcile.
    if (list.list_complete && total !== filteredItems.length) {
      total = filteredItems.length;
      try { await c.env.ARTICLES.put(TOTAL_KEY, String(total)); } catch {}
    }
  }

  return c.json({
    items: filteredItems,
    cursor: list.list_complete ? null : (list as any).cursor ?? null,
    complete: list.list_complete,
    total,
  });
});

/* -------------------------------------------------------------------------- */
/*  GET /api/search?q=…  — mixed search results                                */
/*                                                                             */
/*  Returns up to ~15 results for the user's query. Existing cached articles  */
/*  whose title or slug matches the query come first (marked exists=true);    */
/*  the rest are AI-hallucinated plausible titles that don't yet exist        */
/*  (exists=false), which trigger generation if clicked.                      */
/*                                                                             */
/*  Hallucinations are cached in KV by normalized query so a repeat search    */
/*  costs zero LLM tokens. DB matches are NOT cached — they're recomputed on  */
/*  every hit so newly-generated articles surface immediately.                */
/*                                                                             */
/*  Cached unwritten suggestions are re-checked against the live KV index on  */
/*  every read: if someone clicked through and generated one, it now appears  */
/*  in the "in the encyclopedia" section instead of "not yet written" — with  */
/*  the article's actual stored title (which can drift from what the LLM      */
/*  originally hallucinated, since slugify isn't bijective).                  */
/*                                                                             */
/*  The LLM call is rate-limited per IP. Cache hits don't count against the  */
/*  rate limit. Over the limit with no cache hit, we return DB matches only  */
/*  and set rate_limited=true so the frontend can explain.                    */
/* -------------------------------------------------------------------------- */

const SEARCH_TARGET_RESULTS = 15;
// Cached hallucinations live a week. The LLM is creative; refreshing more
// often costs tokens for no real benefit, and the per-read re-evaluation
// against current KV state already keeps "exists" flags accurate.
const SEARCH_CACHE_TTL_SEC = 60 * 60 * 24 * 7;

interface CachedHallucination {
  slug: string;
  title: string;
}

/** Normalize a query to a stable cache key: lowercased, whitespace collapsed,
 *  trimmed, capped. Two queries differing only in case or spacing share a
 *  cache entry. */
function normalizeSearchKey(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
}

app.get("/api/search", async (c) => {
  const qRaw = (c.req.query("q") ?? "").trim();
  if (!qRaw) {
    return c.json(
      { error: "missing query", query: "", results: [], rate_limited: false },
      400
    );
  }
  // Cap query length so a giant string doesn't get echoed back to the LLM.
  const q = qRaw.slice(0, 100);
  const cacheKey = `__search:${normalizeSearchKey(q)}`;

  // 1. Walk the KV namespace once (capped) to build the full title index.
  //    Both the substring-match step and the hallucination dedup step share
  //    this single pass — no extra KV reads per hallucinated title.
  const allKeys: { slug: string; title: string }[] = [];
  try {
    let cursor: string | undefined;
    // 10 pages × 1000 keys = 10k cap. Safely above our current ~5k corpus.
    for (let i = 0; i < 10; i++) {
      const page = await c.env.ARTICLES.list<{ title?: string; generatedAt?: number }>(
        { cursor, limit: 1000 }
      );
      for (const k of page.keys) {
        if (k.name.startsWith("__")) continue;
        const title =
          (k.metadata as any)?.title || slugToTitle(k.name);
        allKeys.push({ slug: k.name, title });
      }
      if (page.list_complete) break;
      cursor = (page as any).cursor;
      if (!cursor) break;
    }
  } catch (e) {
    console.error("search: KV walk failed", e);
  }

  const titleBySlug = new Map(allKeys.map((k) => [k.slug, k.title]));
  const ql = q.toLowerCase();

  const existing: { slug: string; title: string; exists: true }[] = allKeys
    .filter(
      (k) =>
        k.title.toLowerCase().includes(ql) ||
        k.slug.toLowerCase().includes(ql)
    )
    .slice(0, SEARCH_TARGET_RESULTS)
    .map((k) => ({ slug: k.slug, title: k.title, exists: true as const }));

  // 2. Cache lookup. If we have hallucinations cached for this query, serve
  //    them — re-evaluating each against the live KV index so any that have
  //    since been clicked-and-generated bubble up into the "exists" list
  //    with the article's real stored title.
  let cachedHalluc: CachedHallucination[] | null = null;
  try {
    cachedHalluc = await c.env.ARTICLES.get<CachedHallucination[]>(
      cacheKey,
      "json"
    );
  } catch {}

  const halluc: { slug: string; title: string; exists: false }[] = [];
  let cacheHit = false;
  let rateLimited = false;
  let retryAfter: number | null = null;
  // Set when the LLM call was skipped specifically because the visitor
  // looks risky and hasn't passed a Turnstile challenge. Surfaced in the
  // response so the SPA can render an inline "verify to unlock AI
  // suggestions" affordance without bothering the user during typing.
  let needsChallenge = false;
  const usedSlugs = new Set(existing.map((e) => e.slug));

  if (cachedHalluc && Array.isArray(cachedHalluc) && cachedHalluc.length > 0) {
    cacheHit = true;
    for (const ch of cachedHalluc) {
      if (!ch?.slug || !ch?.title) continue;
      if (usedSlugs.has(ch.slug)) continue;
      if (titleBySlug.has(ch.slug)) {
        // Was unwritten when cached; now exists. Promote it (with real title).
        if (existing.length < SEARCH_TARGET_RESULTS) {
          existing.push({
            slug: ch.slug,
            title: titleBySlug.get(ch.slug)!,
            exists: true,
          });
          usedSlugs.add(ch.slug);
        }
        continue;
      }
      // Still unwritten. Drop if banned.
      try {
        if (await isSlugBanned(c.env.DB, ch.slug)) continue;
      } catch {}
      if (halluc.length + existing.length < SEARCH_TARGET_RESULTS) {
        halluc.push({ slug: ch.slug, title: ch.title, exists: false });
        usedSlugs.add(ch.slug);
      }
    }
  }

  // 3. Cache miss → maybe call the LLM. Rate-limit ONLY at this point so
  //    cache hits are free. If we're capped, we silently fall through and
  //    surface only the DB matches with rate_limited=true.
  const remaining = SEARCH_TARGET_RESULTS - existing.length - halluc.length;
  if (!cacheHit && remaining > 0 && c.env.OPENROUTER_API_KEY) {
    // VPN / datacenter traffic doesn't get to spend tokens on hallucinated
    // suggestions; surface DB-only results with the rate-limit banner.
    if (isLikelyVpn(c)) {
      rateLimited = true;
      retryAfter = null;
    } else {
    const ip = clientIp(c);
    const perHour = parseInt(c.env.SEARCH_PER_IP_PER_HOUR || "15", 10);
    // Turnstile gate. Search runs on every keystroke (debounced) so we
    // never 428 here — instead, treat a needed challenge the same way we
    // treat a rate-limit cap: skip the LLM call, return DB-only results,
    // and surface `needs_challenge:true` so the SPA can offer to verify.
    const human = await requireHuman(c, {
      action: "search",
      rateLimitBucket: "search",
      rateLimitPerHour: perHour,
      checkStrikes: true,
    });
    if (!human.pass) {
      rateLimited = true;
      retryAfter = null;
      needsChallenge = true;
    } else {
    const rl = await rateLimit({
      kv: c.env.ARTICLES,
      bucket: "search",
      ip,
      limit: perHour,
      windowSec: 3600,
    });
    if (!rl.ok) {
      rateLimited = true;
      retryAfter = rl.retryAfter;
    } else {
      // Ask for a few extras so post-filter (existing/banned/empty) still
      // leaves us with enough.
      const titles = await hallucinateSearchTitles(
        c.env.OPENROUTER_API_KEY,
        c.env.OPENROUTER_MODERATION_MODEL ||
          c.env.OPENROUTER_MODEL ||
          "google/gemini-2.5-flash-lite",
        q,
        Math.min(remaining + 5, 20)
      );

      const toCache: CachedHallucination[] = [];
      for (const t of titles) {
        const slug = slugify(t);
        if (!slug) continue;
        if (RESERVED_SLUGS.has(slug)) continue;
        if (isPermanentlyBlockedSlug(slug)) continue;
        // Cache the slug regardless of whether it currently exists or is
        // banned — the per-read re-evaluation handles those branches. But
        // skip duplicates within the LLM's own response.
        if (toCache.some((x) => x.slug === slug)) continue;
        toCache.push({ slug, title: t });

        // Build the served response now.
        if (usedSlugs.has(slug)) continue;
        if (titleBySlug.has(slug)) continue; // already covered by `existing`
        try {
          if (await isSlugBanned(c.env.DB, slug)) continue;
        } catch {}
        if (halluc.length < remaining) {
          halluc.push({ slug, title: t, exists: false });
          usedSlugs.add(slug);
        }
      }

      // Persist whatever the LLM gave us (slug+title pairs), even items we
      // didn't show this round. They might surface on a later request as the
      // corpus grows or filtering changes. Skip caching empty results so a
      // transient LLM failure doesn't poison the cache.
      if (toCache.length > 0) {
        try {
          await c.env.ARTICLES.put(cacheKey, JSON.stringify(toCache), {
            expirationTtl: SEARCH_CACHE_TTL_SEC,
          });
        } catch (e) {
          console.error("search: cache write failed", e);
        }
      }
    }
    }
    }
  }

  return c.json({
    query: q,
    results: [...existing, ...halluc],
    existing_count: existing.length,
    hallucinated_count: halluc.length,
    rate_limited: rateLimited,
    retry_after: retryAfter,
    cached: cacheHit,
    needs_challenge: needsChallenge,
    site_key: needsChallenge ? turnstileSiteKey(c.env) : undefined,
  });
});

/* -------------------------------------------------------------------------- */
/*  GET /api/page/:slug  — streaming article endpoint                          */
/* -------------------------------------------------------------------------- */

app.get("/api/page/:slug", async (c) => {
  const rawSlug = c.req.param("slug");
  const slug = slugify(rawSlug);

  if (!slug) {
    return c.json({ error: "invalid slug" }, 400);
  }

  if (RESERVED_SLUGS.has(slug)) {
    return c.json(
      { error: "reserved path", reserved: true },
      404,
      { "x-robots-tag": "noindex" }
    );
  }

  // Permanent pattern block. Skips cache, never enqueues moderation, just
  // returns the same shape as a moderation-banned slug so the SPA renders
  // the redacted-entry notice.
  if (isPermanentlyBlockedSlug(slug)) {
    return c.json(
      { error: "this entry has been removed by moderation", banned: true },
      404,
      { "x-robots-tag": "noindex" }
    );
  }

  // Canonicalize: if the client hit a non-canonical form, tell them.
  if (slug !== rawSlug) {
    return c.json({ redirect: `/${slug}` }, 200);
  }

  // Homepage seed is authoritative: serve the curated landing page for both
  // the new root slug and the legacy slug, BEFORE the cache lookup. This
  // overrides any stale KV entry written by a bot or earlier deploy and
  // guarantees the landing page is always the deadpan, hand-written one.
  if (slug === "halupedia" || slug === "hallucinopedia") {
    return streamString(HOMEPAGE_ARTICLE, true);
  }

  const fromSlugRaw = c.req.query("from");
  const fromSlug = fromSlugRaw ? slugify(fromSlugRaw) : null;

  // 1. Cache lookup.
  const cached = await c.env.ARTICLES.get(slug, "json") as StoredArticle | null;
  if (cached) {
    return streamString(cached.html, /* cached */ true);
  }

  // 1b. Banned-slug guard. If a previous moderation sweep killed this title,
  //     refuse to regenerate it — otherwise the same spam slug returns the
  //     instant the bot retries.
  if (await isSlugBanned(c.env.DB, slug)) {
    return c.json(
      { error: "this entry has been removed by moderation", banned: true },
      404,
      { "x-robots-tag": "noindex" }
    );
  }

  // 2. Bot guard. Crawlers can read what's already in cache (handled above)
  //    but must not be allowed to spawn fresh generations.
  const ua = c.req.header("user-agent");
  if (isBot(ua)) {
    return c.json(
      { error: "entry has not yet been written" },
      404,
      { "x-robots-tag": "noindex" }
    );
  }

  // 2b. VPN / datacenter denylist. Almost all spam comes from commercial
  //     hosting / VPN backbone ASNs. Cache reads above still serve, so
  //     legitimate users on a VPN can browse — only the LLM-spending path
  //     is refused.
  if (isLikelyVpn(c)) {
    return c.json(
      { error: "new entries cannot be generated from VPN or datacenter networks" },
      403,
      { "x-robots-tag": "noindex" }
    );
  }

  // 2c. Turnstile bot gate. Sits BEFORE the rate-limit increment so a
  //     would-be visitor who gets challenged doesn't have their hourly
  //     budget burned by the rejected attempt. Falls open if Turnstile
  //     isn't configured.
  const perHour = parseInt(c.env.GEN_PER_IP_PER_HOUR || "30", 10);
  const human = await requireHuman(c, {
    action: "generate",
    rateLimitBucket: "gen",
    rateLimitPerHour: perHour,
    // generate already does its own strike check at step 3b below.
    checkStrikes: false,
  });
  if (!human.pass) {
    return challengeResponse(c, "generate");
  }

  // 3. Per-IP rate limit on generation (defense against UA-spoofing scrapers).
  const ip = clientIp(c);
  const rl = await rateLimit({
    kv: c.env.ARTICLES,
    bucket: "gen",
    ip,
    limit: perHour,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return c.json(
      { error: `slow down — at most ${rl.limit} new entries per hour from one address` },
      429,
      { "retry-after": String(rl.retryAfter), "x-robots-tag": "noindex" }
    );
  }

  // 3b. IP-strike block. If this IP has had too many articles banned
  //     recently, refuse before any LLM call. This is what stops a botnet
  //     from grinding tokens forever — after the first few spam slugs get
  //     auto-moderated, every subsequent submission from that IP is free.
  const strikeThreshold = parseInt(c.env.BAN_STRIKES_THRESHOLD || "3", 10);
  const strikeWindowHours = parseInt(
    c.env.BAN_STRIKES_WINDOW_HOURS || "24",
    10
  );
  const strikeWindowMs = strikeWindowHours * 3600 * 1000;
  const recentBans = await countRecentBansByIp(c.env.DB, ip, strikeWindowMs);
  if (recentBans >= strikeThreshold) {
    return c.json(
      {
        error: `too many of your recent submissions were removed by moderation; new entries from this address are paused for ${strikeWindowHours}h`,
      },
      429,
      {
        "retry-after": String(strikeWindowHours * 3600),
        "x-robots-tag": "noindex",
      }
    );
  }

  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({ error: "OPENROUTER_API_KEY is not configured" }, 500);
  }

  const title = slugToTitle(slug);

  // 6. Pre-generation content policy check via moderation model.
  const approvedByPolicy = await isTitleModerationApproved(title, c.env);
  if (!approvedByPolicy) {
    return c.json(
      { error: topicRejectedMessage(), banned: true },
      403,
      { "x-robots-tag": "noindex" }
    );
  }

  // 7. Daily soft cap (per-namespace counter).
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `__counter:${today}`;
  const countStr = await c.env.ARTICLES.get(counterKey);
  const count = countStr ? parseInt(countStr, 10) : 0;
  const cap = parseInt(c.env.MAX_ARTICLES_PER_DAY || "5000", 10);
  if (count >= cap) {
    return c.json({ error: "daily generation cap reached; try again tomorrow" }, 503);
  }

  // 3. Fetch source context if `from` is present.
  let sourceContext: GenerateOptions["sourceContext"] = null;
  if (fromSlug) {
    const fromArticle = await c.env.ARTICLES.get(fromSlug, "json") as StoredArticle | null;
    if (fromArticle) {
      sourceContext = {
        fromTitle: fromArticle.title,
        fromSummary: fromArticle.summary,
      };
    }
  }

  // Pull every prior link-context blurb other articles have written about
  // this slug. These become CANON the LLM must respect.
  let priorHints: string[] = [];
  try {
    priorHints = await loadHints(c.env.DB, slug, 15);
  } catch (e) {
    console.error("loadHints failed", e);
  }

  const genOpts: GenerateOptions = {
    apiKey: c.env.OPENROUTER_API_KEY,
    model: c.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001",
    title,
    slug,
    sourceContext,
    priorHints,
  };

  // 4. Stream generation, tee one copy to client, collect the other for KV.
  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await streamGeneration(genOpts);
  } catch (err) {
    console.error("generation failed", err);
    return c.json({ error: "generation failed" }, 502);
  }

  const [toClient, toStore] = upstream.tee();

  // Increment counter optimistically (fire-and-forget).
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.ARTICLES.put(counterKey, String(count + 1), { expirationTtl: 60 * 60 * 48 });
      } catch {}
    })()
  );

  // Collect + persist after stream ends (waitUntil keeps worker alive).
  c.executionCtx.waitUntil(
    collectAndStore(toStore, slug, genOpts, fromSlug, ip, c.env).catch((e) =>
      console.error("collectAndStore error", e)
    )
  );

  return new Response(toClient, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-halupedia-cached": "false",
    },
  });
});

function streamString(text: string, cached: boolean): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-halupedia-cached": cached ? "true" : "false",
    },
  });
}

async function collectAndStore(
  stream: ReadableStream<Uint8Array>,
  slug: string,
  genOpts: GenerateOptions,
  fromSlug: string | null,
  createdIp: string,
  env: Env
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();

  let sanitized = sanitizeHTML(raw);
  let rawForHints = raw;
  if (!looksLikeArticle(sanitized)) {
    // Retry once, non-streaming.
    try {
      const retry = await generateOnce(genOpts);
      const retrySan = sanitizeHTML(retry);
      if (looksLikeArticle(retrySan)) {
        sanitized = retrySan;
        rawForHints = retry;
      } else {
        return; // give up; don't cache a broken article
      }
    } catch {
      return;
    }
  }

  const article: StoredArticle = {
    html: sanitized,
    title: extractTitle(sanitized, genOpts.title),
    summary: extractSummary(sanitized),
    generatedAt: Date.now(),
    sourceContext: fromSlug
      ? { fromSlug, fromTitle: genOpts.sourceContext?.fromTitle ?? fromSlug }
      : null,
  };

  // Detect whether this is a brand-new entry (vs. a regeneration) BEFORE we
  // overwrite, so the __total counter only ticks on first creation.
  const wasExisting = (await env.ARTICLES.get(slug)) !== null;

  await env.ARTICLES.put(slug, JSON.stringify(article), {
    metadata: { title: article.title, generatedAt: article.generatedAt },
  });

  if (!wasExisting) {
    // Only increment if the counter has already been seeded by /api/index's
    // backfill. If it's missing, leave it missing — the next index visit
    // will count everything (including this new entry) correctly.
    try {
      const curStr = await env.ARTICLES.get(TOTAL_KEY);
      if (curStr !== null) {
        const cur = parseInt(curStr, 10);
        await env.ARTICLES.put(
          TOTAL_KEY,
          String((Number.isFinite(cur) ? cur : 0) + 1)
        );
      }
    } catch {}
  }

  // Harvest the LLM's `context="…"` attributes from the RAW (pre-sanitize) HTML
  // and persist them as hints for the targets this article links to. The
  // sanitized HTML served to the client no longer carries them.
  try {
    const hints = extractLinkHints(rawForHints);
    if (hints.length > 0) {
      await saveHints(env.DB, slug, hints);
    }
  } catch (e) {
    console.error("saveHints failed", e);
  }

  // Enqueue this slug for moderation and stop. The actual LLM judgment is
  // deferred to the next /api/moderate sweep, which batches 30 titles into
  // a single LLM call — amortizing the ~990-token system prompt across the
  // batch instead of paying it once per article.
  try {
    await enqueueArticleForModeration(env.DB, slug, createdIp);
  } catch (e) {
    console.error("enqueue moderation failed", e);
  }
}

/* -------------------------------------------------------------------------- */
/*  GET /api/random  — pick a random cached slug                               */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  GET /api/config  — public runtime config for the SPA                       */
/*                                                                             */
/*  Today this only carries the Turnstile site key (so the SPA can mount the  */
/*  widget without a separate round trip every time it's needed). The site    */
/*  key is public by design — it appears in the page source anyway once the  */
/*  widget renders.                                                            */
/* -------------------------------------------------------------------------- */

app.get("/api/config", (c) => {
  return c.json({
    turnstile: {
      site_key: turnstileSiteKey(c.env),
      enabled: turnstileConfigured(c.env),
    },
  });
});

/* -------------------------------------------------------------------------- */
/*  POST /api/turnstile/verify  — explicit cookie-minting endpoint             */
/*                                                                             */
/*  Used by the search page (and any other surface) that wants to verify a    */
/*  Turnstile token WITHOUT performing a real protected action. The handler   */
/*  body is empty; all the work happens inside requireHuman, which verifies   */
/*  the X-Turnstile-Token header against Cloudflare's siteverify and (on     */
/*  success) writes the 30-minute trust cookie via Set-Cookie. Subsequent    */
/*  gated calls on this origin then bypass the challenge for the cookie's    */
/*  lifetime.                                                                 */
/* -------------------------------------------------------------------------- */

app.post("/api/turnstile/verify", async (c) => {
  // Use the same risk-weighting as the comment surface so a token earned
  // here is "strong enough" to satisfy any gated endpoint afterwards.
  const human = await requireHuman(c, {
    action: "comment",
    rateLimitBucket: "ident",
    rateLimitPerHour: parseInt(c.env.IDENT_PER_IP_PER_HOUR || "10", 10),
    checkStrikes: true,
  });
  if (!human.pass) {
    return challengeResponse(c, "comment");
  }
  return c.json({ ok: true });
});

app.get("/api/random", async (c) => {
  const list = await c.env.ARTICLES.list({ limit: 1000 });
  const slugs = list.keys
    .map((k) => k.name)
    .filter((n) => !n.startsWith("__"));
  if (slugs.length === 0) {
    return c.json({ slug: "halupedia" });
  }
  const slug = slugs[Math.floor(Math.random() * slugs.length)];
  return c.json({ slug });
});

/* -------------------------------------------------------------------------- */
/*  GET /api/meta/:slug  — lightweight title/summary probe (unused v1)         */
/* -------------------------------------------------------------------------- */

app.get("/api/meta/:slug", async (c) => {
  const slug = slugify(c.req.param("slug"));
  const a = await c.env.ARTICLES.get(slug, "json") as StoredArticle | null;
  if (!a) return c.json({ exists: false });
  return c.json({
    exists: true,
    title: a.title,
    summary: a.summary,
    generatedAt: a.generatedAt,
  });
});

/* -------------------------------------------------------------------------- */
/*  GET /api/moderate  — drain pending moderation queue                        */
/*                                                                             */
/*  Public + idempotent. Each hit processes a bounded batch (so it can't run   */
/*  past Workers' CPU limit); already-judged items are skipped. Hammer it      */
/*  from cron / a watchdog / a browser tab — whatever. If nothing's pending    */
/*  it just returns zeros.                                                     */
/* -------------------------------------------------------------------------- */

app.get("/api/moderate", async (c) => {
  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({ error: "OPENROUTER_API_KEY is not configured" }, 500);
  }
  const parallel = parseInt(c.req.query("parallel") || "1", 10) || 1;
  try {
    const result = await runSweep(c.env, parallel);
    return c.json(result);
  } catch (e: any) {
    console.error("moderation sweep failed", e);
    return c.json({ error: "sweep failed", detail: String(e?.message ?? e) }, 500);
  }
});

/* -------------------------------------------------------------------------- */
/*  GET /api/presence  — single global Durable Object, WS-only                  */
/*                                                                              */
/*  Clients open exactly one WebSocket for the lifetime of the SPA and send     */
/*  a `{t:"r", s, ti}` message whenever they navigate to a new slug. The DO     */
/*  fans back two stream types: a global top-N broadcast and a per-client       */
/*  count for the slug they're on. Closing the WS removes them from counts.    */
/* -------------------------------------------------------------------------- */

app.get("/api/presence", (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected websocket upgrade" }, 426);
  }
  // Single global DO. Sharding (if ever needed) would key idFromName by a
  // client-hash; for now everyone lands on "global".
  const id = c.env.PRESENCE.idFromName("global");
  const stub = c.env.PRESENCE.get(id);
  return stub.fetch(c.req.raw);
});

/* -------------------------------------------------------------------------- */
/*  Brand-rename redirect: old root slug → new root slug.                      */
/* -------------------------------------------------------------------------- */

app.get("/halupedia", (c) => c.redirect("/", 301));
app.get("/hallucinopedia", (c) => c.redirect("/", 301));

/* -------------------------------------------------------------------------- */
/*  Catch-all: serve SPA assets                                                */
/* -------------------------------------------------------------------------- */

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export { PresenceDO } from "./presence";
export default app;
