import { useCallback, useEffect, useRef, useState } from "react";
import { gatedFetch } from "./turnstile";

/* -------------------------------------------------------------------------- */
/*  Types — kept in sync with src/worker/comments.ts                           */
/* -------------------------------------------------------------------------- */

export interface CommentUser {
  id: string;
  name: string;
  username: string;
}

export interface Comment {
  id: string;
  parent_id: string | null;
  user: CommentUser;
  body: string;
  created_at: number;
  score: number;
  voted: boolean;
  children: Comment[];
}

interface ThreadResponse {
  slug: string;
  total: number;
  roots_total: number;
  offset: number;
  limit: number;
  has_more: boolean;
  comments: Comment[];
  user: CommentUser | null;
}

const PAGE_SIZE = 50;

/** When a thread has more than this many root comments, the list is
 *  truncated to a preview on first render with an "Expand" button. This is
 *  purely client-side: the comments are already in `comments` state, we
 *  just don't render past `INITIAL_VISIBLE_ROOTS` until the reader asks.
 *  The expanded flag resets on full page reload (which is the intended UX
 *  — long threads should feel concise by default each visit). */
const INITIAL_VISIBLE_ROOTS = 5;

/* -------------------------------------------------------------------------- */
/*  Time formatting (HN-ish)                                                   */
/* -------------------------------------------------------------------------- */

