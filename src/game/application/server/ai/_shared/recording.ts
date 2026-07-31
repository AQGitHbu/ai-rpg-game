// ---------------------------------------------------------------------------
// AI source 共享基础设施：录制 sink 与顺序回放游标。
// 三条 AI 管线的 fixture 回放都遵循同一骨架——按 sequence 顺序消费录制条目，
// 逐条比对契约版本 / fixtureVersion / 请求指纹，任一不符即"loud fail"，并在
// 收尾时断言所有条目都被消费。各管线的条目形状与成功/失败返回体不同，故仅把
// 通用的游标推进 + drift 判定抽到这里；具体的 typed source 与 DriftError 子类
// 仍留在各管线文件中（drift 回调注入以保持 instanceof 契约不变）。
// ---------------------------------------------------------------------------

/** 录制汇聚点：把每次尝试追加到 fixture（可同步或异步）。 */
export type RecordSink<Call> = {
  append(call: Call): void | Promise<void>;
};

export type ReplayCursor<Call> = {
  /**
   * 取当前录制条目并前进一格。当没有更多条目、sequence 不连续，或 matches
   * 返回 false（契约/指纹漂移）时调用注入的 drift()（约定 drift 抛出并不返回）。
   */
  consume(matches: (call: Call) => boolean): Call;
  /** 校验所有录制条目都已被消费，否则 drift()。 */
  assertComplete(): void;
};

/** 顺序游标：calls 必须自带连续的 sequence（0,1,2,…）。drift 由调用方注入。 */
export function createReplayCursor<Call extends { sequence: number }>(
  calls: readonly Call[],
  drift: () => never
): ReplayCursor<Call> {
  let cursor = 0;
  return {
    consume(matches) {
      const call = calls[cursor];
      if (call === undefined || call.sequence !== cursor || !matches(call)) {
        drift();
      }
      cursor += 1;
      return call;
    },
    assertComplete() {
      if (cursor !== calls.length) drift();
    }
  };
}
