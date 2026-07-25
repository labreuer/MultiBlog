import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Playwright's own output.
    "playwright-report/**",
    "test-results/**",
  ]),
  {
    // Playwright signals "this fixture depends on nothing" with an empty
    // destructuring pattern — it parses the parameter to work out the
    // dependency graph, so there's no non-empty form to substitute.
    files: ["e2e/**/*.ts"],
    rules: {
      "no-empty-pattern": "off",
      // A Playwright fixture's second parameter is conventionally named `use`,
      // which the React plugin mistakes for React 19's `use` hook.
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
