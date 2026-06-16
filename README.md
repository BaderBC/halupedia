# Halupedia

> *"Comprehensive coverage of topics mainstream encyclopedias overlooked."*

An infinite, hallucinated encyclopedia. Every link leads to an entry that does
not exist yet — until you click it, at which point an LLM pretends it has
always existed and writes it for you, in the deadpan register of a 19th-century
scholarly press.

Live at **[halupedia.com](https://halupedia.com)**.
Cooked on a Cloudflare Worker. Cached forever in KV. Threaded HN-style comments
under every article, no signup, AI-hallucinated identities. Patrons may
[buy us tokens](https://buymeacoffee.com/baderbc) so the press can keep
printing. Editors and conspirators meet in the
[Discord](https://discord.gg/fKMnyNwtGc).

---

## Table of contents

- [What it is](#what-it-is)
- [Star history](#star-history)
- [How a page is born](#how-a-page-is-born)
- [Consistency in a hallucinated universe](#consistency-in-a-hallucinated-universe)
- [Comments](#comments)
- [Defenses against runaway costs](#defenses-against-runaway-costs)
- [Architecture](#architecture)
- [Local development](#local-development)
- [Deploying your own instance](#deploying-your-own-instance)
- [Configuration](#configuration)
- [Contributing](#contributing)
- [License](#license)

---

## What it is

Halupedia is a single-page Cloudflare Worker that:

1. Serves a React SPA that looks like an old print encyclopedia.
2. On a request for any unknown slug, calls an LLM (via OpenRouter) that
   returns an HTML article in the encyclopedia's voice — full of confident,
   plausible-sounding nonsense that is densely cross-linked to other entries
   that also do not yet exist.
3. Caches that article in Cloudflare KV forever. Subsequent visits are free.
4. Lets readers leave HN-style threaded comments without ever signing up.
   Names are hallucinated by the LLM on first comment and tied to a cookie.

There is no editorial staff, no truth, no warranty. Every article is invented
on demand. The footnotes are also lies.

## Star history

<a href="https://www.star-history.com/?repos=BaderBC%2Fhalupedia&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=BaderBC/halupedia&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=BaderBC/halupedia&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=BaderBC/halupedia&type=date&legend=top-left" />
 </picture>
</a>

## How a page is born

```
   you click  ─►  /api/page/footnote-drift
                       │
                       ▼
              ┌──────────────────┐
              │ in KV already?   │── yes ─► stream from KV (free)
              └──────────────────┘
                       │ no
                       ▼
              ┌──────────────────┐
              │ are you a bot?   │── yes ─► 404 (no token spend)
              └──────────────────┘
                       │ no
                       ▼
              ┌──────────────────┐
              │ over IP rate?    │── yes ─► 429 with Retry-After
              └──────────────────┘
                       │ no
                       ▼
              ┌──────────────────────────────────┐
              │ load prior link-hints from D1    │
              │ (canon set by other articles)    │
              └──────────────────────────────────┘
                       │
                       ▼
              ┌──────────────────────────────────┐
              │ stream LLM via OpenRouter        │
              │  → split stream:                 │
              │    a) sanitize + send to client  │
              │    b) collect, persist to KV,    │
              │       extract & save link hints  │
              └──────────────────────────────────┘
```

The HTML stream is split (`ReadableStream.tee()`) so the user starts reading
the article *while* the worker is still receiving and persisting it. First
paint is sub-second; the worker continues writing to KV under
`ctx.waitUntil()` after the response closes.

## Consistency in a hallucinated universe

The hardest problem with an infinite, on-demand encyclopedia is internal
contradiction: article A says Mortimer Vellum died in 1843; article B,
generated three weeks later, says he was alive in 1881. Halupedia solves
this with **link hints**:

- When the LLM writes an article, it is required to add a `context="…"`
  attribute on every `<a>` it inserts, summarising the *future* article it is
  linking to (e.g. `context="19th-century clerk who formalized footnote drift,
  Pellbrick's mentor"`).
- Before serving the HTML, the worker harvests these `context` values into a
  `link_hints` table in D1, keyed by `(target_slug, source_slug)`.
- The `context` attribute is stripped before the HTML is sent to the browser —
  readers never see the metadata.
- When that target article is later requested for the first time, the worker
  loads the accumulated hints and injects them into the system prompt as
  **"PRIOR REFERENCES — these are CANON"**. The LLM is instructed that the
  encyclopedia is hallucinated and absurd, but it must not contradict itself.

The result is a write-forward consistency mechanism: each article seeds
breadcrumbs for the entries it links to, so by the time those entries are
written, the LLM has a small dossier of established lore to honour.

## Comments

Hacker-News-style threaded comments under every article. Backed by Cloudflare
D1 (free tier). Notable behaviours:

- **No signup, ever.** The first time you post, the LLM hallucinates a `name`
  and `username` for you (e.g. *Bartram Pellbrick-Thwaite* /
  `pellbrick_archivist`), in the same scholarly register as the rest of the
  site. You are inserted into D1 with a UUID and given a `hu_uid` cookie.
- **Cookie is effectively permanent** (capped at 400 days per RFC 6265bis,
  refreshed on every authenticated request — so active users never expire).
- **One upvote per comment per user**, toggleable. Optimistic UI.
- **Threaded** to arbitrary depth, sorted by `score DESC, created_at ASC`.
- **Author auto-upvotes their own post**, so every comment opens at score 1.
- **Per-IP rate limit on identity creation** so a botnet can't burn your
  budget by minting fresh hallucinated names in a loop.

## Defenses against runaway costs

LLM tokens cost real money and Halupedia is run by one person who lacks
a corporate Amex. The worker has a layered defense:

| Layer | Catches | Implementation |
|---|---|---|
| 1. User-Agent regex | Honest crawlers (Googlebot, GPTBot, ClaudeBot, curl, wget, scrapy, …) | `src/worker/index.ts` `isBot()` |
| 2. Per-IP article gen budget | UA-forging scrapers, runaway tabs | KV-backed fixed-window limiter, `GEN_PER_IP_PER_HOUR` |
| 3. Per-IP identity-mint budget | Cookie-rotating spammers minting hallucinated names | `IDENT_PER_IP_PER_HOUR` |
| 4. Global daily cap | Distributed botnets that defeat 1–3 | `MAX_ARTICLES_PER_DAY`, KV counter |
| 5. Cache forever | Same slug never costs twice | KV `put()` with `metadata` |
| 6. Tee-and-persist | Stream interruptions don't waste a generation | `ReadableStream.tee()` + `waitUntil()` |
| 7. Cloudflare dashboard | Volumetric / L7 attacks | WAF rate-limit + Bot Fight Mode |

Crucially: **cached articles are served to everyone, including bots.** The
bot guard only fires on uncached slugs, so anything you've already paid to
generate stays freely indexable for SEO.

## Architecture

```
src/
├── worker/
│   ├── index.ts        ← Hono app, request routing, generation pipeline
│   ├── llm.ts          ← OpenRouter streaming client + system prompt
│   ├── sanitize.ts     ← HTML allowlist + extracts link-hint metadata
│   ├── hints.ts        ← D1 read/write for cross-article canon
│   ├── identity.ts     ← LLM call that hallucinates {name, username}
│   ├── comments.ts     ← Hono sub-app: threaded comments + voting + cookies
│   ├── ratelimit.ts    ← Per-IP fixed-window KV limiter
│   ├── slug.ts         ← Slug normalisation + reserved-slug list
│   ├── seed.ts         ← Curated seed entries for the homepage
│   └── env.d.ts        ← Worker env type
├── client/
│   ├── App.tsx         ← SPA shell, history routing, streaming reader
│   ├── Comments.tsx    ← Threaded HN-style comment UI
│   ├── AllEntries.tsx  ← A–Z register of every article ever cached
│   └── styles.css      ← Single hand-rolled stylesheet (parchment aesthetic)
├── shared/
│   └── …               ← Types shared between worker & client
└── ...

migrations/
├── 0001_init.sql       ← users, comments, votes
└── 0002_link_hints.sql ← (target_slug, source_slug) → blurb
```

Stack:

- **Cloudflare Workers** — execution, runs everywhere, free tier covers viral.
- **Cloudflare KV** — article HTML cache, stores `{title, generatedAt}` in metadata.
- **Cloudflare D1** — comments, users, votes, link hints.
- **Hono** — small router + cookie helpers.
- **OpenRouter** — LLM access (model is configurable via env var).
- **Vite + React 18** — SPA, no router library; history API by hand.
- **No build step on the worker.** Wrangler bundles `src/worker/index.ts` and
  serves the Vite output as static assets via the `ASSETS` binding.

## Local development

You will need: Node 20+, pnpm 9, and a Cloudflare account.

```bash
pnpm install

# Create a D1 database (one-time)
pnpm wrangler d1 create hallupedia
# Copy the printed database_id into wrangler.toml, replacing the placeholder.

# Apply migrations locally
pnpm wrangler d1 migrations apply hallupedia --local

# Run vite (client) + wrangler (worker) concurrently
pnpm dev
```

Open <http://localhost:8787>. Articles will be generated on demand if you set
your `OPENROUTER_API_KEY` (see below); otherwise the homepage seed will
display but new entries will fail.

You can hit `http://localhost:8787/api/index?refresh=1` at any time to force
the total-entries counter to recount the KV namespace.

## Deploying your own instance

```bash
# 1. Configure secrets
pnpm wrangler secret put OPENROUTER_API_KEY

# 2. Apply migrations to the remote D1
pnpm wrangler d1 migrations apply hallupedia --remote

# 3. Deploy
pnpm run deploy
```

The Worker handles its own routing, including `/robots.txt`, the SPA shell,
and the API. If you bind a custom domain, edit the `[[routes]]` block in
`wrangler.toml`. To deploy to a `*.workers.dev` URL instead, set
`workers_dev = true` and remove the routes.

## Configuration

Defined in `wrangler.toml` under `[vars]`:

| Var | Default | Purpose |
|---|---|---|
| `OPENROUTER_MODEL` | (set in toml) | Model slug used for both article gen and identity hallucination |
| `MAX_ARTICLES_PER_DAY` | `5000` | Global circuit breaker — soft cap per UTC day |
| `GEN_PER_IP_PER_HOUR` | `100` | Per-IP article generation budget |
| `IDENT_PER_IP_PER_HOUR` | `10` | Per-IP cap on minting new commenter identities |
| `COMMENT_PER_IP_PER_HOUR` | `90` | Per-IP comment creation budget |
| `COMMENT_PER_IP_PER_MINUTE` | `15` | Per-IP comment burst budget |

Secrets (set via `wrangler secret put`):

| Secret | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Auth for OpenRouter |

Bindings:

- `ARTICLES` — KV namespace for article HTML.
- `DB` — D1 database for comments + link hints.
- `ASSETS` — static assets (Vite build output).

## Contributing

Pull requests welcome, especially anything that:

- Reduces token spend per article without making the prose worse.
- Improves cross-article consistency further.
- Hardens the bot/UA defenses without breaking real readers.
- Catches a "griffing" / prompt-injection vector you found in the wild.

Please open an issue first for anything user-facing so we can discuss tone —
Halupedia lives or dies by its voice and an out-of-register entry is
worse than no entry at all.

## License

GPL-3.0. The source code in this repository is free software: you can
redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

If the press has improved your day, you may
[buy us tokens](https://buymeacoffee.com/baderbc) or join the conversation on
[Discord](https://discord.gg/fKMnyNwtGc).
