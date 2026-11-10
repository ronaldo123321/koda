import {
  agentEventSchema,
  type AgentEvent,
  type ThreadId,
  type TurnId,
} from "@koda/protocol";

export interface EventSink {
  append(event: AgentEvent): Promise<void>;
}

export class FanoutEventSink implements EventSink {
  public constructor(private readonly sinks: readonly EventSink[]) {
    if (sinks.length === 0) {
      throw new Error("FanoutEventSink requires at least one destination.");
    }
  }

  public async append(event: AgentEvent): Promise<void> {
    for (const sink of this.sinks) {
      await sink.append(event);
    }
  }
}

export interface EventReadDiagnostic {
  code: "PARTIAL_TRAILING_LINE";
  message: string;
  line: number;
}

export interface EventReadResult {
  events: AgentEvent[];
  diagnostics: EventReadDiagnostic[];
}

export interface EventReader {
  readAll(): Promise<EventReadResult>;
}

type AgentEventData<Event extends AgentEvent = AgentEvent> =
  Event extends AgentEvent ? Pick<Event, "type" | "payload"> : never;

export interface Clock {
  now(): string;
}

export class TurnEventRecorder {
  private sequence: number;
  private pending: Promise<void> = Promise.resolve();

  public constructor(
    private readonly sink: EventSink,
    private readonly clock: Clock,
    private readonly threadId: ThreadId,
    private readonly turnId: TurnId,
    initialSequence = 0,
  ) {
    this.sequence = initialSequence;
  }

  public record(data: AgentEventData): Promise<AgentEvent> {
    const recorded = this.pending.then(async () => {
      const event = agentEventSchema.parse({
        schemaVersion: 1,
        sequence: this.sequence,
        timestamp: this.clock.now(),
        threadId: this.threadId,
        turnId: this.turnId,
        ...data,
      });

      await this.sink.append(event);
      this.sequence += 1;
      return event;
    });
    // Serialize sequence allocation and persistence together. Preserve the
    // caller's rejection without poisoning later attempts to record a failure.
    this.pending = recorded.then(
      () => {},
      () => {},
    );
    return recorded;
  }

  public lastRecordedSequence(): number | undefined {
    return this.sequence === 0 ? undefined : this.sequence - 1;
  }
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};
