import { lstatSync, realpathSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { assertFoundationRoot, projectRoot } from "./foundationLocator.mjs";

const target = realpathSync(assertFoundationRoot());
const link = resolve(projectRoot, ".foundation");

try {
  const current = realpathSync(link);
  if (current !== target) {
    throw new Error(`.foundation 已指向 ${current}，期望 ${target}；请人工移除旧链接后重试。`);
  }
  console.log(`foundation 链接已就绪：${link} -> ${target}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  try {
    lstatSync(link);
    throw new Error(`.foundation 是无法解析的旧链接：${link}；请人工移除后重试。`);
  } catch (statError) {
    if (statError?.code !== "ENOENT") throw statError;
  }
  symlinkSync(target, link, "junction");
  console.log(`已建立 foundation 链接：${link} -> ${target}`);
}
