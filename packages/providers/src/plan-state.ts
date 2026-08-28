import type { PlanStateItem } from "@koda/protocol";

export function serializePlanStateNotice(item: PlanStateItem): string {
  const guidance = [
    "This is Koda's authoritative durable execution plan for the current thread.",
    `Use expected revision ${item.plan.revision} for the next update_plan call.`,
    item.needsRevalidation
      ? "An interrupted effect may overlap the active Todo; inspect durable results and current workspace state before advancing it."
      : undefined,
    item.checkpointRecommended
      ? "The Harness is near its step budget; update the Plan with current outcomes before doing more work."
      : undefined,
  ].filter((value): value is string => value !== undefined);
  return `Koda plan state: ${guidance.join(" ")} ${JSON.stringify({
    plan: item.plan,
    ...(item.checkpoint === undefined ? {} : { checkpoint: item.checkpoint }),
  })}`;
}
