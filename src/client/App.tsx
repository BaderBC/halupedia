import { useCallback, useEffect, useRef, useState } from "react";
import { Comments } from "./Comments";
import { AllEntries } from "./AllEntries";
import { SearchResults } from "./SearchResults";
import { Sidebar } from "./Sidebar";
import { usePresence } from "./usePresence";
import { ArticleVote } from "./ArticleVote";
import { Admin } from "./Admin";
import { gatedFetch } from "./turnstile";

const RESERVED_ALL_ENTRIES = "all-entries";
const RESERVED_SEARCH = "search";
const RESERVED_ADMIN = "admin";
/** The "/" homepage maps to this internal slug (see seed.ts). It is not
 *  votable and must not pollute the live "currently being consulted" list. */
const HOMEPAGE_SLUG = "halupedia";

type Status = "idle" | "loading" | "streaming" | "done" | "error" | "banned";

const DREAMING_MESSAGES = [
  "Consulting seventeen conflicting sources…",
  "Cross-referencing the index…",
  "Locating the relevant volume…",
  "Interviewing three anonymous experts…",
  "Resolving a minor scholarly dispute…",
];

function currentSlug(): string {
  const path = window.location.pathname.replace(/^\/+/, "");
  if (!path || path === "") return "halupedia";
  // Strip trailing slash.
  return decodeURIComponent(path.replace(/\/+$/, ""));
}

/** Read the ?q=… search param from the URL (only meaningful on /search). */
function currentSearchQuery(): string {
  return new URLSearchParams(window.location.search).get("q") || "";
}

