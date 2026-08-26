import type { EventReadResult, EventSink } from "@koda/agent-core";
import { agentEventSchema, type AgentEvent } from "@koda/protocol";

export class MemoryEventStore implements EventSink {
  public readonly events: AgentEvent[] = [];

  public async append(event: AgentEvent): Promise<void> {
    this.events.push(agentEventSchema.parse(event));
  }

  public readAll(): EventReadResult {
    return { events: [...this.events], diagnostics: [] };
  }
}
