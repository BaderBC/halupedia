-- Admin accounts for the /admin panel. Single privileged operation today
-- (slug bans) — see src/worker/admin.ts.
--
-- Rows are inserted manually. The application never registers new admins
-- via any HTTP route, so there is intentionally no INSERT path in code.
--
-- `password_sha512` is the lowercase-hex SHA-512 of the raw password
-- (128 chars). No salt — these accounts are operator-managed, the password
-- space is large, and the table is never exposed. Generate locally with:
--
--   printf '%s' 'your-password' | shasum -a 512 | awk '{print $1}'
--
-- Then insert:
--
--   pnpm wrangler d1 execute hallupedia --remote --command \
--     "INSERT INTO admins (username, password_sha512, created_at) \
--      VALUES ('bstrama', '<128-hex>', unixepoch('now') * 1000);"
--
-- Brute-force protection is enforced per-IP in the worker (failed login
-- attempts increment a KV-backed rate-limit bucket).

CREATE TABLE IF NOT EXISTS admins (
  username          TEXT PRIMARY KEY,
  password_sha512   TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
