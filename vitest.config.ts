import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    exclude: [...configDefaults.exclude, ".foundation/**", ".worktrees/**", "artifacts/**", "scripts/**/*.node-test.mjs"],
    server: {
      deps: {
        // foundation 的 dist 及其 sibling 依赖（react）在 foundation 内
        // 无 node_modules，必须由 consumer 解析。inline 强制 Vite 处理这些依赖，
        // 使其经 resolve.alias 走 consumer 路径，避免从 sibling realpath 向上查找失败。
        inline: [/@ai-game\//]
      }
    }
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
      // `server-only` intentionally throws outside Next's server compiler.
      // Unit tests exercise server composition directly, so map only Vitest to
      // a no-op shim while keeping the production import intact.
      "server-only": path.resolve(__dirname, "./src/test-server-only.ts"),
      "@": path.resolve(__dirname, "./src")
    }
  }
});
