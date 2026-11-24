import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The framework packages test against the SDK source, so no build of @protogrid/sdk is needed first.
  resolve: { alias: { "@protogrid/sdk": fileURLToPath(new URL("./typescript/src/index.ts", import.meta.url)) } },
  test: {
    include: [
      "typescript/src/**/*.test.ts",
      "cli/src/**/*.test.ts",
      "ai-sdk/src/**/*.test.ts",
      "mastra/src/**/*.test.ts",
      "langchain-js/src/**/*.test.ts",
      "n8n/test/**/*.test.ts",
    ],
    environment: "node",
  },
});
