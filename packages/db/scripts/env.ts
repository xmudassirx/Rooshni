import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

/** Load .env.local (then .env) from the repo root without overriding real env. */
export function loadEnv(): void {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  for (const file of [".env.local", ".env"]) {
    const path = resolve(repoRoot, file);
    if (existsSync(path)) {
      config({ path, override: false });
    }
  }
}
