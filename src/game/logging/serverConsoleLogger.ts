import "server-only";
import { createGameLogger } from "./gameLogger";
import type { GameLogger } from "./logTypes";

/** Server composition's default sink. This is the only production console boundary. */
export function createServerConsoleLogger(): GameLogger {
  return createGameLogger({
    write(entry) {
      const line = JSON.stringify(entry);
      if (entry.level === "error") console.error(line);
      else if (entry.level === "warn") console.warn(line);
      else console.log(line);
    }
  });
}
