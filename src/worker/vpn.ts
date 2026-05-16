/**
 * VPN / commercial-hosting denylist. Cloudflare populates `request.cf.asn`
 * and `request.cf.asOrganization` for free on every request, with zero
 * latency. We use the ASN to refuse LLM-spending paths (generation,
 * search-hallucination) for traffic originating from datacenter / VPN-
 * backbone ASNs that produce nearly all the spam.
 *
 * Cache hits and pure DB reads are still served — so a legitimate user
 * who happens to be on a VPN can still read existing articles. Only the
 * paths that cost money are blocked.
 *
 * The denylist is sourced from the community-maintained
 *   https://github.com/bountyyfi/bad-asn-list
 * and embedded at `bad-asns.ts`. To refresh:
 *
 *   curl -sS https://raw.githubusercontent.com/bountyyfi/bad-asn-list/refs/heads/main/all.txt \
 *     | awk '/^AS[0-9]+/{gsub("AS","",$1); print $1}' | sort -n | uniq \
 *     | awk 'BEGIN{print "export const BAD_ASNS: ReadonlySet<number> = new Set(["} {printf "  %s,\n", $1} END{print "]);"}' \
 *     > src/worker/bad-asns.ts
 *
 * (Re-add the header comment after regenerating.)
 */
import { BAD_ASNS } from "./bad-asns";

/** Return true if the request looks like it originates from a VPN /
 *  datacenter ASN we want to refuse LLM-spending operations for. */
export function isLikelyVpn(c: { req: { raw: Request } }): boolean {
  const cf = (c.req.raw as unknown as { cf?: { asn?: number; asOrganization?: string; country?: string } }).cf;
  if (!cf) return false;
  // Tor exits. Cloudflare assigns the pseudo-country code "T1" to any
  // request coming through the Tor network, regardless of which ASN the
  // exit happens to be on. This is more reliable than maintaining our
  // own exit-node list, since anyone can spin up a new Tor exit.
  if (cf.country === "T1") return true;
  if (typeof cf.asn === "number" && BAD_ASNS.has(cf.asn)) return true;
  // Secondary heuristic: organization name keywords. Catches the rare ASN
  // that isn't on the list. Conservative — only matches strings that
  // almost never appear in residential ISP names.
  const org = (cf.asOrganization || "").toLowerCase();
  if (!org) return false;
  if (org.includes("vpn")) return true;
  if (org.includes("hosting")) return true;
  if (org.includes("datacenter") || org.includes("data center")) return true;
  if (org.includes("colocation") || org.includes("colo ")) return true;
  return false;
}
