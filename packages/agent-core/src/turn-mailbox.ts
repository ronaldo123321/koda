export type TurnMailboxEnqueueResult =
  "accepted" | "closed" | "full" | "invalid";

const MAX_MESSAGES = 16;
const MAX_MESSAGE_BYTES = 4_096;

export class TurnMailbox {
  private readonly messages: string[] = [];
  private closed = false;

  public enqueue(content: string): TurnMailboxEnqueueResult {
    if (this.closed) return "closed";
    const trimmed = content.trim();
    if (
      trimmed.length === 0 ||
      new TextEncoder().encode(trimmed).byteLength > MAX_MESSAGE_BYTES
    ) {
      return "invalid";
    }
    if (this.messages.length >= MAX_MESSAGES) return "full";
    this.messages.push(trimmed);
    return "accepted";
  }

  public drain(): string[] {
    return this.messages.splice(0);
  }

  public hasPending(): boolean {
    return this.messages.length > 0;
  }

  public close(): void {
    this.closed = true;
    this.messages.length = 0;
  }
}
