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
    // Vendored pdfjs runtime assets (scripts/copy-pdfjs-assets.ts, PLAN.md
    // §19). Gitignored build output copied verbatim from a pinned dependency,
    // and its wasm fallbacks are minified JS — linting them reports ~160
    // problems in code that is not ours and that we must not edit.
    "public/pdfjs/**",
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
  {
    // docs/TIPTAP.md "Inline code takes other marks": StarterKit and Code come
    // from src/lib/tiptap-schema.ts, whose code mark lets code carry other
    // marks. A surface built from either package would refuse them there and
    // nowhere else, and nothing else would notice.
    ignores: ["src/lib/tiptap-schema.ts", "src/lib/tiptap-schema.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@tiptap/starter-kit", "@tiptap/extension-code"].map((name) => ({
            name,
            message: "Import StarterKit or Code from @/lib/tiptap-schema, whose code mark lets code carry other marks (docs/TIPTAP.md).",
          })),
        },
      ],
    },
  },
]);

export default eslintConfig;
