import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KodaApplication } from "@koda/app";
import { rejectApprovalsBroker } from "@koda/agent-core";
import { threadIdSchema, toolCallIdSchema, turnIdSchema } from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { ProjectNoteStore, ReadOnlyWorkspace } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project note model tools", () => {
  it("retrieves only explicit workspace notes through bounded read tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-note-app-"));
    roots.push(root);
    const workspacePath = join(root, "repo");
    await mkdir(workspacePath);
    const workspace = await realpath(workspacePath);
    const state = join(root, "state");
    const store = await ProjectNoteStore.open(state, {
      id: () => "note-alpha",
    });
    store.create({
      workspaceRoot: workspace,
      title: "Release workflow",
      body: "Run signed smoke tests before publishing.",
    });
    store.close();

    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          const names = request.tools.map((tool) => tool.name);
          expect(names).toContain("search_project_notes");
          expect(names).toContain("read_project_note");
          expect(names).not.toContain("write_project_note");
          expect(JSON.stringify(request.items)).not.toContain(
            "Run signed smoke tests",
          );
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("search-note-call"),
            name: "search_project_notes",
            arguments: { query: "signed smoke" },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "tool_result",
                name: "search_project_notes",
                output: {
                  matches: [expect.objectContaining({ id: "note-alpha" })],
                },
              }),
            ]),
          );
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("read-note-call"),
            name: "read_project_note",
            arguments: { id: "note-alpha" },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "tool_result",
                name: "read_project_note",
                output: {
                  status: "found",
                  note: expect.objectContaining({
                    id: "note-alpha",
                    body: "Run signed smoke tests before publishing.",
                  }),
                },
              }),
            ]),
          );
        },
        events: [
          { type: "assistant_delta", text: "Use the signed smoke tests." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const application = new KodaApplication({
      environment: { KODA_HOME: state, OPENAI_API_KEY: "offline-test-key" },
      processDirectory: root,
      dependencies: {
        openWorkspace: (path) => ReadOnlyWorkspace.open(path),
        createProvider: () => provider,
        createIds: () => ({
          threadId: threadIdSchema.parse("project-notes-thread"),
          turnId: turnIdSchema.parse("project-notes-turn"),
          itemIds: new DeterministicItemIdFactory("project-note-item"),
        }),
      },
    });
    const turn = application.startTurn(
      { prompt: "Find the release workflow note.", cwd: workspace },
      {
        events: { append: async () => undefined },
        approvals: rejectApprovalsBroker,
      },
    );
    const result = await turn.completion;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
  });
});
