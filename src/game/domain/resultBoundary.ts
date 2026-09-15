import type { EventId } from "./events";
import type { FactId, LocationId } from "./worldEntity";

/** 服务端规则证明的结果边界；客户端 Action 不携带该授权对象。 */
export type ResultBoundaryProof =
  | Readonly<{
      readonly kind: "investigation_result";
      readonly factId: FactId;
      readonly approachId: string;
      readonly sourceEventIds: readonly EventId[];
    }>
  | Readonly<{
      readonly kind: "changed_revisit";
      readonly locationId: LocationId;
      readonly previousSceneEventId: EventId;
      readonly sourceEventIds: readonly EventId[];
    }>;
