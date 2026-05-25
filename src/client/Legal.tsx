import { useEffect } from "react";
import { openConsentModal } from "./ConsentGate";

/* ============================================================ *
 *  Privacy Policy + Terms / AI Disclaimer
 *
 *  Two static React components rendered by App.tsx when the
 *  active slug is "privacy" or "terms". Both are reserved on
 *  the worker so they never get LLM-generated.
 *
 *  Contact: bartek@gace.dev
 *  Supervisory authority: UODO (Poland)
 * ============================================================ */

const LAST_UPDATED = "2026-05-25";
const CONTACT_EMAIL = "bartek@gace.dev";

export function Privacy() {
  useEffect(() => {
    document.title = "Privacy Policy — Halupedia";
  }, []);

  return (
    <article className="article legal-page">
      <h1>Privacy Policy</h1>
      <p className="legal-meta">
        Last updated: {LAST_UPDATED}. This is the real policy. Unlike the rest
        of Halupedia, the contents of this page are not fabricated.
      </p>

      <h2>1. Who we are</h2>
      <p>
        Halupedia (the &ldquo;Service&rdquo;) is operated by an individual
        based in Poland and reachable at{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. For purposes
        of the EU General Data Protection Regulation (GDPR), that individual
        is the data controller.
      </p>

      <h2>2. What we collect and why</h2>
      <p>
        We collect the minimum needed to run an encyclopedia of fabrications
        and to stop bots from running our LLM budget into the ground:
      </p>
      <ul>
        <li>
          <strong>IP address</strong> &mdash; used transiently for rate
          limiting, abuse detection, and bot scoring. Stored in Cloudflare KV
          and D1 only long enough for those checks (typically up to 24
          hours). Not used to identify you. Legal basis: legitimate interest
          (Art. 6(1)(f) GDPR) in protecting the Service from abuse.
        </li>
        <li>
          <strong>A first-party cookie, <code>hu_uid</code></strong> &mdash;
          set only after you post your first comment. It links you to a
          randomly-generated user record and an LLM-hallucinated display
          name. Lifetime: up to 400 days (RFC 6265bis cap), refreshed on
          activity. Legal basis: necessary to provide the comment feature
          you requested (Art. 6(1)(b) GDPR).
        </li>
        <li>
          <strong>Comment contents and votes</strong> &mdash; stored in
          Cloudflare D1, associated with the hallucinated identity above.
          Legal basis: necessary to provide the comment feature.
        </li>
        <li>
          <strong>Cloudflare Web Analytics</strong> &mdash; cookieless,
          privacy-preserving page-view counts. No personal data, no
          fingerprinting. Used always; no consent required under ePrivacy.
        </li>
        <li>
          <strong>Cloudflare Turnstile</strong> &mdash; a privacy-friendly
          captcha used to verify you are not a bot before generating a new
          article. Cloudflare processes a token and limited browser signals
          for that check. See{" "}
          <a
            href="https://www.cloudflare.com/privacypolicy/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Cloudflare&rsquo;s privacy policy
          </a>
          .
        </li>
        <li>
          <strong>Google Analytics 4</strong> (measurement ID{" "}
          <code>G-GGLD5TG5E9</code>) &mdash; loaded{" "}
          <em>only after you click &ldquo;Accept analytics&rdquo;</em> in our
          consent modal. Sets cookies (<code>_ga</code>,{" "}
          <code>_ga_*</code>) and sends your IP, page URL, referrer, and
          interaction events to Google. Legal basis: your consent (Art.
          6(1)(a) GDPR). You can withdraw consent at any time via the{" "}
          <button
            type="button"
            className="legal-inline-button"
            onClick={openConsentModal}
          >
            Cookie preferences
          </button>{" "}
          link.
        </li>
        <li>
          <strong>Article generation requests</strong> &mdash; when you visit
          a never-before-seen slug, the slug text is sent to OpenRouter,
          which forwards it to an upstream LLM provider. Cached articles do
          not trigger this round-trip. We do not send your IP or identity.
          OpenRouter and the upstream provider may retain prompts for abuse
          monitoring per their own policies.
        </li>
      </ul>

      <h2>3. What we do not collect</h2>
      <ul>
        <li>No accounts, no passwords, no email addresses.</li>
        <li>No advertising trackers, no cross-site fingerprinting.</li>
        <li>
          No profile of your reading history outside what Cloudflare and
          (optionally) Google Analytics record.
        </li>
      </ul>

      <h2>4. Cookies, in plain language</h2>
      <table className="legal-table">
        <thead>
          <tr>
            <th>Cookie</th>
            <th>Purpose</th>
            <th>Lifetime</th>
            <th>Consent</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>hu_uid</code></td>
            <td>Identifies you to the comment system after first post</td>
            <td>Up to 400 days</td>
            <td>Functional &mdash; set only after you choose to comment</td>
          </tr>
          <tr>
            <td><code>hu_consent</code></td>
            <td>Remembers your choice on the consent modal</td>
            <td>12 months</td>
            <td>Strictly necessary</td>
          </tr>
          <tr>
            <td><code>_ga</code>, <code>_ga_GGLD5TG5E9</code></td>
            <td>Google Analytics 4 measurement</td>
            <td>Up to 2 years</td>
            <td>Set only with your explicit consent</td>
          </tr>
          <tr>
            <td>Cloudflare cookies (<code>cf_*</code>)</td>
            <td>Security, bot mitigation, Turnstile challenge</td>
            <td>Session to 30 days</td>
            <td>Strictly necessary</td>
          </tr>
        </tbody>
      </table>

      <h2>5. Who else processes your data</h2>
      <p>The following sub-processors are involved in running Halupedia:</p>
      <ul>
        <li>
          <strong>Cloudflare, Inc.</strong> &mdash; hosting (Workers), edge
          cache (KV), database (D1), DNS, WAF, Turnstile, and cookieless
          analytics. Data may be processed in the EU and the United States
          under Cloudflare&rsquo;s Standard Contractual Clauses.
        </li>
        <li>
          <strong>Google Ireland Ltd. / Google LLC</strong> &mdash; Google
          Analytics 4, only when you have opted in.
        </li>
        <li>
          <strong>OpenRouter, Inc.</strong> &mdash; routes article-generation
          prompts to upstream LLM providers (model varies and is configured
          per deployment).
        </li>
      </ul>

      <h2>6. How long we keep things</h2>
      <ul>
        <li>
          <strong>Cached articles:</strong> indefinitely. They are the
          encyclopedia.
        </li>
        <li>
          <strong>Comments and votes:</strong> indefinitely, unless you ask
          us to delete a specific comment (see below).
        </li>
        <li>
          <strong>Rate-limit and abuse counters:</strong> rolling 1&ndash;24
          hour windows in KV, then automatically expired.
        </li>
        <li>
          <strong>Analytics data:</strong> retention per the respective
          provider (Cloudflare: ~6 months for raw, longer aggregated;
          Google: configurable, default 14 months).
        </li>
      </ul>

      <h2>7. Your rights under GDPR</h2>
      <p>You have the right to:</p>
      <ul>
        <li>Access the data we hold about you;</li>
        <li>Have it corrected or erased;</li>
        <li>Restrict or object to processing;</li>
        <li>Receive a copy in a portable format;</li>
        <li>Withdraw consent at any time (this does not affect prior processing);</li>
        <li>
          Lodge a complaint with the Polish supervisory authority &mdash;
          Prezes Urzędu Ochrony Danych Osobowych (UODO),{" "}
          <a
            href="https://uodo.gov.pl/"
            target="_blank"
            rel="noopener noreferrer"
          >
            uodo.gov.pl
          </a>
          .
        </li>
      </ul>
      <p>
        To exercise any of these, write to{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Because we
        do not hold an email address for you, please include any
        identifiers we&rsquo;d need to find your data &mdash; a comment URL,
        the hallucinated username displayed under your comment, or the
        value of your <code>hu_uid</code> cookie if you can find it.
      </p>

      <h2>8. International transfers</h2>
      <p>
        Cloudflare and Google may process data in the United States and
        other jurisdictions. Transfers rely on the EU Standard Contractual
        Clauses and, for the United States, the EU&ndash;US Data Privacy
        Framework where applicable.
      </p>

      <h2>9. Children</h2>
      <p>
        Halupedia is not directed at children under 16. We do not knowingly
        collect data from them. If you believe a child has submitted
        personal data, contact us and we will remove it.
      </p>

      <h2>10. Changes to this policy</h2>
      <p>
        We may update this policy. The &ldquo;last updated&rdquo; date at
        the top reflects the latest version. Material changes will be
        announced on the homepage.
      </p>

      <h2>11. Contact</h2>
      <p>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </article>
  );
}

export function Terms() {
  useEffect(() => {
    document.title = "Terms of Use — Halupedia";
  }, []);

  return (
    <article className="article legal-page">
      <h1>Terms of Use &amp; Content Disclaimer</h1>
      <p className="legal-meta">
        Last updated: {LAST_UPDATED}. By using Halupedia you agree to the
        below. If you do not, please leave.
      </p>

      <div className="legal-callout">
        <strong>Everything you read on Halupedia is fabricated.</strong>{" "}
        Articles are written on demand by a large language model that does
        not know what is true. Names, dates, biographies, quotations,
        institutions, and footnotes are invented. Do not cite Halupedia.
        Do not quote it. Do not treat any factual claim it makes as factual.
        Resemblance to any real person, place, work, or event is, where
        coincidental, coincidental; where deliberate, satirical.
      </div>

      <h2>1. What this Service is</h2>
      <p>
        Halupedia is an art piece in the form of a hallucinated encyclopedia.
        It generates plausible-sounding scholarly entries about topics that
        do not exist. It is provided free of charge, without warranty, for
        entertainment.
      </p>

      <h2>2. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>
          Attempt to extract personal data, secrets, or system prompts from
          the generator;
        </li>
        <li>Use the Service to harass, defame, or harm any real person;</li>
        <li>
          Submit slugs or comments designed to produce hate speech, slurs,
          sexual content involving minors, incitement to violence, or other
          unlawful content;
        </li>
        <li>
          Scrape, mirror, or hammer the article-generation endpoint in a way
          that bypasses the documented rate limits;
        </li>
        <li>
          Use automated means to generate articles or comments without
          permission (Cloudflare Bot Fight Mode and our own limiters will
          fight back);
        </li>
        <li>Submit content that infringes third-party rights.</li>
      </ul>

      <h2>3. User-generated content (comments)</h2>
      <p>
        You may post threaded comments without signing up. When you do, you
        grant Halupedia a non-exclusive, worldwide, royalty-free licence to
        display, store, and moderate that comment as part of the Service.
        You retain ownership of your text. We may remove comments at any
        time for any reason &mdash; in particular, content violating
        section&nbsp;2.
      </p>
      <p>
        Your displayed name (e.g. <em>Bartram Pellbrick-Thwaite</em>) is
        invented by an LLM. Any collision with a real person is unintended;
        contact us and we will rename or remove on request.
      </p>

      <h2>4. AI content disclaimer and liability</h2>
      <p>
        Articles are LLM output. They may be wrong, defamatory-adjacent,
        offensive, or absurd. We disclaim all warranties, express or
        implied, to the maximum extent permitted by law, including
        warranties of accuracy, fitness for purpose, and non-infringement.
      </p>
      <p>
        To the maximum extent permitted by law, we are not liable for any
        damages &mdash; direct, indirect, incidental, consequential, or
        otherwise &mdash; arising from your use of the Service or reliance
        on its content. Where mandatory consumer law (including Polish
        consumer protection law) grants you rights that cannot be excluded,
        nothing in these Terms limits those rights.
      </p>

      <h2>5. Removing content about real people</h2>
      <p>
        If Halupedia generates an article that names, defames, or
        misrepresents you or someone you represent, email{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with the URL
        and we will redact it from the cache and add the slug to the
        permanent block list, typically within a few days.
      </p>

      <h2>6. Intellectual property</h2>
      <p>
        The Halupedia source code is licensed under GPL-3.0 and lives at{" "}
        <a
          href="https://github.com/BaderBC/halupedia"
          target="_blank"
          rel="noopener noreferrer"
        >
          github.com/BaderBC/halupedia
        </a>
        . Generated articles have no claimed authorship; we make no
        copyright claim over LLM output and you should not either.
      </p>

      <h2>7. Changes and termination</h2>
      <p>
        We may modify the Service or these Terms at any time. We may also
        block or rate-limit any user or IP that abuses the Service. There
        is no SLA; the press may stop printing at any moment if the token
        budget runs out.
      </p>

      <h2>8. Governing law</h2>
      <p>
        These Terms are governed by Polish law. Any dispute that cannot be
        resolved amicably falls under the jurisdiction of the courts
        competent for the controller&rsquo;s place of residence, without
        prejudice to mandatory consumer protection rules that grant you
        the right to sue in your own country of residence.
      </p>

      <h2>9. Contact</h2>
      <p>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </article>
  );
}
