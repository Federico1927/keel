import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@keel/ui", "@keel/config", "@keel/core", "@keel/db", "@keel/integrations", "@keel/services"],
  serverExternalPackages: ["pg", "pg-boss", "bcryptjs"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  /** MCP OAuth discovery (#21): RFC 8414 / RFC 9728 well-known documents, in the root and path-suffixed forms clients try. */
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/metadata" },
        { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/oauth/metadata" },
        { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/protected-resource" },
        { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth/protected-resource" },
      ],
    };
  },
};

export default withNextIntl(nextConfig);
