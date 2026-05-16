/**
 * Cloudflare Turnstile — bot gating for the three LLM-spending surfaces
 * (generate, search-hallucinate, comment-post).
 *
 * Design goals (per operator):
 *   - Normal readers must never see a CAPTCHA.
 *   - Bots must be stopped from anything that costs tokens.
 *   - One pass = trusted for a while (no challenge per action).
 *
 * How it works
 * ------------
 * `requireHuman(c, opts)` is the gate every protected handler calls before
 * doing real work. It returns either `{pass:true}` (let the request through)
 * or `{pass:false, reason:'challenge'}` (caller should respond 428 +
 * `needs_challenge: true`, prompting the SPA to mount Turnstile and retry).
 *
 * The gate uses three layers, evaluated in order:
 *
 *   1. **Trust cookie** (`tt`). HMAC-signed, bound to the visitor's IP,
 *      30 min lifetime by default. If valid → pass. This is the "one
 *      challenge unlocks the rest of the session" mechanism.
 *
 *   2. **Token presented** (`X-Turnstile-Token` header). The SPA only
 *      attaches this when retrying after a 428. We verify it against
 *      Cloudflare's siteverify and on success mint the trust cookie.
 *
 *   3. **Risk evaluation.** Only reached when there's no cookie AND no
 *      token. We pass unless one of these signals is on:
 *        - `isLikelyVpn(c)` — VPN/datacenter ASN
 *        - cross-origin POST (Sec-Fetch-Site missing/non-same-*)
 *        - per-IP usage is ≥ TURNSTILE_RISKY_RATIO of the bucket's hourly
 *          limit (default 50%)
 *        - moderation strikes on this IP (when caller asks)
 *      Benign visitors never hit any of those, so they never see anything.
 *
 * Fall-open behavior
 * ------------------
 * If `TURNSTILE_SECRET_KEY` or `TURNSTILE_TRUST_SECRET` is unset, every
 * call returns `{pass:true}`. This keeps local dev working without
 * secrets and makes the feature strictly opt-in via env config.
 *
 * Per-request cost
 * ----------------
 *   - Benign visitor with no cookie: one KV peek (the rate-limit ratio).
 *     ~1 ms; no fetches, no LLM, no D1 unless `checkStrikes` is set.
 *   - Visitor with cookie: one HMAC verify. Sub-millisecond.
 *   - Challenged visitor on retry: one POST to challenges.cloudflare.com
 *     (~10 ms intra-CF), then one HMAC sign + cookie write.
 *   - Bot that ignores 428: 0 cost on subsequent requests too — they keep
 *     getting 428 with no LLM call ever reached.
 */

import { getCookie, setCookie } from "hono/cookie";
import { clientIp } from "./ratelimit";
import { isLikelyVpn } from "./vpn";
import { countRecentBansByIp } from "./moderation";

const TRUST_COOKIE = "tt";
const HEADER_TOKEN = "x-turnstile-token";
const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const DEFAULT_TRUST_TTL_SEC = 1800; // 30 minutes
const DEFAULT_RISKY_RATIO = 0.5; // challenge once IP burns 50% of its hourly cap

export type Action = "generate" | "search" | "comment";

export interface CheckOpts {
  action: Action;
  /** The existing per-IP rate-limit bucket name (e.g. "gen", "search"). We
   *  peek (without bumping) to gauge how much of their hourly budget the
   *  IP has spent — high ratio is a soft "they might be a bot" signal. */
  rateLimitBucket?: string;
  rateLimitPerHour?: number;
  /** Generate already does its own strike check upstream; comments/search
   *  ask us to do it here so a strike-bearing IP gets challenged even on
   *  surfaces that don't otherwise look at the ban history. */
  checkStrikes?: boolean;
}

export type CheckResult =
  | { pass: true }
  | { pass: false; reason: "challenge" };

function getConf(env: any) {
  // Note on the parse helpers: we cannot use the `parseX(...) || DEFAULT`
  // idiom because legitimate zero values (e.g. RISKY_RATIO="0" for "always
  // challenge during local testing") would be clobbered by the default.
  // Fall back ONLY when the parse produced NaN.
  const ttlRaw = parseInt(env.TURNSTILE_TRUST_TTL_SEC ?? "", 10);
  const ratioRaw = parseFloat(env.TURNSTILE_RISKY_RATIO ?? "");
  return {
    siteKey: env.TURNSTILE_SITE_KEY || "",
    secretKey: env.TURNSTILE_SECRET_KEY || "",
    trustSecret: env.TURNSTILE_TRUST_SECRET || "",
    trustTtlSec: Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_TRUST_TTL_SEC,
    riskyRatio: Number.isFinite(ratioRaw) ? ratioRaw : DEFAULT_RISKY_RATIO,
  };
}

