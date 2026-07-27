import { loadScenarioProfiles, type ScenarioProfiles } from "@/game/gameplay/rpg/scenario";
import { projectOpeningGameView, type OpeningGameView } from "./openingGameView";
import type { CorruptGameReason, GameRepository } from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// getCurrentGame use case（Task 1 契约）：恢复当前本地存档的 read model。
// CurrentGameResult 恰有三种状态：none / active / corrupt。
// 基础设施失败对玩家同样是「当前存档暂不可用」：归入 corrupt 并以稳定
// reason 区分，绝不向上抛异常文本，也不返回 blueprint/state 原始记录。
// ---------------------------------------------------------------------------

export type GetCurrentGameDependencies = {
  readonly repository: GameRepository;
  /** 场景 profile 配置：缺省加载内置 data/base 配置，测试可注入变体。 */
  readonly profiles?: ScenarioProfiles;
};

/** corrupt 的稳定可显示原因：repository 的损坏原因 + 基础设施失败。 */
export type CurrentGameUnavailableReason = CorruptGameReason | "INFRASTRUCTURE_FAILURE";

export type CurrentGameResult =
  | { readonly status: "none" }
  | { readonly status: "active"; readonly view: OpeningGameView }
  | { readonly status: "corrupt"; readonly reason: CurrentGameUnavailableReason };

export async function getCurrentGame(
  deps: GetCurrentGameDependencies
): Promise<CurrentGameResult> {
  const loaded = await deps.repository.getCurrentGame();
  if (!loaded.ok) {
    return { status: "corrupt", reason: loaded.code };
  }
  if (loaded.status === "none") {
    return { status: "none" };
  }
  if (loaded.status === "corrupt") {
    return { status: "corrupt", reason: loaded.reason };
  }

  const profiles = deps.profiles ?? loadScenarioProfiles();
  const { record } = loaded;
  try {
    return {
      status: "active",
      view: projectOpeningGameView({
        gameId: record.gameId,
        blueprint: record.blueprint,
        state: record.state,
        worldName: profiles.gameTypeProfiles[record.blueprint.gameType].label
      })
    };
  } catch {
    // 投影抛错意味着记录内部引用被改坏（如悬挂的 currentLocationId）：
    // 这是永久性数据损坏，归入 corrupt，绝不伪装成暂时性基础设施故障。
    return { status: "corrupt", reason: "UNPARSEABLE_RECORD" };
  }
}
