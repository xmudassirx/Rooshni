import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@rooshni/db", "@rooshni/config"],
};

export default nextConfig;
