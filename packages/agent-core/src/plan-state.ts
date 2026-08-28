import {
  itemIdSchema,
  planCheckpointIdSchema,
  planIdSchema,
  planStateItemSchema,
  type PlanCheckpoint,
  type PlanCheckpointId,
  type PlanId,
  type PlanSnapshot,
  type PlanStateItem,
} from "@koda/protocol";

export interface PlanRuntimeStateOptions {
  nextOpaqueId(): string;
  initialPlan?: PlanSnapshot;
  initialCheckpoint?: PlanCheckpoint;
  needsRevalidation?: boolean;
}

export class PlanRuntimeState {
  private plan: PlanSnapshot | undefined;
  private checkpoint: PlanCheckpoint | undefined;
  private revalidationRequired: boolean;

  public constructor(private readonly options: PlanRuntimeStateOptions) {
    this.plan = options.initialPlan;
    this.checkpoint = options.initialCheckpoint;
    this.revalidationRequired = options.needsRevalidation ?? false;
  }

  public currentPlan(): PlanSnapshot | undefined {
    return this.plan;
  }

  public lastCheckpoint(): PlanCheckpoint | undefined {
    return this.checkpoint;
  }

  public needsRevalidation(): boolean {
    return this.revalidationRequired;
  }

  public createPlanId(): PlanId {
    return planIdSchema.parse(`plan:${this.options.nextOpaqueId()}`);
  }

  public createCheckpointId(): PlanCheckpointId {
    return planCheckpointIdSchema.parse(
      `checkpoint:${this.options.nextOpaqueId()}`,
    );
  }

  public commitPlan(plan: PlanSnapshot): void {
    this.plan = plan;
  }

  public commitCheckpoint(checkpoint: PlanCheckpoint): void {
    this.checkpoint = checkpoint;
  }

  public clearRevalidation(): void {
    this.revalidationRequired = false;
  }

  public contextItem(
    checkpointRecommended: boolean,
  ): PlanStateItem | undefined {
    if (this.plan === undefined) {
      return undefined;
    }
    const suffix = checkpointRecommended ? ":checkpoint" : "";
    return planStateItemSchema.parse({
      type: "plan_state",
      id: itemIdSchema.parse(
        `plan-state:${this.plan.planId}:${this.plan.revision}${suffix}`,
      ),
      plan: this.plan,
      ...(this.checkpoint === undefined ? {} : { checkpoint: this.checkpoint }),
      needsRevalidation: this.revalidationRequired,
      checkpointRecommended,
    });
  }
}
