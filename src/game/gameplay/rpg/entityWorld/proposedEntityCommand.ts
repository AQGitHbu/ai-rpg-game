import { getEntity, type EntityStore } from "@/game/domain/entity";
import type { ItemId, LocationId, NpcId } from "@/game/domain/worldEntity";
import type { EntityMutation } from "./entityMutation";

export type ProposedEntityCommand =
  | { readonly kind: "move_npc"; readonly npcId: string; readonly toLocationId: string }
  | { readonly kind: "set_npc_lifecycle"; readonly npcId: string; readonly lifecycle: "active" | "inactive" }
  | { readonly kind: "place_item"; readonly itemId: string; readonly owner: { readonly kind: "location"; readonly locationId: string } | { readonly kind: "npc"; readonly npcId: string } };
export type EntityCommandProvenance = Readonly<{ jobId: string; basedOnRevision: number }>;
export type EntityCommandApprovalContext = Readonly<{ allowedEntityIds: readonly string[]; allowedLocationIds: readonly string[]; immovableEntityIds: readonly string[]; provenance: EntityCommandProvenance }>;
export type ApprovedEntityCommand =
  | { readonly kind: "move_npc"; readonly npcId: NpcId; readonly toLocationId: LocationId; readonly provenance: EntityCommandProvenance }
  | { readonly kind: "set_npc_lifecycle"; readonly npcId: NpcId; readonly lifecycle: "active" | "inactive"; readonly provenance: EntityCommandProvenance }
  | { readonly kind: "place_item"; readonly itemId: ItemId; readonly owner: { readonly kind: "location"; readonly locationId: LocationId } | { readonly kind: "npc"; readonly npcId: NpcId }; readonly provenance: EntityCommandProvenance };
export type ParseProposedEntityCommandsResult = { readonly ok: true; readonly proposals: readonly ProposedEntityCommand[] } | { readonly ok: false; readonly code: "root_not_array" | "unknown_kind" | "unknown_key" | "invalid_field"; readonly index?: number };
export type ApproveProposedEntityCommandsResult = { readonly ok: true; readonly commands: readonly ApprovedEntityCommand[] } | { readonly ok: false; readonly code: "unknown_entity" | "wrong_entity_kind" | "entity_not_allowed" | "location_not_allowed" | "entity_immovable" | "invalid_entity_lifecycle" | "invalid_lifecycle_transition"; readonly index: number; readonly entityId?: string };
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Obj, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((key) => key in v);
const parseFail = (code: "unknown_kind" | "unknown_key" | "invalid_field", index: number): ParseProposedEntityCommandsResult => ({ ok: false, code, index });

export function parseProposedEntityCommands(value: unknown): ParseProposedEntityCommandsResult {
  if (!Array.isArray(value)) return { ok: false, code: "root_not_array" };
  const proposals: ProposedEntityCommand[] = [];
  for (const [index, raw] of value.entries()) {
    if (!object(raw) || typeof raw.kind !== "string") return parseFail("unknown_kind", index);
    if (raw.kind === "move_npc") {
      if (!exact(raw, ["kind", "npcId", "toLocationId"])) return parseFail("unknown_key", index);
      if (typeof raw.npcId !== "string" || typeof raw.toLocationId !== "string") return parseFail("invalid_field", index);
      proposals.push({ kind: "move_npc", npcId: raw.npcId, toLocationId: raw.toLocationId });
    } else if (raw.kind === "set_npc_lifecycle") {
      if (!exact(raw, ["kind", "npcId", "lifecycle"])) return parseFail("unknown_key", index);
      if (typeof raw.npcId !== "string" || (raw.lifecycle !== "active" && raw.lifecycle !== "inactive")) return parseFail("invalid_field", index);
      proposals.push({ kind: "set_npc_lifecycle", npcId: raw.npcId, lifecycle: raw.lifecycle });
    } else if (raw.kind === "place_item") {
      if (!exact(raw, ["kind", "itemId", "owner"])) return parseFail("unknown_key", index);
      if (typeof raw.itemId !== "string" || !object(raw.owner)) return parseFail("invalid_field", index);
      if ((raw.owner.kind === "location" && !exact(raw.owner, ["kind", "locationId"]))
        || (raw.owner.kind === "npc" && !exact(raw.owner, ["kind", "npcId"]))) {
        return parseFail("unknown_key", index);
      }
      if (raw.owner.kind === "location" && exact(raw.owner, ["kind", "locationId"]) && typeof raw.owner.locationId === "string") proposals.push({ kind: "place_item", itemId: raw.itemId, owner: { kind: "location", locationId: raw.owner.locationId } });
      else if (raw.owner.kind === "npc" && exact(raw.owner, ["kind", "npcId"]) && typeof raw.owner.npcId === "string") proposals.push({ kind: "place_item", itemId: raw.itemId, owner: { kind: "npc", npcId: raw.owner.npcId } });
      else return parseFail("invalid_field", index);
    } else return parseFail("unknown_kind", index);
  }
  return { ok: true, proposals };
}

