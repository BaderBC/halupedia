/**
 * Presence — single Durable Object tracking who is reading what, in real time.
 *
 * Design (from the brainstorming round):
 *   - One global DO. Every WebSocket from every reader lands here. At
 *     halupedia's traffic level (low thousands of concurrent at HN-peak)
 *     a single DO is well below the ~10k–30k WS practical ceiling, and
 *     keeping state in one place is dramatically simpler than per-slug DOs.
 *   - Hibernation API: state.acceptWebSocket() means an idle DO is evicted
 *     from memory. We don't pay for sitting-idle CPU. Subsequent
 *     webSocketMessage / webSocketClose events wake it.
 *   - No heartbeats, no sendBeacon. Departures are detected by the runtime
 *     firing webSocketClose() — works across tab close, navigation, network
 *     drop, OS sleep, browser kill.
 *   - Per-WS state lives in ws.serializeAttachment(). Counts are recomputed
 *     by walking state.getWebSockets() on every broadcast tick, so we never
 *     need to keep a separate Map in sync with hibernation.
 *
 * Protocol:
 *   client → server   {"t":"r","s":"slug-or-null"}
 *                     "I'm now reading <slug>". slug=null means "connected
 *                     but not on an article" (search / all-entries).
 *   server → client   {"t":"hi"}
 *                     Sent once on accept.
 *   server → client   {"t":"top","items":[{"s":"slug","ti":"Title","n":12}]}
 *                     Top-N broadcast, sent on every tick where the top
 *                     changed. Same payload to every WS — cheap fan-out.
 *   server → client   {"t":"here","s":"slug","n":23}
 *                     Per-client. Sent when the count for THIS client's
 *                     current slug changes since we last told them.
 *
 * Broadcast cadence: BROADCAST_INTERVAL_MS via DO alarm. Events schedule the
 * alarm if one isn't already pending; the alarm fires once, broadcasts, and
 * doesn't auto-reschedule. Idle DO has no alarm running.
 */

import { slugToTitle, slugify } from "./slug";

interface PresenceEnv {
  ARTICLES: KVNamespace;
}

const BROADCAST_INTERVAL_MS = 3000;
const TOP_N = 5;
const MAX_MSG_BYTES = 1000;
const RATE_BURST = 10; // messages per second per WS before we close
const TOTAL_WS_CAP = 30000; // hard ceiling per DO

interface Attachment {
  /** Slug the client is currently reading. null = connected but idle. */
  s: string | null;
  /** Recent message timestamps (ms) for rate limiting. */
  msgs: number[];
  /** Last "here" count we sent this client for `s`. */
  ls?: number;
}

// NOTE on titles:
//   Titles are derived from server-owned article metadata; if not available,
//   we fall back to deterministic slug formatting. This prevents sidebar
//   poisoning from untrusted text.

interface TopItem {
  s: string;
  ti: string;
  n: number;
}

export class PresenceDO implements DurableObject {
  state: DurableObjectState;
  env: PresenceEnv;

  /**
   * Authoritative slug → title map. Single source of truth for what to
   * render in "Currently Being Consulted". Updated from canonicalized slugs
   * on every `r` message; entries are evicted when the slug has zero live
   * readers. In-memory only — the DO can hibernate and lose this map;
   * the very next `r` for an affected slug repopulates it.
   */
  private titles: Map<string, string> = new Map();

