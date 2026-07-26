import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { NextConfig } from "next";

const projectRoot = realpathSync(process.cwd());
const foundationLink = resolve(projectRoot, ".foundation");
const foundationRoot = existsSync(foundationLink) ? realpathSync(foundationLink) : projectRoot;
const workspaceRoot = commonAncestor(projectRoot, foundationRoot);

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-game/ui"],
  outputFileTracingRoot: workspaceRoot,
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;

function commonAncestor(left: string, right: string) {
  if (parse(left).root.toLowerCase() !== parse(right).root.toLowerCase()) {
    throw new Error(`项目与 foundation 必须位于同一文件系统：${left} / ${right}`);
  }

  let current = left;
  const root = parse(current).root;
  while (current !== root) {
    const relativePath = relative(current, right);
    if (
      relativePath === "" ||
      (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
    ) {
      return current;
    }
    current = dirname(current);
  }
  return current;
}
