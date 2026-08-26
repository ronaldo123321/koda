import type { ModelEvent, ModelProvider, ModelRequest } from "@koda/agent-core";

export interface ScriptedModelStep {
  events: readonly ModelEvent[];
  assertRequest?: (request: ModelRequest) => void | Promise<void>;
}

export class ScriptedModelProvider implements ModelProvider {
  private cursor = 0;

  public constructor(private readonly steps: readonly ScriptedModelStep[]) {}

  public async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    const step = this.steps[this.cursor];
    if (step === undefined) {
      throw new Error(
        `The scripted provider has no response for model step ${this.cursor + 1}.`,
      );
    }
    this.cursor += 1;
    await step.assertRequest?.(request);

    for (const event of step.events) {
      signal.throwIfAborted();
      yield event;
    }
  }

  public remainingSteps(): number {
    return this.steps.length - this.cursor;
  }
}
