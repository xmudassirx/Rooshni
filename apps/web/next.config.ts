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
  experimental: {
    // Hotfix (1 Aug 2026, founder-ordered): Next's server-action transport
    // default (1MB) capped uploads BELOW the enforced 8MB attachment law
    // (0032 pre-flight + the upload door), so a 1.3MB guide PDF met a 413
    // before the law ever saw it. 10mb = small headroom over the 8MB app
    // ceiling, which remains the enforced law everywhere; the transport is
    // not a gate. Client-direct signed-URL upload is the recorded future
    // tightening when uploads outgrow mail-attachment size.
    serverActions: { bodySizeLimit: "10mb" },
  },
};

export default nextConfig;
