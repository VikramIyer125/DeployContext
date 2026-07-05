import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fake-product is its own repo with its own suite; don't run it from here
    include: ["test/**/*.test.ts"],
  },
});