  constructor(state: DurableObjectState, env: PresenceEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // Backpressure: refuse new WS if we're at the per-DO cap. The escape
    // hatch (sharding by client hash) only matters if this ever trips.
    if (this.state.getWebSockets().length >= TOTAL_WS_CAP) {
      return new Response("presence at capacity", { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API. Subsequent message/close events arrive as method
    // calls on this class; the DO does not stay in memory between them.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      s: null,
      msgs: [],
    } as Attachment);

    try {
      server.send(JSON.stringify({ t: "hi" }));
      // Send the current top snapshot so a fresh tab populates immediately
      // instead of waiting up to BROADCAST_INTERVAL_MS for the next tick.
      const top = this.computeTop();
      server.send(JSON.stringify({ t: "top", items: top }));
    } catch {
      /* socket already gone; ignore */
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: ArrayBuffer | string
  ): Promise<void> {
    const text =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(message);
    if (text.length > MAX_MSG_BYTES) {
      try {
        ws.close(1009, "message too large");
      } catch {}
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // silently drop malformed
    }
    if (!parsed || parsed.t !== "r") return;

    const att = (ws.deserializeAttachment() as Attachment | null) ?? {
      s: null,
      msgs: [],
    };

    // Rate limit: more than RATE_BURST messages in the last second → close.
    // Legitimate clients send one `r` per navigation; ~10/s is generous.
    const now = Date.now();
    const recent = att.msgs.filter((t) => now - t < 1000);
    recent.push(now);
    if (recent.length > RATE_BURST) {
      try {
        ws.close(1008, "rate limit");
      } catch {}
      return;
    }

    let s: string | null = null;
    if (parsed.s != null) {
      const canonical = slugify(String(parsed.s));
      if (canonical) {
        s = canonical;
      }
    }

    // If the slug changed, reset our "last sent" so the broadcast loop is
    // sure to send a fresh `here` for the new slug.
    const slugChanged = att.s !== s;
    const newAtt: Attachment = {
      s,
      msgs: recent.slice(-RATE_BURST),
      ls: slugChanged ? undefined : att.ls,
    };
    ws.serializeAttachment(newAtt);

    // Title bookkeeping: titles are derived from server-owned article metadata
    // only, never from client-provided text.
    let titleChanged = false;
    if (s) {
      const canonicalTitle = await this.resolveTitle(s);
      if (this.titles.get(s) !== canonicalTitle) {
        this.titles.set(s, canonicalTitle);
        titleChanged = true;
      }
    }

    // Broadcast on slug change (someone joined/left a slug). Title changes
    // here are effectively no-ops unless they alter the top list.
    if (slugChanged || titleChanged) {
      await this.broadcastAll();
    }
  }

  /**
   * Recompute counts and fan out `top` (when changed) and per-client
   * `here` updates to every connected websocket. Called from both
   * webSocketMessage (slug change) and webSocketClose (departure), and
   * still from the alarm() as a backstop.
   */
  private async broadcastAll(): Promise<void> {
    const sockets = this.liveSockets();
    if (sockets.length === 0) {
      // No live clients — clear persisted top so a future broadcast with
      // an empty list registers as a real change rather than a no-op.
      // Also drop the title cache: nothing keeps it alive, and we don't
      // want stale entries lingering across long idle periods.
      this.titles.clear();
      await this.state.storage.delete("lastTop");
      return;
    }

    const allCounts = this.computeAllCounts(sockets);
    const sliced = this.snapshotTop(allCounts);

    // Garbage-collect titles whose slug no longer has any live reader.
    // Cheap (O(titles)) and keeps memory bounded under churn.
    if (this.titles.size > allCounts.size) {
      for (const slug of this.titles.keys()) {
        if (!allCounts.has(slug)) this.titles.delete(slug);
      }
    }

    const prevTop = (await this.state.storage.get<TopItem[]>("lastTop")) ?? [];
    const topChanged =
      prevTop.length !== sliced.length ||
      prevTop.some((p, i) => {
        const c = sliced[i];
        return !c || c.s !== p.s || c.n !== p.n || c.ti !== p.ti;
      });

    if (topChanged) {
      await this.state.storage.put("lastTop", sliced);
    }

    const topMsg = JSON.stringify({ t: "top", items: sliced });

    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;

      try {
        // bufferedAmount is available on standard WebSocket; treat large
        // backlogs as dead and force-close.
        if (
          typeof (ws as any).bufferedAmount === "number" &&
          (ws as any).bufferedAmount > 1_000_000
        ) {
          try {
            ws.close(1011, "backpressure");
          } catch {}
          continue;
        }

        if (topChanged) ws.send(topMsg);

        if (att.s) {
          const myCount = allCounts.get(att.s) ?? 0;
          if (myCount !== att.ls) {
            ws.send(JSON.stringify({ t: "here", s: att.s, n: myCount }));
            ws.serializeAttachment({ ...att, ls: myCount } as Attachment);
          }
        }
      } catch {
        /* dead socket; runtime will fire webSocketClose */
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    try {
      ws.close(code, "closed");
    } catch {}
    // Broadcast immediately on departure so other clients see the
    // updated counts/top without waiting for the next alarm tick.
    await this.broadcastAll();
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    await this.broadcastAll();
  }

  /**
   * Coalesce broadcast work: if an alarm is already pending, do nothing.
   * Otherwise schedule one BROADCAST_INTERVAL_MS out. Many events in quick
   * succession produce exactly one broadcast.
   */
  private async scheduleTick(): Promise<void> {
    const cur = await this.state.storage.getAlarm();
    if (cur != null) return;
    await this.state.storage.setAlarm(Date.now() + BROADCAST_INTERVAL_MS);
  }

  /**
   * Return only the websockets we should treat as live participants:
   * readyState === OPEN. The hibernation runtime can briefly leave
   * closed/closing sockets in `getWebSockets()` between the actual
   * underlying close and `webSocketClose()` firing — those would
   * otherwise inflate counts and keep ghost slugs in the trending list.
   */
  private liveSockets(): WebSocket[] {
    return this.state
      .getWebSockets()
      .filter((ws) => ws.readyState === 1 /* OPEN */);
  }

  /** Walk live WS, group by slug, return top-N by count. */
  private computeTop(): TopItem[] {
    const live = this.liveSockets();
    return this.snapshotTop(this.computeAllCounts(live));
  }

  /** Same walk as computeTop, but returns the full count map (for `here`). */
  private computeAllCounts(sockets: WebSocket[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att?.s) continue;
      counts.set(att.s, (counts.get(att.s) ?? 0) + 1);
    }
    return counts;
  }

  /** Build a sorted top-N from a precomputed counts map. Titles come
   *  from the DO-level `titles` map (canonical slug -> title), NOT from
   *  socket attachments — that's the whole point of the refactor. */
  private snapshotTop(counts: Map<string, number>): TopItem[] {
    const arr: TopItem[] = [];
    for (const [s, n] of counts) {
      const ti = this.titles.get(s) ?? slugToTitle(s);
      this.titles.set(s, ti);
      arr.push({ s, ti, n });
    }
    arr.sort((a, b) => b.n - a.n || a.s.localeCompare(b.s));
    return arr.slice(0, TOP_N);
  }

  /** Load a trusted title for this slug from KV metadata or fallback. */
  private async resolveTitle(slug: string): Promise<string> {
    const cached = this.titles.get(slug);
    if (cached) return cached;

    try {
      const fromKv = await this.env.ARTICLES.get(slug, "json") as
        | { title?: string }
        | null;
      const title = fromKv?.title?.trim();
      if (title) {
        this.titles.set(slug, title);
        return title;
      }
    } catch {
      /* ignored; fallback below */
    }

    const fallback = slugToTitle(slug);
    this.titles.set(slug, fallback);
    return fallback;
  }

  async alarm(): Promise<void> {
    // Backstop only: navigation and departures already broadcast eagerly
    // via broadcastAll(). The alarm exists in case a client's view drifts
    // (e.g. a `here` send was dropped). Cheap, idempotent, no reschedule.
    await this.broadcastAll();
  }
}
