import { defineConfig } from "vitest/config"

// Unit tests run on plain node and only touch test/**; the gui() vite plugin
// (jsdom, bundling) must not take part.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
})