export function App() {
  const [slug, setSlug] = useState<string>(() => currentSlug());
  const [searchQuery, setSearchQuery] = useState<string>(() =>
    currentSlug() === RESERVED_SEARCH ? currentSearchQuery() : ""
  );
  const [html, setHtml] = useState<string>("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dreamMsg, setDreamMsg] = useState<string>(DREAMING_MESSAGES[0]);
  const [headerSearchDraft, setHeaderSearchDraft] = useState<string>("");
  // Title of the currently-rendered article (extracted from the streamed
  // <h1>). Declared up here because the slug-change fetch effect needs to
  // reset it synchronously to avoid leaking a stale title into the next
  // article's presence broadcast.
  const [articleTitle, setArticleTitle] = useState<string>("");
  const prevSlugRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* ----- Popstate (back/forward) ----- */
  useEffect(() => {
    const onPop = () => {
      const s = currentSlug();
      // Clear the title in the same render as the slug change so the
      // presence effect below never sees the {new slug, old title} pair
      // mid-transition. (Backend is now resilient to that, but there's
      // no reason to ship known-wrong data.)
      setArticleTitle("");
      setSlug(s);
      setSearchQuery(s === RESERVED_SEARCH ? currentSearchQuery() : "");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /* ----- Fetch + stream on every slug change ----- */
  useEffect(() => {
    // Reserved client-only routes (all-entries, search, admin) bypass the
    // article fetch entirely — the SPA renders them itself.
    if (
      slug === RESERVED_ALL_ENTRIES ||
      slug === RESERVED_SEARCH ||
      slug === RESERVED_ADMIN
    ) {
      abortRef.current?.abort();
      setHtml("");
      setError(null);
      setStatus("done");
      return;
    }

    let cancelled = false;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setHtml("");
    setError(null);
    setStatus("loading");
    // Clear the previous article's title in the same tick the slug changes
    // so usePresence doesn't broadcast {s:newSlug, ti:oldTitle} during the
    // window before the new article's <h1> streams in. That stale pairing
    // was poisoning the server-side title cache for the new slug.
    setArticleTitle("");
    setDreamMsg(DREAMING_MESSAGES[Math.floor(Math.random() * DREAMING_MESSAGES.length)]);

    const from = prevSlugRef.current;
    const url = `/api/page/${encodeURIComponent(slug)}${from ? `?from=${encodeURIComponent(from)}` : ""}`;

    (async () => {
      try {
        const res = await gatedFetch(url, { signal: ctrl.signal });
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          if (j?.banned) {
            if (cancelled) return;
            setStatus("banned");
            return;
          }
          throw new Error(j?.error || `error ${res.status}`);
        }
        const cachedHeader = res.headers.get("x-halupedia-cached");
        const isCached = cachedHeader === "true";

        if (!res.body) {
          const text = await res.text();
          if (cancelled) return;
          setHtml(text);
          setStatus("done");
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let firstChunk = true;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          if (cancelled) return;
          if (firstChunk) {
            setStatus(isCached ? "done" : "streaming");
            firstChunk = false;
          }
          setHtml(accumulated);
        }
        accumulated += decoder.decode();
        if (cancelled) return;
        setHtml(accumulated);
        setStatus("done");
      } catch (e: any) {
        if (cancelled || e?.name === "AbortError") return;
        setError(e?.message || "generation failed");
        setStatus("error");
      }
    })();

    // Update browser title once we have an h1.
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [slug]);

  /* ----- Extract h1 title from the article HTML ----- */
  // Used both for `document.title` and for the presence broadcast (so the
  // "currently being read" panel shows real titles instead of slugified
  // fallbacks). State declared above with the rest because the slug-change
  // fetch effect resets it.
  useEffect(() => {
    if (!html) {
      setArticleTitle("");
      return;
    }
    const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m) {
      const title = m[1].replace(/<[^>]+>/g, "").trim();
      if (title) {
        document.title = `${title} — Halupedia`;
        setArticleTitle(title);
      }
    }
  }, [html]);

  /* ----- Presence: live "who is reading what" over a single WS ----- */
  // We feed the hook null on non-article views (search, all-entries) AND
  // on the homepage so "Halupedia" itself never shows up in the live
  // "currently being consulted" list. The WS stays connected; the user
  // is just counted as "idle" until they open a real folio.
  const presenceSlug =
    slug === RESERVED_ALL_ENTRIES ||
    slug === RESERVED_SEARCH ||
    slug === RESERVED_ADMIN ||
    slug === HOMEPAGE_SLUG
      ? null
      : slug;
  const presence = usePresence(presenceSlug, articleTitle);

  /* ----- Top folios (all-time, by upvotes) ----- */
  // Plain D1-backed list, no real-time bells. Refetched on first SPA load
  // and whenever the user successfully upvotes/retracts an article.
  const [topArticles, setTopArticles] = useState<
    { slug: string; title: string; score: number }[]
  >([]);
  const refreshTopArticles = useCallback(async () => {
    try {
      const res = await fetch("/api/articles/top?limit=5", {
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const j: { items: { slug: string; title: string; score: number }[] } =
        await res.json();
      setTopArticles(j.items ?? []);
    } catch {
      /* keep stale list */
    }
  }, []);
  useEffect(() => {
    refreshTopArticles();
  }, [refreshTopArticles]);

  /* ----- Internal link interception ----- */
  const onContainerClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const target = (e.target as HTMLElement).closest("a");
    if (!target) return;
    const href = target.getAttribute("href");
    if (!href || !href.startsWith("/")) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e as any).button === 1) return;
    e.preventDefault();
    navigateTo(href.slice(1));
  }, []);

  const navigateTo = useCallback(
    (nextSlug: string) => {
      const clean = nextSlug.replace(/^\/+|\/+$/g, "") || "halupedia";
      if (clean === slug && slug !== RESERVED_SEARCH) return;
      prevSlugRef.current = slug;
      // Homepage lives at "/", not "/halupedia". The internal slug stays
      // "halupedia" so the worker can still key its cache by it.
      const url = clean === "halupedia" ? "/" : `/${clean}`;
      window.history.pushState({}, "", url);
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      // Batch the title clear with the slug change. React renders both
      // state updates together, so the presence effect sees the new slug
      // with an empty title rather than the previous article's title.
      setArticleTitle("");
      setSlug(clean);
      setSearchQuery("");
    },
    [slug]
  );

  /** Navigate to /search?q=…  (keeps the query string in the URL, so back/
   *  forward and direct links work). */
  const navigateToSearch = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      // If the user re-submits the same query while on /search, force a
      // re-render by bumping state even though the URL is unchanged.
      const url = `/search?q=${encodeURIComponent(trimmed)}`;
      if (slug !== RESERVED_SEARCH || searchQuery !== trimmed) {
        prevSlugRef.current = slug;
        window.history.pushState({}, "", url);
      }
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      setSlug(RESERVED_SEARCH);
      setSearchQuery(trimmed);
    },
    [slug, searchQuery]
  );

  const onStumble = useCallback(async () => {
    try {
      const res = await fetch("/api/random");
      const j: any = await res.json();
      if (j?.slug) navigateTo(j.slug);
    } catch {}
  }, [navigateTo]);

  return (
    <div className="site">
      <header className="site-header">
        <div className="brand-stack">
          <a
            href="/"
            className="brand"
            onClick={(e) => {
              e.preventDefault();
              navigateTo("halupedia");
            }}
          >
            Halu<span className="amp">&middot;</span>pedia
          </a>
          <a
            href="https://buymeacoffee.com/baderbc"
            target="_blank"
            rel="noopener noreferrer"
            className="brand-donate"
            title="Donations go directly to LLM tokens so the press can keep printing."
          >
            Buy us tokens →
          </a>
        </div>
        <nav className="nav">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigateTo("halupedia");
            }}
          >
            Index
          </a>
          <a
            href="/all-entries"
            onClick={(e) => {
              e.preventDefault();
              navigateTo("all-entries");
            }}
          >
            All entries
          </a>
          <a
            href="#stumble"
            onClick={(e) => {
              e.preventDefault();
              onStumble();
            }}
          >
            Stumble
          </a>
          <a
            href="https://github.com/BaderBC/halupedia"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <a
            href="https://reddit.com/r/halupedia"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-reddit"
          >
            Reddit
          </a>
          <a
            href="https://discord.gg/fKMnyNwtGc"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-discord"
          >
            Discord
          </a>
        </nav>

        {slug !== RESERVED_SEARCH && (
          <form
            className="header-search"
            onSubmit={(e) => {
              e.preventDefault();
              navigateToSearch(headerSearchDraft);
              setHeaderSearchDraft("");
            }}
            role="search"
          >
            <input
              type="search"
              className="header-search-input"
              placeholder="Search…"
              value={headerSearchDraft}
              onChange={(e) => setHeaderSearchDraft(e.target.value)}
              maxLength={100}
              aria-label="Search Halupedia"
            />
            <button
              type="submit"
              className="header-search-submit"
              disabled={!headerSearchDraft.trim()}
            >
              Search
            </button>
          </form>
        )}
      </header>

      <div className="layout">
        <main
          className={`layout-main${status === "streaming" ? " streaming" : ""}`}
          onClick={onContainerClick}
        >
          {slug === RESERVED_ALL_ENTRIES ? (
            <AllEntries onNavigate={navigateTo} />
          ) : slug === RESERVED_SEARCH ? (
            <SearchResults
              q={searchQuery}
              onNavigate={navigateTo}
              onSearch={navigateToSearch}
            />
          ) : slug === RESERVED_ADMIN ? (
            <Admin />
          ) : (
            <>
              {status === "loading" && !html && (
                <div className="status">
                  <span className="dot" />
                  <span>{dreamMsg}</span>
                </div>
              )}
              {status === "streaming" && (
                <div className="status">
                  <span className="dot" />
                  <span>Retrieving entry…</span>
                </div>
              )}
              {status === "error" && error && (
                <div className="error">
                  Something broke, which is ironic for a made-up encyclopedia: {error}
                </div>
              )}
              {status === "banned" && (
                <div className="banned-notice">
                  <h1>Entry redacted</h1>
                  <p>
                    This article was flagged by moderation and removed from the
                    register. Halupedia will not regenerate it.
                  </p>
                  <p className="banned-notice-meta">
                    We keep the encyclopedia maximally absurd but draw the line
                    at hate speech, slurs, incitement, and keyword-spam. If you
                    believe this was removed in error, mention it in the{" "}
                    <a
                      href="https://discord.gg/fKMnyNwtGc"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Discord
                    </a>
                    .
                  </p>
                </div>
              )}
              <div
                className={`article-frame${
                  slug !== HOMEPAGE_SLUG ? " article-frame-votable" : ""
                }`}
              >
                {status === "done" && html && (
                  <ArticleVote
                    slug={presenceSlug}
                    onVoted={refreshTopArticles}
                  />
                )}
                <article
                  className="article"
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              </div>
            </>
          )}
        </main>

        <Sidebar
          slug={presenceSlug}
          onNavigate={navigateTo}
          presenceTop={presence.top}
          presenceHereCount={presence.hereCount}
          topArticles={topArticles}
        />

        {/* Comments live as a sibling of <main> (not a child) so the grid
            can place them BELOW the sidebar on mobile (where the column
            order should read article → sidebar → comments) while still
            sitting directly under the article on desktop. */}
        {slug !== RESERVED_ALL_ENTRIES &&
          slug !== RESERVED_SEARCH &&
          slug !== RESERVED_ADMIN &&
          status === "done" && <Comments slug={slug} />}
      </div>

      <footer className="site-footer">
        <p className="footer-tagline-line">
          Comprehensive coverage of topics mainstream encyclopedias overlooked.
        </p>
      </footer>
    </div>
  );
}
