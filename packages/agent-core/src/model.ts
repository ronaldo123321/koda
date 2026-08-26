import type {
  ConversationItem,
  JsonObject,
  ThreadId,
  ToolCallId,
  TurnId,
  TokenUsage,
} from "@koda/protocol";

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputJsonSchema: JsonObject;
}

export interface ModelRequest {
  threadId: ThreadId;
  turnId: TurnId;
  step: number;
  items: readonly ConversationItem[];
  tools: readonly ModelToolDefinition[];
}

export type ModelEvent =
  | { type: "assistant_delta"; text: string }
  | {
      type: "tool_call";
      callId: ToolCallId;
      name: string;
      arguments: JsonObject;
    }
  | {
      type: "completed";
      finishReason: "stop" | "tool_calls";
      responseId?: string;
      usage?: TokenUsage;
    };

export interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
