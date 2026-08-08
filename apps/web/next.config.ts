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
  // Session 34 (D188d): the OAuth discovery documents live at their
  // RFC-mandated /.well-known paths; the handlers live under /api/oauth
  // (dot-directories in the app router are avoidable risk). The :path*
  // wildcard also serves the RFC 9728 path-inserted form
  // (/.well-known/oauth-protected-resource/api/mcp).
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/oauth/protected-resource-metadata",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/oauth/protected-resource-metadata",
      },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: "/api/oauth/authorization-server-metadata",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/oauth/authorization-server-metadata",
      },
    ];
  },
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
