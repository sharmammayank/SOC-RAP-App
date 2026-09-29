import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "supabase/functions"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.worker } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-proto": "error",
      "no-extend-native": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-syntax": [
        "error",
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Render text, never HTML." },
        { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]", message: "Use textContent." },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: "Use DOM APIs." },
      ],
    },
  },
);
