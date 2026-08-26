import {
  agentEventSchema,
  type AgentEvent,
  type ThreadId,
  type TurnId,
} from "@koda/protocol";

export interface EventSink {
  append(event: AgentEvent): Promise<void>;
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

  public constructor(
    private readonly sink: EventSink,
    private readonly clock: Clock,
    private readonly threadId: ThreadId,
    private readonly turnId: TurnId,
    initialSequence = 0,
  ) {
    this.sequence = initialSequence;
  }

  public async record(data: AgentEventData): Promise<AgentEvent> {
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
  }
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};
