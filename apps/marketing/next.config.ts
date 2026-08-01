import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import type { NextConfig } from "next";

// Local dev reads the repo-root .env.local (same file the db scripts load);
// on Vercel the variables come from the project settings and no file exists.
for (const file of [".env.local", ".env"]) {
  const path = resolve(__dirname, "../..", file);
  if (existsSync(path)) {
    config({ path, override: false });
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ["@rooshni/db", "@rooshni/config"],
};

export default nextConfig;
