import { containsDeterministicDisallowedAbuse } from "./abuse";

/**
 * Permanent slug-pattern blocklist. Slugs matching any rule below are
 * refused before generation, before cache lookup, before anything. They
 * never get an article, never get a moderation row, never get logged
 * anywhere persistent — they just 404. Used for harassment / impersonation
 * patterns that the moderation sweep wouldn't reliably catch on title
 * alone.
 *
 * Slugs are already lowercase ASCII by the time they reach this check
 * (slugify normalizes them), so substring/prefix matching is naturally
 * case-insensitive.
 */
export function isPermanentlyBlockedSlug(slug: string): boolean {
  slug = slug.toLowerCase();
  if (containsDeterministicDisallowedAbuse(slug)) return true;
  if (slug.startsWith("0-0")) return true;
  if (slug.includes("0-0-0")) return true;
  if (slug.includes("strama")) return true;
  if (slug.includes("cwel")) return true;
  return false;
}
