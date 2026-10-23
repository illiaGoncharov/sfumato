# Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. **Authentication → Providers → Anonymous sign-ins**: enable.
3. **SQL Editor**: run [`schema.sql`](schema.sql).
4. Copy `config.example.js` → `config.js` in repo root; paste **Project URL** and **anon public** key.
5. Deploy: commit `config.js` only if you accept public anon key (RLS protects rows). Prefer GitHub Actions secret + build step later; for now local `config.js` is gitignored.

Optional: **Authentication → Email** magic link to link anonymous users to email for cross-device sync (`linkEmail` in app).
