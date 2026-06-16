/**
 * Identity hallucinator. On a user's first comment we ask the same model that
 * writes the encyclopedia to invent a fictional commenter — a display name
 * (period-correct, slightly absurd) and a forum-style username. Names match
 * the Halupedia register: deadpan academics, retired bureaucrats,
 * obsessive amateurs, minor clergy, etc.
 */

const IDENTITY_SYSTEM = `You generate fictional Halupedia commenter identities. Output ONLY a single JSON object on one line, no prose, no code fences. Keys: "name" and "username".

- "name" is a plausible-but-faintly-absurd full name in the same register as the encyclopedia: minor scholars, retired municipal clerks, obsessive amateurs, defrocked clergy, rural taxonomists, Belgian phonologists, etc. 2 to 3 words, optional double-barrel surnames, no titles, no "Dr." prefixes. Latin / European / vaguely 19th-century flavor allowed but not required. No real famous people.
- "username" is a forum handle for the same person: lowercase ASCII, 3–24 chars, only letters/digits/underscore, no leading digit. Often a fragment of the surname plus a number or a hobbyist suffix (e.g. "pellbrick_archivist", "thwaite_1887", "minor_grommet", "vellum_77"). Must look like something a real obsessive would pick.

Return exactly one JSON object. Do not number them. Do not add commentary.`;

export interface Identity {
  name: string;
  username: string;
}

export async function hallucinateIdentity(
  apiKey: string,
  apiUrl: string | undefined,
  model: string
): Promise<Identity> {
  const body = {
    model,
    temperature: 1.4,
    top_p: 0.95,
    max_tokens: 80,
    messages: [
      { role: "system", content: IDENTITY_SYSTEM },
      { role: "user", content: "Generate one identity." },
    ],
  };

  const res = await fetch(chatCompletionsUrl(apiUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://halupedia.com",
      "X-Title": "Halupedia",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`identity gen ${res.status}`);
  const json: any = await res.json();
  const raw: string = json?.choices?.[0]?.message?.content ?? "";
  return parseIdentity(raw);
}

function chatCompletionsUrl(apiUrl: string | undefined): string {
  const trimmed = apiUrl?.trim();
  return trimmed && trimmed.length > 0
    ? trimmed
    : "https://openrouter.ai/api/v1/chat/completions";
}

export function parseIdentity(raw: string): Identity {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  // Find first {...} block in case the model added stray text.
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("identity: no JSON object in response");
  const obj = JSON.parse(m[0]);

  const name = sanitizeName(obj.name);
  const username = sanitizeUsername(obj.username);

  if (!name || !username) throw new Error("identity: empty fields");
  return { name, username };
}

function sanitizeName(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/[<>"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function sanitizeUsername(s: unknown): string {
  if (typeof s !== "string") return "";
  const u = s
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+/, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 24);
  return u.length >= 3 ? u : "";
}

/**
 * Last-ditch fallback when the model fails or the username collides.
 * Still in keeping with the aesthetic — vaguely scholarly nonsense.
 */
const FALLBACK_FIRST = [
  "Ezra", "Hilde", "Bartram", "Cordelia", "Mortimer", "Phlegm", "Ottoline",
  "Ignatius", "Bramwell", "Magdalene", "Gosling", "Verity", "Thaddeus",
  "Pelagia", "Quentin", "Drusilla", "Cassian", "Wenceslas",
];
const FALLBACK_LAST = [
  "Pellbrick", "Thwaite", "Vellum", "Grommet", "Aspic", "Brundle",
  "Fenwick", "Gallowsby", "Hempenstall", "Lichgate", "Mopswell",
  "Quill", "Rensselaer", "Stillwater", "Underclough", "Weems",
];

export function fallbackIdentity(uniqueSuffix: string): Identity {
  const f = FALLBACK_FIRST[Math.floor(Math.random() * FALLBACK_FIRST.length)];
  const l = FALLBACK_LAST[Math.floor(Math.random() * FALLBACK_LAST.length)];
  const suffix = uniqueSuffix.replace(/[^a-z0-9]/gi, "").slice(-4).toLowerCase();
  return {
    name: `${f} ${l}`,
    username: `${l.toLowerCase()}_${suffix || "anon"}`,
  };
}
