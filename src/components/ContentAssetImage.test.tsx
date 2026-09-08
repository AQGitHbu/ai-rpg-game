import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ImageProps } from "next/image";
import type { ContentAssetBindingView, ContentAssetImageView } from "@/game/application";
import { ContentAssetImage } from "./ContentAssetImage";

// 仅隔离 Next 的解码/优化实现，测试实际 load/error 事件与框架行为。
vi.mock("next/image", () => ({ default: ({ src, alt, onError, onLoad, style, sizes }: ImageProps) =>
  createElement("img", { src: typeof src === "string" ? src : "", alt, onError, onLoad, style, sizes }),
}));
const query = { kind: "npc_portrait", gameType: "wuxia", variant: "neutral" } as const;
const picture: ContentAssetImageView = { assetId: "npc-a", version: "1", src: "/assets/generated/a-v1.webp", width: 768, height: 1024, source: "generated" };
const base = { ...query, bindingKey: "opaque-a", requestKey: "r1" };
const ready: ContentAssetBindingView = { ...base, status: "ready", image: picture };
const props = { query, presentationKey: "scope-a:npc-a:entry", sizes: "200px", fit: "contain" as const, label: "沈掌柜", fallback: <span data-testid="fallback">沈</span> };

describe("ContentAssetImage", () => {
  it("uses one accessible frame, loads then exhausts images without losing the fallback", () => {
    const { container } = render(<ContentAssetImage {...props} binding={ready} />);
    expect(screen.getAllByRole("img", { name: "沈掌柜" })).toHaveLength(1);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveStyle({ visibility: "hidden" });
    fireEvent.load(img);
    expect(img).toHaveStyle({ visibility: "visible" });
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("fallback").parentElement).toHaveStyle({ visibility: "visible" });
  });
  it("defers generating to ready until a new presentation, then resets failed URLs", () => {
    const { container, rerender } = render(<ContentAssetImage {...props} binding={{ ...base, status: "generating" }} />);
    rerender(<ContentAssetImage {...props} binding={ready} />);
    expect(container.querySelector("img")).toBeNull();
    rerender(<ContentAssetImage {...props} binding={ready} presentationKey="entry-2" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    rerender(<ContentAssetImage {...props} binding={ready} presentationKey="entry-3" />);
    expect(container.querySelector("img")).toHaveAttribute("src", picture.src);
  });
  it("tries the previous image once after current fails and hides decorative semantics", () => {
    const previous = { ...picture, assetId: "old", src: "/assets/generated/a-old.webp" };
    const { container } = render(<ContentAssetImage query={query} presentationKey="a" sizes="200px" fit="contain"
      decorative fallback={<span>占位</span>} binding={{ ...ready, previous }} />);
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toHaveAttribute("src", previous.src);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
  });
  it("keeps a new version buffered but changes immediately at a different entity/scope boundary", () => {
    const next: ContentAssetBindingView = { ...ready, requestKey: "r2", image: { ...picture, version: "2", src: "/assets/generated/a-v2.webp" } };
    const { container, rerender } = render(<ContentAssetImage {...props} binding={ready} />);
    rerender(<ContentAssetImage {...props} binding={next} />);
    expect(container.querySelector("img")).toHaveAttribute("src", picture.src);
    rerender(<ContentAssetImage {...props} presentationKey="scope-b:npc-b" binding={{ ...next, bindingKey: "opaque-b" }} />);
    expect(container.querySelector("img")).toHaveAttribute("src", next.image.src);
  });
});
