import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { solveTurnstile } from "./turnstile";

interface SearchItem {
  slug: string;
  title: string;
  exists: boolean;
}

interface SearchResponse {
  query: string;
  results: SearchItem[];
  existing_count: number;
  hallucinated_count: number;
  rate_limited: boolean;
  retry_after: number | null;
  // Set by the server when the LLM-suggestion path was skipped because
  // the visitor looks risky and hasn't yet passed a Turnstile challenge.
  // The SPA offers an inline "Verify to unlock AI suggestions" button.
  needs_challenge?: boolean;
  site_key?: string;
}

interface Props {
  q: string;
  onNavigate: (slug: string) => void;
  onSearch: (q: string) => void;
}

export function SearchResults({ q, onNavigate, onSearch }: Props) {
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(q);
  const [verifying, setVerifying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Keep the input mirrored to the route's query (e.g. when user hits Back).
  useEffect(() => {
    setDraft(q);
  }, [q]);

  // Fetch whenever the route's query changes.
  useEffect(() => {
    if (!q) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          throw new Error(j?.error || `error ${res.status}`);
        }
        const j: SearchResponse = await res.json();
        if (ctrl.signal.aborted) return;
        setData(j);
        setLoading(false);
      } catch (e: any) {
        if (ctrl.signal.aborted || e?.name === "AbortError") return;
        setError(e?.message || "search failed");
        setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [q]);

  useEffect(() => {
    document.title = q
      ? `Search: ${q} — Halupedia`
      : "Search — Halupedia";
  }, [q]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = draft.trim();
      if (!trimmed) return;
      onSearch(trimmed);
    },
    [draft, onSearch]
  );

  // Re-fetch the current query without changing the URL. Used after a
  // successful Turnstile verification so AI suggestions appear inline.
  const refetch = useCallback(async () => {
    if (!q) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: ctrl.signal,
        credentials: "same-origin",
      });
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(j?.error || `error ${res.status}`);
      }
      const j: SearchResponse = await res.json();
      if (ctrl.signal.aborted) return;
      setData(j);
    } catch (e: any) {
      if (!ctrl.signal.aborted && e?.name !== "AbortError") {
        setError(e?.message || "search failed");
      }
    } finally {
      setLoading(false);
    }
  }, [q]);

  const onVerify = useCallback(async () => {
    if (verifying) return;
    setVerifying(true);
    try {
      const token = await solveTurnstile(data?.site_key);
      // Mint the trust cookie via the dedicated verify endpoint. The
      // server runs requireHuman (which writes the Set-Cookie) and
      // returns 200; subsequent search calls then bypass the challenge
      // and run the LLM-suggestion path.
      const ok = await fetch("/api/turnstile/verify", {
        method: "POST",
        headers: { "x-turnstile-token": token },
        credentials: "same-origin",
      });
      if (!ok.ok) {
        throw new Error("verification rejected by server");
      }
      await refetch();
    } catch (e: any) {
      setError(e?.message || "verification failed");
    } finally {
      setVerifying(false);
    }
  }, [data?.site_key, refetch, verifying]);

  const onLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, slug: string) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onNavigate(slug);
    },
    [onNavigate]
  );

  const { existingResults, unwrittenResults } = useMemo(() => {
    const e: SearchItem[] = [];
    const u: SearchItem[] = [];
    for (const r of data?.results ?? []) {
      (r.exists ? e : u).push(r);
    }
    return { existingResults: e, unwrittenResults: u };
  }, [data]);

  return (
    <div className="search-page">
      <header className="search-header">
        <h1>Search</h1>
        <p className="search-subtitle">
          Existing entries are listed first. The rest are plausible titles the
          encyclopedia hasn't yet committed to paper — click one and it will be
          dreamt up on the spot.
        </p>
      </header>

      <form className="search-form" onSubmit={onSubmit}>
        <input
          type="search"
          className="search-input"
          placeholder="Search Halupedia…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={100}
          autoFocus
        />
        <button
          type="submit"
          className="search-submit"
          disabled={!draft.trim()}
        >
          Search
        </button>
      </form>

      {!q && (
        <p className="search-hint">
          Try a name, a place, a century, an obscure ritual — or anything at
          all.
        </p>
      )}

      {error && <div className="search-error">{error}</div>}

      {q && loading && (
        <p className="search-status">
          <span className="dot" /> Consulting the index and hallucinating
          alternatives…
        </p>
      )}

      {q && data && !loading && (
        <>
          {data.rate_limited && !data.needs_challenge && (
            <div className="search-ratelimit">
              You've hit the search-suggestion rate limit. Showing only entries
              already in the encyclopedia — no new hallucinations this round.
              Try again later.
            </div>
          )}

          {data.needs_challenge && (
            <div className="search-ratelimit">
              <p style={{ margin: "0 0 0.5rem 0" }}>
                AI suggestions are paused for this session pending a quick
                human check.
              </p>
              <button
                type="button"
                className="search-submit"
                onClick={onVerify}
                disabled={verifying}
              >
                {verifying ? "Verifying…" : "Verify to unlock AI suggestions"}
              </button>
            </div>
          )}

          {data.results.length === 0 ? (
            <p className="search-empty">
              Nothing in the register, and the encyclopedia declines to invent
              anything new right now.
            </p>
          ) : (
            <div className="search-results">
              {existingResults.length > 0 && (
                <section className="search-section">
                  <h2 className="search-section-title">
                    In the encyclopedia
                    <span className="search-section-count">
                      {existingResults.length}
                    </span>
                  </h2>
                  <ul className="search-list">
                    {existingResults.map((r) => (
                      <li key={r.slug} className="search-item">
                        <a
                          href={`/${r.slug}`}
                          onClick={(e) => onLinkClick(e, r.slug)}
                        >
                          {r.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {unwrittenResults.length > 0 && (
                <section className="search-section">
                  <h2 className="search-section-title">
                    Not yet written
                    <span className="search-section-count">
                      {unwrittenResults.length}
                    </span>
                  </h2>
                  <ul className="search-list">
                    {unwrittenResults.map((r) => (
                      <li
                        key={r.slug}
                        className="search-item search-item-unwritten"
                      >
                        <a
                          href={`/${r.slug}`}
                          onClick={(e) => onLinkClick(e, r.slug)}
                          title="Not yet written — clicking will hallucinate it"
                        >
                          <span className="search-unwritten-mark" aria-hidden>
                            ✦
                          </span>
                          {r.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
