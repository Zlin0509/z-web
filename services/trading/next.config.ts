import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep existing article URLs and avoid redirects on JSON mutation endpoints.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
