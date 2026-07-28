import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    exclude: [...configDefaults.exclude, ".foundation/**", "scripts/**/*.node-test.mjs"]
  },
  resolve: {
    // @ai-game/ui 是 file: 依赖。保留 consumer 的 symlink 路径，才能由 consumer
    // 的 node_modules 解析其 React peer dependency；foundation 不携带 node_modules。
    preserveSymlinks: true,
    alias: {
      // Vitest 仍会真实解析 package 内的 bare React import；显式固定到 consumer
      // 的 peer dependency，避免从 sibling foundation 目录向上查找 node_modules。
      "react/jsx-runtime": path.resolve(__dirname, "./node_modules/react/jsx-runtime.js"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "./node_modules/react/jsx-dev-runtime.js"),
      react: path.resolve(__dirname, "./node_modules/react"),
      "@": path.resolve(__dirname, "./src")
    }
  }
});
