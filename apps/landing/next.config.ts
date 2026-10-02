import type { NextConfig } from "next";

/**
 * Static export: the landing is plain HTML + assets, deployable on Vercel (root directory
 * `apps/landing`) or any static host. Images are pre-optimised to WebP by `scripts/optimize-images.mjs`,
 * so the Next image optimiser is disabled.
 */
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  transpilePackages: ["@keel/config", "@keel/ui"],
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
