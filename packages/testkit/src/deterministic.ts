import type { Clock, ItemIdFactory } from "@koda/agent-core";
import { itemIdSchema, type ItemId } from "@koda/protocol";

export class DeterministicItemIdFactory implements ItemIdFactory {
  private cursor = 0;

  public next(): ItemId {
    this.cursor += 1;
    return itemIdSchema.parse(`item-${this.cursor}`);
  }
}

export class FixedClock implements Clock {
  public constructor(private readonly timestamp = "2026-08-26T00:00:00.000Z") {}

  public now(): string {
    return this.timestamp;
  }
}
