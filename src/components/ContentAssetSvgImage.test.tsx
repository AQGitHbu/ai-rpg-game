import { fireEvent, render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ContentAssetSvgImage } from "./ContentAssetSvgImage";

it("removes a broken native SVG image while keeping the logical geometry", () => {
  const { container, rerender } = render(<svg><rect data-floor width={12} height={12} /><ContentAssetSvgImage
    query={{ kind: "town_building", gameType: "wuxia", variant: "tavern" }}
    presentationKey="entry-1" x={0} y={0} width={12} height={12} /></svg>);
  const img = container.querySelector("image")!;
  expect(img.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(img).toHaveAttribute("href", "/assets/town/tavern.webp");
  fireEvent.error(img);
  expect(container.querySelector("image")).toBeNull();
  expect(container.querySelector("[data-floor]")).not.toBeNull();
  rerender(<svg><rect data-floor width={12} height={12} /><ContentAssetSvgImage
    query={{ kind: "town_building", gameType: "wuxia", variant: "tavern" }}
    presentationKey="entry-2" x={0} y={0} width={12} height={12} /></svg>);
  expect(container.querySelector("image")).toHaveAttribute("href", "/assets/town/tavern.webp");
});
