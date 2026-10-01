import base from "./base.js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";

export default [
  ...base,
  {
    plugins: { "@next/next": nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs["core-web-vitals"].rules },
    languageOptions: { globals: { ...globals.browser } },
  },
];