/** Public site key (or empty string). Cheap accessor for the /api/config
 *  endpoint and for embedding in challenge-required JSON responses. */
export function turnstileSiteKey(env: any): string {
  return env.TURNSTILE_SITE_KEY || "";
}

/** Whether Turnstile is configured at all. Used by callers that want to
 *  short-circuit cleanly when the feature is off (e.g. don't include
 *  `needs_challenge: true` in a response when no site key exists). */
export function turnstileConfigured(env: any): boolean {
  const c = getConf(env);
  return !!(c.siteKey && c.secretKey && c.trustSecret);
}

/* -------------------------------------------------------------------------- */
/*  Trust cookie (HMAC-signed, IP-bound)                                       */
/* -------------------------------------------------------------------------- */

/** Cookie format: `base64url(payload).base64url(hmac)`, where payload is
 *  the ASCII string `ip|iat|exp`. We embed the IP so a stolen cookie
 *  can't be reused from a different network. */

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(std);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signTrust(
  secret: string,
  ip: string,
  ttlSec: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = `${ip}|${now}|${now + ttlSec}`;
  const payloadBytes = new TextEncoder().encode(payload);
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payloadBytes)
  );
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(sig)}`;
}

async function verifyTrust(
  secret: string,
  cookie: string,
  ip: string
): Promise<boolean> {
  const parts = cookie.split(".");
  if (parts.length !== 2) return false;
  const payloadBytes = b64urlDecode(parts[0]);
  const sigBytes = b64urlDecode(parts[1]);
  if (!payloadBytes || !sigBytes) return false;

  const key = await hmacKey(secret);
  // crypto.subtle.verify is constant-time vs the signature, which is what
  // matters for forgery resistance.
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes as BufferSource,
    payloadBytes as BufferSource
  );
  if (!ok) return false;

  const payload = new TextDecoder().decode(payloadBytes);
  const segs = payload.split("|");
  if (segs.length !== 3) return false;
  const cIp = segs[0];
  const exp = parseInt(segs[2], 10);
  if (!Number.isFinite(exp)) return false;
  if (Math.floor(Date.now() / 1000) >= exp) return false;
  // IP binding: a cookie minted from one address shouldn't grant access
  // from another. Empty/"unknown" issued IPs (degenerate dev case) only
  // match identical empty/"unknown" presenters.
  if (cIp !== ip) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Cloudflare siteverify                                                      */
/* -------------------------------------------------------------------------- */

interface SiteverifyResp {
  success: boolean;
  "error-codes"?: string[];
  hostname?: string;
}

async function verifyToken(
  secret: string,
  token: string,
  ip: string
): Promise<boolean> {
  try {
    const form = new FormData();
    form.set("secret", secret);
    form.set("response", token);
    if (ip && ip !== "unknown") form.set("remoteip", ip);
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) {
      console.error("turnstile siteverify HTTP", res.status);
      return false;
    }
    const j = (await res.json()) as SiteverifyResp;
    if (!j.success) {
      // Log error-codes for debugging; common ones include
      // "invalid-input-response" (token reused / expired) and
      // "timeout-or-duplicate" (network race).
      console.warn("turnstile siteverify rejected", j["error-codes"]);
    }
    return !!j.success;
  } catch (e) {
    console.error("turnstile siteverify threw", e);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Risk evaluation                                                            */
/* -------------------------------------------------------------------------- */

/** Read the current rate-limit bucket counter WITHOUT incrementing. The
 *  ratelimit module's `rateLimit()` bumps on every call; we need a pure
 *  peek so a quick risk check doesn't burn the user's quota. */
async function peekBucketRatio(
  kv: KVNamespace,
  bucket: string,
  ip: string,
  windowSec: number,
  limit: number
): Promise<number> {
  if (!ip || ip === "unknown" || limit <= 0) return 0;
  try {
    const now = Math.floor(Date.now() / 1000);
    const window = Math.floor(now / windowSec) * windowSec;
    const raw = await kv.get(`__rl:${bucket}:${window}:${ip}`);
    const n = raw ? parseInt(raw, 10) || 0 : 0;
    return n / limit;
  } catch {
    return 0;
  }
}

async function isRisky(
  c: any,
  env: any,
  opts: CheckOpts,
  ip: string
): Promise<boolean> {
  // 1. VPN / datacenter ASN — already a hard block on /api/page, but for
  //    search/comment we additionally challenge instead of silently
  //    failing to surface the LLM features.
  if (isLikelyVpn(c)) return true;

  // 2. Sec-Fetch-Site. Every modern browser (Chrome 76+, Firefox 90+,
  //    Safari 16.4+) sends this on every fetch/XHR. Curl, Python
  //    requests, Go http, headless scrapers etc. send NOTHING. So for
  //    state-changing actions:
  //      - present and same-origin/same-site/none  → benign
  //      - present and cross-site/cross-origin     → risky (hostile script)
  //      - missing                                 → risky (almost certainly
  //                                                  a non-browser client)
  //    We skip this for search because search is GET and top-level
  //    navigation legitimately omits the header in some flows.
  if (opts.action !== "search") {
    const sfs = c.req.header("sec-fetch-site");
    if (!sfs) return true;
    if (sfs !== "same-origin" && sfs !== "same-site" && sfs !== "none") {
      return true;
    }
  }

  // 3. Hourly-bucket usage. Once an IP has burned >= RISKY_RATIO of its
  //    rate-limit quota for this surface, every subsequent call gets
  //    challenged. Light users never reach this threshold.
  if (opts.rateLimitBucket && opts.rateLimitPerHour) {
    const ratio = await peekBucketRatio(
      env.ARTICLES,
      opts.rateLimitBucket,
      ip,
      3600,
      opts.rateLimitPerHour
    );
    const conf = getConf(env);
    if (ratio >= conf.riskyRatio) return true;
  }

  // 4. Moderation strikes — opt-in per call site. Any history of an
  //    auto-moderated ban from this IP in the last 24h flips them to
  //    challenged.
  if (opts.checkStrikes && env.DB) {
    try {
      const recent = await countRecentBansByIp(env.DB, ip, 24 * 3600 * 1000);
      if (recent >= 1) return true;
    } catch {
      /* DB hiccup → fall open */
    }
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Gate a privileged action. On `{pass:true}`, run the protected code.
 *  On `{pass:false}`, return `challengeResponse(c, action)` (or an
 *  equivalent JSON body with `needs_challenge:true` for endpoints whose
 *  shape can't be replaced with a 428). */
export async function requireHuman(
  c: any,
  opts: CheckOpts
): Promise<CheckResult> {
  const conf = getConf(c.env);

  // Fall open when Turnstile isn't fully configured. Keeps local dev and
  // unconfigured deployments from breaking; making the feature opt-in.
  if (!conf.secretKey || !conf.trustSecret) return { pass: true };

  const ip = clientIp(c);

  // Trust-cookie fast path: a prior successful challenge in this session
  // grants 30 min of free passage across all gated endpoints.
  const cookieVal = getCookie(c, TRUST_COOKIE);
  if (cookieVal && (await verifyTrust(conf.trustSecret, cookieVal, ip))) {
    return { pass: true };
  }

  // Fresh-token path: SPA retried with the Turnstile widget result.
  // Verify it with Cloudflare, then mint the trust cookie so subsequent
  // calls in this session skip step 3 below.
  const token = c.req.header(HEADER_TOKEN);
  if (token) {
    const ok = await verifyToken(conf.secretKey, token, ip);
    if (ok) {
      try {
        const v = await signTrust(conf.trustSecret, ip, conf.trustTtlSec);
        setCookie(c, TRUST_COOKIE, v, {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          secure: new URL(c.req.url).protocol === "https:",
          maxAge: conf.trustTtlSec,
        });
      } catch (e) {
        console.error("turnstile: setCookie failed", e);
      }
      return { pass: true };
    }
    // Token present but invalid (expired, reused, wrong site) → fall
    // through to risk check, which will almost certainly demand a fresh
    // one. Don't return pass:true on a forged token.
  }

  // Neither cookie nor valid token. Pass benign visitors, demand a
  // challenge for risky ones.
  if (!(await isRisky(c, c.env, opts, ip))) {
    return { pass: true };
  }

  return { pass: false, reason: "challenge" };
}

/** Build the standard 428 "go solve a Turnstile" response. Body includes
 *  the public site key so the SPA can render the widget without an extra
 *  round trip. */
export function challengeResponse(c: any, action: Action): Response {
  const conf = getConf(c.env);
  return c.json(
    {
      error: "human check required",
      needs_challenge: true,
      action,
      site_key: conf.siteKey,
    },
    428,
    { "x-robots-tag": "noindex" }
  );
}
