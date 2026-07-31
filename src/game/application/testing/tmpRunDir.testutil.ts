import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// 与 sqlite 系测试（如 sqliteGameRepository.test.ts）相同的 tmp/ 策略的共享版：
// 每次运行独立目录 + 开跑前先清扫上一轮同前缀残留。上一轮进程已退出、句柄已
// 释放，此时删除必然安全；Windows 下 libsql 可能延迟释放句柄，本轮 afterAll
// 的清理只能尽力而为，残留目录留给下一轮开跑时清扫，不会单调增长。
// ---------------------------------------------------------------------------

const TMP_ROOT = resolve("tmp");

/** 先清扫 tmp/ 下上一轮同前缀残留，再创建并返回本次运行的独立目录。 */
export function prepareTmpRunDir(prefix: string): string {
  try {
    for (const entry of readdirSync(TMP_ROOT)) {
      if (entry.startsWith(prefix)) {
        try {
          rmSync(join(TMP_ROOT, entry), { recursive: true, force: true });
        } catch {
          /* 仍被占用（Windows 句柄延迟释放）：忽略，留给下一轮 */
        }
      }
    }
  } catch {
    /* tmp/ 尚不存在 */
  }
  const runDir = join(TMP_ROOT, `${prefix}${process.pid}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}
