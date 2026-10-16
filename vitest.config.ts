import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { NODE_ENV: "test" },
    // Integration tests share one MongoDB test database
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
