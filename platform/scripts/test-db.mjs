/* Applies the migrations to a throwaway local Postgres (with Supabase auth/storage stubs) and runs supabase/tests/rls_test.sql. */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)), dir = root + "supabase/migrations", sp = root + "supabase/tests/", data = root + "node_modules/.tmp/pgdata";
rmSync(data, { recursive: true, force: true });
const db = new EmbeddedPostgres({ databaseDir: data, user: "postgres", password: "pw", port: 54329, persistent: false });
await db.initialise(); await db.start();
const c = new pg.Client({ host: "localhost", port: 54329, user: "postgres", password: "pw", database: "postgres" });
await c.connect();
let fail = 0;
try {
  await c.query(readFileSync(sp + "00_supabase_stubs.sql", "utf8"));
  for (const f of readdirSync(dir).sort()) { await c.query(readFileSync(dir + "/" + f, "utf8")); console.log("applied", f); }
  await c.query(readFileSync(sp + "rls_test.sql", "utf8"));
  const r = await c.query("select * from t_results order by id");
  for (const x of r.rows) { console.log(x.ok ? "PASS" : "FAIL", x.name, x.ok ? "" : x.detail); if (!x.ok) fail++; }
} catch (e) { console.error("ERROR", e.message, e.where || ""); fail++; }
await c.end(); await db.stop();
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
