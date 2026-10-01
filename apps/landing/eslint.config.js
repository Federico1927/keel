import next from "@keel/eslint-config/next";
export default [
  ...next,
  {
    ignores: [".next/**", "out/**", "next-env.d.ts"],
    // Static export with two pages: plain anchors on purpose (no RSC prefetch requests on a static host).
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
];