function approval(store: EntityStore, id: string, kind: "npc" | "item" | "location", context: EntityCommandApprovalContext, index: number, needsLocationAllowlist: boolean, immovable: boolean): Exclude<ApproveProposedEntityCommandsResult, { ok: true }> | undefined {
  const record = getEntity(store, id);
  if (record === undefined) return { ok: false, code: "unknown_entity", index, entityId: id };
  if (record.core.kind !== kind) return { ok: false, code: "wrong_entity_kind", index, entityId: id };
  if (needsLocationAllowlist ? !context.allowedLocationIds.includes(id) : !context.allowedEntityIds.includes(id)) return { ok: false, code: needsLocationAllowlist ? "location_not_allowed" : "entity_not_allowed", index, entityId: id };
  if (immovable && context.immovableEntityIds.includes(id)) return { ok: false, code: "entity_immovable", index, entityId: id };
  if (record.core.lifecycle === "resolved" || record.core.lifecycle === "destroyed") return { ok: false, code: "invalid_lifecycle_transition", index, entityId: id };
  if ((kind === "location" || kind === "item") && record.core.lifecycle !== "active") return { ok: false, code: "invalid_entity_lifecycle", index, entityId: id };
}

export function approveProposedEntityCommands(store: EntityStore, proposals: readonly ProposedEntityCommand[], context: EntityCommandApprovalContext): ApproveProposedEntityCommandsResult {
  const commands: ApprovedEntityCommand[] = [];
  for (const [index, proposal] of proposals.entries()) {
    if (proposal.kind === "move_npc") {
      const subject = approval(store, proposal.npcId, "npc", context, index, false, true); if (subject) return subject;
      const target = approval(store, proposal.toLocationId, "location", context, index, true, false); if (target) return target;
      commands.push({ kind: proposal.kind, npcId: proposal.npcId as NpcId, toLocationId: proposal.toLocationId as LocationId, provenance: context.provenance });
    } else if (proposal.kind === "set_npc_lifecycle") {
      const subject = approval(store, proposal.npcId, "npc", context, index, false, false); if (subject) return subject;
      commands.push({ kind: proposal.kind, npcId: proposal.npcId as NpcId, lifecycle: proposal.lifecycle, provenance: context.provenance });
    } else {
      const item = approval(store, proposal.itemId, "item", context, index, false, false); if (item) return item;
      const ownerId = proposal.owner.kind === "location" ? proposal.owner.locationId : proposal.owner.npcId;
      const owner = approval(store, ownerId, proposal.owner.kind, context, index, proposal.owner.kind === "location", false); if (owner) return owner;
      commands.push({ kind: "place_item", itemId: proposal.itemId as ItemId, owner: proposal.owner.kind === "location" ? { kind: "location", locationId: proposal.owner.locationId as LocationId } : { kind: "npc", npcId: proposal.owner.npcId as NpcId }, provenance: context.provenance });
    }
  }
  return { ok: true, commands };
}

export function entityMutationsForApprovedCommands(commands: readonly ApprovedEntityCommand[]): readonly EntityMutation[] {
  return commands.map((command) => command.kind === "move_npc" ? { kind: "move_npc", npcId: command.npcId, toLocationId: command.toLocationId } : command.kind === "set_npc_lifecycle" ? { kind: "set_npc_lifecycle", npcId: command.npcId, lifecycle: command.lifecycle } : { kind: "transfer_item", itemId: command.itemId, owner: command.owner });
}
