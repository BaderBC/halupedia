/**
 * Deterministic abuse floor for cases that should not depend on model
 * judgment. The LLM moderation prompt handles nuance; this catches obvious
 * slurs, protected-class hate, genocidal/Nazi promotion, and sexual-minor
 * abuse even when the configured provider is too permissive.
 */

const DIRECT_SLURS = [
  "nigger",
  "nigga",
  "kike",
  "faggot",
  "fag",
  "tranny",
  "chink",
  "gook",
  "spic",
  "wetback",
  "coon",
  "raghead",
  "towelhead",
  "sandnigger",
  "zipperhead",
  "retard",
  "mongoloid",
];

const PROTECTED_GROUPS = [
  "jew",
  "jews",
  "jewish",
  "muslim",
  "muslims",
  "islam",
  "islamic",
  "islamist",
  "islamists",
  "christian",
  "christians",
  "black",
  "blacks",
  "asian",
  "asians",
  "arab",
  "arabs",
  "mexican",
  "mexicans",
  "immigrant",
  "immigrants",
  "gay",
  "gays",
  "lesbian",
  "lesbians",
  "trans",
  "transgender",
  "women",
  "woman",
  "disabled",
];

const HATE_ACTIONS = [
  "kill",
  "murder",
  "rape",
  "hang",
  "lynch",
  "gas",
  "exterminate",
  "eradicate",
  "enslave",
  "sterilize",
  "castrate",
  "deport",
  "banish",
];

const HATE_DESCRIPTORS = [
  "vermin",
  "rats",
  "parasites",
  "cockroaches",
  "subhuman",
  "animals",
  "rapists",
  "pedophiles",
  "terrorists",
  "disease",
  "plague",
  "filth",
  "scum",
  "degenerate",
  "degenerates",
  "inferior",
];

const PROFANE_TARGETING = [
  "fuck",
  "suck",
  "sucks",
  "hate",
  "destroy",
];

const SEXUAL_MINOR_PATTERNS = [
  /(?:^|-)child(?:ren)?-(?:porn|sex|rape|rapist|molest|abuse)(?:-|$)/,
  /(?:^|-)(?:porn|sex|rape|molest|abuse)-child(?:ren)?(?:-|$)/,
  /(?:^|-)minor(?:s)?-(?:porn|sex|rape|molest|abuse)(?:-|$)/,
  /(?:^|-)(?:cp|loli|lolicon)(?:-|$)/,
];

const GENOCIDE_PATTERNS = [
  /(?:^|-)heil-hitler(?:-|$)/,
  /(?:^|-)white-power(?:-|$)/,
  /(?:^|-)white-supremacy(?:-|$)/,
  /(?:^|-)aryan-(?:race|nation|supremacy)(?:-|$)/,
  /(?:^|-)gas-the-[a-z0-9-]+/,
  /(?:^|-)holocaust-(?:hoax|fake|denial)(?:-|$)/,
  /(?:^|-)hitler-did-nothing-wrong(?:-|$)/,
  /(?:^|-)(?:kill|exterminate|eradicate|gas)-all-[a-z0-9-]+/,
];

export function containsDeterministicDisallowedAbuse(text: string): boolean {
  const normalized = normalizeForAbuseScan(text);
  if (!normalized) return false;

  for (const term of DIRECT_SLURS) {
    if (hasToken(normalized, term)) return true;
  }

  for (const pattern of SEXUAL_MINOR_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  for (const pattern of GENOCIDE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  const targetsProtectedGroup = PROTECTED_GROUPS.some((term) =>
    hasToken(normalized, term)
  );
  if (!targetsProtectedGroup) return false;

  return (
    HATE_ACTIONS.some((term) => hasToken(normalized, term)) ||
    HATE_DESCRIPTORS.some((term) => hasToken(normalized, term)) ||
    PROFANE_TARGETING.some((term) => hasToken(normalized, term))
  );
}

function normalizeForAbuseScan(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function hasToken(normalized: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|-)${escaped}(?:s|es)?(?:-|$)`).test(normalized);
}
