import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, EffectToolPolicy, ToolRegistry } from "@koda/agent-core";
import {
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type ToolResultItem,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import {
  ReadOnlyWorkspace,
  WorkspaceMutationCoordinator,
  registerChangeSetTool,
} from "@koda/runtime-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DeterministicItemIdFactory,
  FixedClock,
  MemoryEventStore,
} from "./index.js";

let temporaryRoot: string;
let workspaceRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "koda-change-tool-"));
  workspaceRoot = join(temporaryRoot, "repo");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "first.txt"), "before\n");
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("apply_changes tool", () => {
  it("uses one approval and durably records the transaction boundary", async () => {
    const tools = new ToolRegistry();
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const coordinator = await WorkspaceMutationCoordinator.open(
      temporaryRoot,
      workspace.root,
    );
    registerChangeSetTool(tools, workspace, coordinator);
    const events = new MemoryEventStore();
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.tools.map((tool) => tool.name)).toEqual([
            "apply_changes",
          ]);
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("change-tool-call"),
            name: "apply_changes",
            arguments: {
              changes: [
                {
                  operation: "update",
                  path: "first.txt",
                  edits: [{ old_text: "before", new_text: "after" }],
                },
                {
                  operation: "create",
                  path: "second.txt",
                  content: "created\n",
                },
              ],
            },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          const result = request.items.at(-1) as ToolResultItem;
          expect(result).toMatchObject({
            status: "success",
            output: { status: "committed" },
          });
        },
        events: [
          { type: "assistant_delta", text: "Applied both changes." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    let approvals = 0;
    const result = await new AgentLoop({
      provider,
      tools,
      events,
      ids: new DeterministicItemIdFactory("change-tool-item"),
      clock: new FixedClock(),
      policy: new EffectToolPolicy("on-request"),
      approvals: {
        request: async (request) => {
          approvals += 1;
          expect(request.details).toContain("*** Update File: first.txt");
          expect(request.details).toContain("*** Create File: second.txt");
          return { decision: "approved" };
        },
      },
    }).runTurn({
      threadId: threadIdSchema.parse("change-tool-thread"),
      turnId: turnIdSchema.parse("change-tool-turn"),
      userInput: "Apply both changes.",
    });

    expect(result.status).toBe("completed");
    expect(approvals).toBe(1);
    expect(await readFile(join(workspaceRoot, "first.txt"), "utf8")).toBe(
      "after\n",
    );
    expect(await readFile(join(workspaceRoot, "second.txt"), "utf8")).toBe(
      "created\n",
    );
    const types = events.events.map((event) => event.type);
    expect(types.indexOf("approval.resolved")).toBeLessThan(
      types.indexOf("tool.execution_started"),
    );
    expect(types.indexOf("tool.execution_started")).toBeLessThan(
      types.indexOf("workspace.change_set_prepared"),
    );
    expect(types.indexOf("workspace.change_set_prepared")).toBeLessThan(
      types.indexOf("workspace.change_set_committed"),
    );
    expect(types.indexOf("workspace.change_set_committed")).toBeLessThan(
      types.indexOf("tool.completed"),
    );
  });
});