function formatAge(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

/* -------------------------------------------------------------------------- */
/*  Tree mutation helpers (immutable)                                          */
/* -------------------------------------------------------------------------- */

function mapTree(
  list: Comment[],
  fn: (c: Comment) => Comment | null
): Comment[] {
  const out: Comment[] = [];
  for (const c of list) {
    const mapped = fn(c);
    if (!mapped) continue;
    out.push({ ...mapped, children: mapTree(mapped.children, fn) });
  }
  return out;
}

/** Recursively walk a tree, insert `child` under `parentId` if found, and
 *  re-sort the children of that parent according to the active sort mode. */
function insertAndSort(
  node: Comment,
  parentId: string,
  child: Comment,
  sort: SortMode
): Comment {
  if (node.id === parentId) {
    return { ...node, children: sortChildren([child, ...node.children], sort) };
  }
  return {
    ...node,
    children: node.children.map((c) => insertAndSort(c, parentId, child, sort)),
  };
}

type SortMode = "recommended" | "top" | "newest";

const SORT_LABELS: Record<SortMode, string> = {
  recommended: "Recommended",
  top: "Top",
  newest: "Newest",
};

/** Local re-sort for replies (children) — must match the server's logic in
 *  src/worker/comments.ts so a freshly-posted reply slots in correctly. */
function sortChildren(list: Comment[], sort: SortMode): Comment[] {
  const now = Date.now();
  const cmp = (a: Comment, b: Comment) => {
    if (sort === "newest") return b.created_at - a.created_at;
    if (sort === "top")
      return b.score - a.score || b.created_at - a.created_at;
    // recommended — must match src/worker/comments.ts compareDTO
    const ha =
      Math.sqrt(a.score) /
      Math.pow((now - a.created_at) / 3600000 + 2, 0.8);
    const hb =
      Math.sqrt(b.score) /
      Math.pow((now - b.created_at) / 3600000 + 2, 0.8);
    return hb - ha || b.created_at - a.created_at;
  };
  return [...list]
    .sort(cmp)
    .map((c) => ({ ...c, children: sortChildren(c.children, sort) }));
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

interface Props {
  slug: string;
}

export function Comments({ slug }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [user, setUser] = useState<CommentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [serverTotal, setServerTotal] = useState(0);
  const [rootsTotal, setRootsTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [sort, setSort] = useState<SortMode>("recommended");
  // Client-side preview-vs-full toggle for long threads. Resets to false on
  // slug/sort change (see effect below) and on full page reload (state is
  // not persisted anywhere).
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /* ----- Fetch on slug or sort change ----- */
  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    setComments([]);
    setReplyTo(null);
    setReplyDraft("");
    setCollapsed(new Set());
    setServerTotal(0);
    setRootsTotal(0);
    setHasMore(false);
    setExpanded(false);

    (async () => {
      try {
        const res = await fetch(
          `/api/comments/${encodeURIComponent(slug)}?offset=0&limit=${PAGE_SIZE}&sort=${sort}`,
          { signal: ctrl.signal, credentials: "same-origin" }
        );
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          throw new Error(j?.error || `error ${res.status}`);
        }
        const data: ThreadResponse = await res.json();
        if (ctrl.signal.aborted) return;
        setComments(data.comments);
        setUser(data.user);
        setServerTotal(data.total);
        setRootsTotal(data.roots_total);
        setHasMore(data.has_more);
        setLoading(false);
      } catch (e: any) {
        if (ctrl.signal.aborted || e?.name === "AbortError") return;
        setError(e?.message || "failed to load comments");
        setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [slug, sort]);

  /* ----- Load next page of root comments ----- */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/comments/${encodeURIComponent(slug)}?offset=${comments.length}&limit=${PAGE_SIZE}&sort=${sort}`,
        { credentials: "same-origin" }
      );
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(j?.error || `error ${res.status}`);
      }
      const data: ThreadResponse = await res.json();
      setComments((cur) => [...cur, ...data.comments]);
      setServerTotal(data.total);
      setRootsTotal(data.roots_total);
      setHasMore(data.has_more);
    } catch (e: any) {
      setError(e?.message || "failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [comments.length, hasMore, loadingMore, slug, sort]);

  /* ----- Submit a new top-level comment ----- */
  const submitTopLevel = useCallback(async () => {
    const body = draft.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    try {
      const res = await gatedFetch(`/api/comments/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(j?.error || `error ${res.status}`);
      }
      const j: { comment: Comment; user: CommentUser } = await res.json();
      setUser(j.user);
      // Always prepend so the user sees their fresh post regardless of sort
      // mode. The server’s ranking will catch up on the next refresh.
      setComments((cur) => [j.comment, ...cur]);
      setServerTotal((n) => n + 1);
      setRootsTotal((n) => n + 1);
      setDraft("");
    } catch (e: any) {
      setError(e?.message || "failed to post");
    } finally {
      setSubmitting(false);
    }
  }, [draft, slug, submitting]);

  /* ----- Submit a reply ----- */
  const submitReply = useCallback(
    async (parentId: string) => {
      const body = replyDraft.trim();
      if (!body || submitting) return;
      setSubmitting(true);
      try {
        const res = await gatedFetch(`/api/comments/${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ body, parent_id: parentId }),
        });
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          throw new Error(j?.error || `error ${res.status}`);
        }
        const j: { comment: Comment; user: CommentUser } = await res.json();
        setUser(j.user);
        // Insert the reply in-place; re-sort only the affected subtree.
        setComments((cur) =>
          cur.map((root) => insertAndSort(root, parentId, j.comment, sort))
        );
        setServerTotal((n) => n + 1);
        setReplyTo(null);
        setReplyDraft("");
      } catch (e: any) {
        setError(e?.message || "failed to post");
      } finally {
        setSubmitting(false);
      }
    },
    [replyDraft, slug, sort, submitting]
  );

  /* ----- Toggle vote ----- */
  const toggleVote = useCallback(async (id: string) => {
    // Optimistic update.
    setComments((cur) =>
      mapTree(cur, (c) => {
        if (c.id !== id) return c;
        const voted = !c.voted;
        return { ...c, voted, score: c.score + (voted ? 1 : -1) };
      })
    );
    try {
      const res = await fetch(
        `/api/comments/${encodeURIComponent(id)}/vote`,
        {
          method: "POST",
          credentials: "same-origin",
        }
      );
      if (!res.ok) throw new Error(`vote failed`);
      const j: { voted: boolean; score: number; user: CommentUser } =
        await res.json();
      setUser(j.user);
      setComments((cur) =>
        mapTree(cur, (c) =>
          c.id === id ? { ...c, voted: j.voted, score: j.score } : c
        )
      );
    } catch {
      // Roll back on failure.
      setComments((cur) =>
        mapTree(cur, (c) => {
          if (c.id !== id) return c;
          const voted = !c.voted;
          return { ...c, voted, score: c.score + (voted ? 1 : -1) };
        })
      );
    }
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <section className="comments" aria-label="Reader speculations">
      <header className="comments-header">
        <h2>Reader speculations</h2>
        <span className="comments-count">
          {loading
            ? "—"
            : `${serverTotal} entr${serverTotal === 1 ? "y" : "ies"}`}
        </span>
        <div className="comments-sort" role="tablist" aria-label="Sort comments">
          {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
            <button
              key={mode}
              role="tab"
              aria-selected={sort === mode}
              className={`comments-sort-btn ${sort === mode ? "active" : ""}`}
              onClick={() => setSort(mode)}
              disabled={loading || sort === mode}
            >
              {SORT_LABELS[mode]}
            </button>
          ))}
        </div>
      </header>

      {/* Identity strip — only shown after a user has been minted. */}
      {user && (
        <div className="comments-identity">
          <span className="comments-identity-label">Posting as</span>
          <span className="comments-identity-name">{user.name}</span>
          <span className="comments-identity-handle">@{user.username}</span>
        </div>
      )}
      {!user && !loading && (
        <p className="comments-identity-hint">
          You have no name yet. One will be assigned to you on first comment;
          you cannot choose it.
        </p>
      )}

      {/* Top-level composer */}
      <CommentComposer
        value={draft}
        onChange={setDraft}
        onSubmit={submitTopLevel}
        submitting={submitting}
        placeholder="Add to the record. Speculation encouraged; citations optional."
        submitLabel="Submit entry"
      />

      {error && <div className="comments-error">{error}</div>}

      {loading ? (
        <p className="comments-status">Consulting the marginalia…</p>
      ) : comments.length === 0 ? (
        <p className="comments-empty">
          No reader has yet commented on this entry.
        </p>
      ) : (
        <>
          {(() => {
            const truncated =
              !expanded && comments.length > INITIAL_VISIBLE_ROOTS;
            const visible = truncated
              ? comments.slice(0, INITIAL_VISIBLE_ROOTS)
              : comments;
            const hiddenCount = comments.length - visible.length;
            return (
              <>
                <ol className="comments-list">
                  {visible.map((c) => (
                    <CommentNode
                      key={c.id}
                      comment={c}
                      depth={0}
                      replyTo={replyTo}
                      setReplyTo={setReplyTo}
                      replyDraft={replyDraft}
                      setReplyDraft={setReplyDraft}
                      submitReply={submitReply}
                      submitting={submitting}
                      toggleVote={toggleVote}
                      collapsed={collapsed}
                      toggleCollapse={toggleCollapse}
                    />
                  ))}
                </ol>
                {truncated && (
                  <div className="comments-loadmore comments-expand">
                    <button
                      className="comment-link"
                      onClick={() => setExpanded(true)}
                    >
                      Expand ({hiddenCount} more
                      {hasMore ? " loaded" : ""})
                    </button>
                  </div>
                )}
              </>
            );
          })()}
          {hasMore && (!expanded ? comments.length <= INITIAL_VISIBLE_ROOTS : true) && (
            <div className="comments-loadmore">
              <button
                className="comment-link"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore
                  ? "Fetching more marginalia…"
                  : `Load more (${rootsTotal - comments.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function countTotal(list: Comment[]): number {
  let n = 0;
  for (const c of list) n += 1 + countTotal(c.children);
  return n;
}

/* -------------------------------------------------------------------------- */
/*  Comment node                                                               */
/* -------------------------------------------------------------------------- */

interface NodeProps {
  comment: Comment;
  depth: number;
  replyTo: string | null;
  setReplyTo: (id: string | null) => void;
  replyDraft: string;
  setReplyDraft: (s: string) => void;
  submitReply: (parentId: string) => void;
  submitting: boolean;
  toggleVote: (id: string) => void;
  collapsed: Set<string>;
  toggleCollapse: (id: string) => void;
}

function CommentNode({
  comment,
  depth,
  replyTo,
  setReplyTo,
  replyDraft,
  setReplyDraft,
  submitReply,
  submitting,
  toggleVote,
  collapsed,
  toggleCollapse,
}: NodeProps) {
  const isCollapsed = collapsed.has(comment.id);
  const childCount = countTotal(comment.children);

  return (
    <li className="comment" style={{ marginLeft: Math.min(depth, 8) * 14 }}>
      <div className="comment-row">
        <button
          className={`vote ${comment.voted ? "voted" : ""}`}
          onClick={() => toggleVote(comment.id)}
          aria-label={comment.voted ? "Remove upvote" : "Upvote"}
          aria-pressed={comment.voted}
          title={comment.voted ? "Retract upvote" : "Upvote"}
        >
          <span className="vote-arrow" aria-hidden>▲</span>
        </button>

        <div className="comment-body">
          <header className="comment-meta">
            <button
              className="comment-collapse"
              onClick={() => toggleCollapse(comment.id)}
              aria-expanded={!isCollapsed}
              title={isCollapsed ? "Expand" : "Collapse"}
            >
              [{isCollapsed ? "+" : "–"}]
            </button>
            <span className="comment-author" title={comment.user.name}>
              {comment.user.name}
            </span>
            <span className="comment-handle">@{comment.user.username}</span>
            <span className="sep">·</span>
            <span className="comment-score">
              {comment.score} point{comment.score === 1 ? "" : "s"}
            </span>
            <span className="sep">·</span>
            <span className="comment-age">{formatAge(comment.created_at)}</span>
            {isCollapsed && childCount > 0 && (
              <>
                <span className="sep">·</span>
                <span className="comment-collapsed-count">
                  ({childCount} hidden)
                </span>
              </>
            )}
          </header>

          {!isCollapsed && (
            <>
              <div className="comment-text">{renderBody(comment.body)}</div>
              <footer className="comment-actions">
                <button
                  className="comment-link"
                  onClick={() =>
                    setReplyTo(replyTo === comment.id ? null : comment.id)
                  }
                >
                  {replyTo === comment.id ? "cancel" : "reply"}
                </button>
              </footer>

              {replyTo === comment.id && (
                <CommentComposer
                  value={replyDraft}
                  onChange={setReplyDraft}
                  onSubmit={() => submitReply(comment.id)}
                  submitting={submitting}
                  placeholder="A measured rejoinder…"
                  submitLabel="Submit reply"
                  compact
                />
              )}

              {comment.children.length > 0 && (
                <ol className="comments-list nested">
                  {comment.children.map((child) => (
                    <CommentNode
                      key={child.id}
                      comment={child}
                      depth={depth + 1}
                      replyTo={replyTo}
                      setReplyTo={setReplyTo}
                      replyDraft={replyDraft}
                      setReplyDraft={setReplyDraft}
                      submitReply={submitReply}
                      submitting={submitting}
                      toggleVote={toggleVote}
                      collapsed={collapsed}
                      toggleCollapse={toggleCollapse}
                    />
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/** Plain-text body renderer that preserves paragraphs and line breaks. */
function renderBody(body: string) {
  const paragraphs = body.split(/\n{2,}/);
  return paragraphs.map((p, i) => (
    <p key={i}>
      {p.split("\n").map((line, j, arr) => (
        <span key={j}>
          {line}
          {j < arr.length - 1 && <br />}
        </span>
      ))}
    </p>
  ));
}

/* -------------------------------------------------------------------------- */
/*  Composer                                                                   */
/* -------------------------------------------------------------------------- */

interface ComposerProps {
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  placeholder: string;
  submitLabel: string;
  compact?: boolean;
}

function CommentComposer({
  value,
  onChange,
  onSubmit,
  submitting,
  placeholder,
  submitLabel,
  compact,
}: ComposerProps) {
  const remaining = 2000 - value.length;
  return (
    <div className={`comment-composer ${compact ? "compact" : ""}`}>
      <textarea
        className="comment-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={compact ? 3 : 4}
        maxLength={2000}
        disabled={submitting}
      />
      <div className="comment-composer-row">
        <span
          className={`comment-counter ${remaining < 0 ? "over" : ""}`}
          aria-live="polite"
        >
          {remaining} chars left
        </span>
        <button
          className="comment-submit"
          onClick={onSubmit}
          disabled={submitting || value.trim().length === 0}
        >
          {submitting ? "Filing…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
