import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { loadEnv } from "./env";

/**
 * Applies packages/db/migrations/*.sql in filename order, once each.
 * Applied migrations are recorded in public.schema_migrations.
 * Files are immutable once applied — write a new migration, never edit an old one.
 */
async function main() {
  loadEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in (password percent-encoded)."
    );
    process.exit(1);
  }

  const sql = postgres(databaseUrl, {
    ssl: "require",
    max: 1,
    prepare: false,
    onnotice: () => {},
  });

  try {
    await sql`
      create table if not exists public.schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `;
    await sql`alter table public.schema_migrations enable row level security`;

    const applied = new Set(
      (await sql`select name from public.schema_migrations`).map((r) => r.name as string)
    );

    const migrationsDir = resolve(import.meta.dirname, "../migrations");
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ranAny = false;
    for (const file of files) {
      if (applied.has(file)) continue;
      ranAny = true;
      process.stdout.write(`Applying ${file} ... `);
      await sql.begin(async (tx) => {
        await tx.file(resolve(migrationsDir, file));
        await tx`insert into public.schema_migrations (name) values (${file})`;
      });
      console.log("done");
    }

    if (!ranAny) {
      console.log(`Nothing to apply — all ${files.length} migrations already in place.`);
    } else {
      console.log("Migrations applied cleanly.");
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("\nMigration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
