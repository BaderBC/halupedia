/**
 * usePresence — single WebSocket to /api/presence for the lifetime of the SPA.
 *
 * Sends one `{t:"r", s}` message per navigation. The server fans back:
 *   - `top`  — global top-N {slug,title,count}, refreshed every ~3s when changed
 *   - `here` — count of readers on the current slug, when it changes
 *
 * On disconnect we reconnect with jittered exponential backoff. If the WS
 * never opens, the hook silently returns empty data — the sidebar panel
 * will hide itself, and nothing else in the app breaks.
 */

import { useEffect, useRef, useState } from "react";

export interface PresenceTopItem {
  slug: string;
  title: string;
  count: number;
}

export interface PresenceState {
  top: PresenceTopItem[];
  hereCount: number | null;
  /** True once the server has confirmed our `r` for the current slug. */
  connected: boolean;
}

interface ServerMsg {
  t: "hi" | "top" | "here";
  items?: { s: string; ti: string; n: number }[];
  s?: string;
  n?: number;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function usePresence(
  slug: string | null
): PresenceState {
  const [top, setTop] = useState<PresenceTopItem[]>([]);
  const [hereCount, setHereCount] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const slugRef = useRef<string | null>(slug);
  const reconnectAttemptRef = useRef(0);

  // Keep refs in sync so the WS open handler always sends the *current* slug.
  slugRef.current = slug;

  // Open the WS once for the SPA's lifetime; reconnect on drop.
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | null = null;

    function sendCurrent() {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(
          JSON.stringify({
            t: "r",
            s: slugRef.current,
          })
        );
      } catch {
        /* ignore */
      }
    }

    function connect() {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${proto}//${location.host}/api/presence`);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        reconnectAttemptRef.current = 0;
        sendCurrent();
      });

      ws.addEventListener("message", (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === "top" && Array.isArray(msg.items)) {
          setTop(
            msg.items.map((it) => ({
              slug: it.s,
              title: it.ti || it.s,
              count: it.n,
            }))
          );
        } else if (msg.t === "here") {
          // Drop stale `here` updates for a slug we've already left.
          if (msg.s === slugRef.current) {
            setHereCount(msg.n ?? null);
            setConnected(true);
          }
        } else if (msg.t === "hi") {
          // Server acknowledges us; we're not "connected" for the slug yet
          // until we get a here echo, but we know the socket is live.
        }
      });

      ws.addEventListener("close", () => {
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        // Browsers fire close after error; let that handler reconnect.
      });
    }

    function scheduleReconnect() {
      if (cancelled) return;
      const attempt = ++reconnectAttemptRef.current;
      const exp = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** (attempt - 1)
      );
      const delay = exp + Math.random() * 1000;
      reconnectTimer = window.setTimeout(connect, delay);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws?.close();
      } catch {}
    };
  }, []);

  // Push an `r` whenever slug changes if the socket is already open.
  // Only reset hereCount when the SLUG actually changes — that signals a
  // different location, so the prior count no longer applies.
  const lastSentSlugRef = useRef<string | null>(slug);
  useEffect(() => {
    if (lastSentSlugRef.current !== slug) {
      setHereCount(null);
      lastSentSlugRef.current = slug;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ t: "r", s: slug }));
      } catch {
        /* ignore */
      }
    }
  }, [slug]);

  return { top, hereCount, connected };
}
