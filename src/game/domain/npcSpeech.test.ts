import { describe, expect, it } from "vitest";
import {
  composeDirectNpcGreeting,
  isGenericNpcAcknowledgement,
  normalizeNpcSpeech,
} from "./npcSpeech";

describe("NPC direct speech", () => {
  it("removes a named speaker and descriptive speech wrapper", () => {
    expect(normalizeNpcSpeech('邵叔如实答道："我知道了。"', "邵叔")).toBe("我知道了。");
    expect(normalizeNpcSpeech("邵叔低声说道：“这件事我会查清楚。”", "邵叔")).toBe("这件事我会查清楚。");
    expect(normalizeNpcSpeech("邵叔如实答道：我知道了。", "邵叔")).toBe("我知道了。");
    expect(normalizeNpcSpeech("邵叔如实答道，我知道了。", "邵叔")).toBe("我知道了。");
  });

  it("keeps direct speech and normal colon content intact", () => {
    expect(normalizeNpcSpeech("“你问得正是时候。”", "邵叔")).toBe("你问得正是时候。");
    expect(normalizeNpcSpeech("韩征点了点头：「有什么事直接找我。」", "韩征")).toBe("有什么事直接找我。");
    expect(normalizeNpcSpeech("关于商队失踪的事：我还不能确定。", "邵叔")).toBe("关于商队失踪的事：我还不能确定。");
    expect(normalizeNpcSpeech("邵叔看了你一眼，继续巡视。", "邵叔")).toBe("");
  });

  it("recognizes context-free acknowledgements", () => {
    expect(isGenericNpcAcknowledgement('"我知道了。"')).toBe(true);
    expect(isGenericNpcAcknowledgement("关于商队失踪的事，我先说我确定的部分。")).toBe(false);
  });

  it("provides a direct greeting without a speaker description", () => {
    expect(composeDirectNpcGreeting()).toBe("欢迎光临，有什么需要我帮忙的吗？");
    expect(normalizeNpcSpeech("欢迎光临，有什么需要我帮忙的吗？")).toBe("欢迎光临，有什么需要我帮忙的吗？");
  });
});
