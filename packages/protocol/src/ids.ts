import { z } from "zod";

export const threadIdSchema = z.string().min(1).brand<"ThreadId">();
export const turnIdSchema = z.string().min(1).brand<"TurnId">();
export const itemIdSchema = z.string().min(1).brand<"ItemId">();
export const toolCallIdSchema = z.string().min(1).brand<"ToolCallId">();

export type ThreadId = z.infer<typeof threadIdSchema>;
export type TurnId = z.infer<typeof turnIdSchema>;
export type ItemId = z.infer<typeof itemIdSchema>;
export type ToolCallId = z.infer<typeof toolCallIdSchema>;
