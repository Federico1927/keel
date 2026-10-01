import next from "@keel/eslint-config/next";
export default [...next, { ignores: [".next/**", "next-env.d.ts", "playwright-report/**"] }];
