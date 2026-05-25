import { useCallback, useEffect, useState } from "react";

/* ============================================================ *
 *  Consent Gate
 *
 *  First-visit modal that:
 *   1. Surfaces the AI/fabrication disclaimer (acknowledgement
 *      is required to use the Service).
 *   2. Offers a real, equally-weighted choice on Google
 *      Analytics opt-in (so the consent is valid under GDPR /
 *      Polish UODO guidance; pre-ticked or hidden-reject
 *      buttons are dark patterns and not valid consent).
 *
 *  Stores the decision in localStorage under `hu_consent`. The
 *  user can re-open the modal at any time via `openConsentModal()`
 *  (wired to the footer "Cookie preferences" link).
 * ============================================================ */

const CONSENT_KEY = "hu_consent";
const CONSENT_VERSION = 1;
const GA_MEASUREMENT_ID = "G-GGLD5TG5E9";

type ConsentChoice = "accepted" | "rejected";

interface StoredConsent {
  v: number;
  choice: ConsentChoice;
  ts: number;
}

function readConsent(): StoredConsent | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConsent;
    if (parsed.v !== CONSENT_VERSION) return null;
    if (parsed.choice !== "accepted" && parsed.choice !== "rejected") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeConsent(choice: ConsentChoice) {
  try {
    const stored: StoredConsent = { v: CONSENT_VERSION, choice, ts: Date.now() };
    localStorage.setItem(CONSENT_KEY, JSON.stringify(stored));
  } catch {
    /* private mode / quota — modal will reappear next visit, that's fine */
  }
}

/** Dispatch a window event so any open ConsentGate instance re-checks state. */
const REOPEN_EVENT = "halupedia:open-consent";

/** Public helper for the footer link. Re-opens the modal. */
export function openConsentModal() {
  window.dispatchEvent(new CustomEvent(REOPEN_EVENT));
}

interface ConsentGateProps {
  /** When true, the modal is suppressed on this view even if no consent has
   *  been recorded yet. Used for /privacy and /terms — users must be able to
   *  read the policy BEFORE consenting; gating those pages behind the modal
   *  (which itself links to them) would be a GDPR catch-22. No tracking
   *  happens while suppressed because GA only loads after explicit accept. */
  suppressed?: boolean;
}

/* ---------------- Google Analytics loader (gated) ---------------- */

let gaLoaded = false;

function loadGoogleAnalytics() {
  if (gaLoaded) return;
  gaLoaded = true;

  const w = window as any;
  w.dataLayer = w.dataLayer || [];
  function gtag(..._args: any[]) {
    // gtag is intentionally implemented as a thin wrapper that pushes its
    // arguments onto dataLayer — that's the public API Google documents.
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer.push(arguments);
  }
  w.gtag = gtag;

  gtag("js", new Date());
  gtag("config", GA_MEASUREMENT_ID, { anonymize_ip: true });

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(s);
}

/* ---------------- Component ---------------- */

export function ConsentGate({ suppressed = false }: ConsentGateProps = {}) {
  // null = haven't read yet (SSR/hydration safety); "open" = show modal.
  const [state, setState] = useState<StoredConsent | "open" | null>(null);

  // Read stored consent on mount, and react to footer "Cookie preferences"
  // clicks that re-open the modal.
  useEffect(() => {
    const stored = readConsent();
    if (stored) {
      setState(stored);
      if (stored.choice === "accepted") loadGoogleAnalytics();
    } else {
      setState("open");
    }

    const onReopen = () => setState("open");
    window.addEventListener(REOPEN_EVENT, onReopen);
    return () => window.removeEventListener(REOPEN_EVENT, onReopen);
  }, []);

  // Body scroll lock while the modal is open. Skipped while suppressed so
  // the legal pages remain scrollable.
  useEffect(() => {
    if (state === "open" && !suppressed) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [state, suppressed]);

  const accept = useCallback(() => {
    writeConsent("accepted");
    loadGoogleAnalytics();
    setState({ v: CONSENT_VERSION, choice: "accepted", ts: Date.now() });
  }, []);

  const reject = useCallback(() => {
    writeConsent("rejected");
    // Note: we do NOT unload an already-loaded gtag script. If the user
    // previously accepted in this tab and now rejects, the page will reload
    // on next navigation; for an immediate effect we reload here.
    if (gaLoaded) {
      // Clear any GA cookies we can reach. _ga and _ga_* are first-party
      // on the same registrable domain, so document.cookie works for them.
      const expire = "expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
      const host = window.location.hostname;
      const root = host.split(".").slice(-2).join(".");
      document.cookie.split(";").forEach((c) => {
        const name = c.split("=")[0].trim();
        if (name === "_ga" || name.startsWith("_ga_")) {
          document.cookie = `${name}=; ${expire}; domain=${host}`;
          document.cookie = `${name}=; ${expire}; domain=.${root}`;
          document.cookie = `${name}=; ${expire}`;
        }
      });
      // Easiest way to guarantee gtag stops sending events.
      window.location.reload();
      return;
    }
    setState({ v: CONSENT_VERSION, choice: "rejected", ts: Date.now() });
  }, []);

  if (state !== "open") return null;
  // Suppressed on /privacy and /terms — let the user read the policy first.
  // The modal will appear automatically when they navigate to any other page.
  if (suppressed) return null;

  return (
    <div
      className="hp-consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hp-consent-title"
      aria-describedby="hp-consent-body"
    >
      <div className="hp-consent-card">
        <h2 id="hp-consent-title" className="hp-consent-title">
          Welcome to Halupedia
        </h2>

        <div id="hp-consent-body" className="hp-consent-body">
          <p className="hp-consent-disclaimer">
            <strong>Every article here is fabricated by a language model.</strong>{" "}
            Biographies, dates, footnotes, and quotations are invented. Nothing
            on this site is true. Do not cite Halupedia, do not quote it, and do
            not believe it. By continuing you acknowledge this and accept our{" "}
            <a href="/terms">Terms</a>.
          </p>

          <p className="hp-consent-cookies">
            We use Cloudflare for hosting and cookieless analytics either way.
            We&rsquo;d also like to use <strong>Google Analytics</strong> to
            understand which entries people actually read &mdash; this sets
            cookies and shares page-view data with Google. It&rsquo;s entirely
            optional. See our <a href="/privacy">Privacy Policy</a> for the full
            list.
          </p>
        </div>

        <div className="hp-consent-actions">
          <button
            type="button"
            className="hp-consent-btn hp-consent-btn-primary"
            onClick={accept}
            autoFocus
          >
            Accept analytics
          </button>
          <button
            type="button"
            className="hp-consent-btn hp-consent-btn-secondary"
            onClick={reject}
          >
            Reject analytics
          </button>
        </div>

        <p className="hp-consent-footnote">
          You can change this any time via &ldquo;Cookie preferences&rdquo; in
          the footer.
        </p>
      </div>
    </div>
  );
}
