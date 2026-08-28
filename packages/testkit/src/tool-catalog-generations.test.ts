import { ToolRegistry } from "@koda/agent-core";
import { threadIdSchema, toolCallIdSchema, turnIdSchema } from "@koda/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("ToolRegistry catalog generations", () => {
  it("atomically replaces one namespace with deterministic added/changed/removed evidence", () => {
    const registry = new ToolRegistry();
    registry.register(registration("builtin", "builtin", "read"));
    const initial = registry.catalogGeneration();

    const first = registry.replaceNamespace("mcp", (register) => {
      register(registration("mcp__fixture__alpha", "alpha-v1", "execute"));
      register(registration("mcp__fixture__removed", "removed", "execute"));
    });
    expect(first.previous).toEqual(initial);
    expect(first.changes).toEqual([
      expect.objectContaining({ name: "mcp__fixture__alpha", change: "added" }),
      expect.objectContaining({
        name: "mcp__fixture__removed",
        change: "added",
      }),
    ]);

    const second = registry.replaceNamespace("mcp", (register) => {
      register(registration("mcp__fixture__added", "added", "execute"));
      register(registration("mcp__fixture__alpha", "alpha-v2", "execute"));
    });
    expect(second.previous).toEqual(first.current);
    expect(second.current).toEqual(registry.catalogGeneration());
    expect(second.current.generationId).not.toBe(first.current.generationId);
    expect(second.changes).toEqual([
      expect.objectContaining({ name: "mcp__fixture__added", change: "added" }),
      expect.objectContaining({
        name: "mcp__fixture__alpha",
        change: "changed",
      }),
      expect.objectContaining({
        name: "mcp__fixture__removed",
        change: "removed",
      }),
    ]);
    expect(registry.definitions().map((tool) => tool.name)).toEqual([
      "builtin",
      "mcp__fixture__added",
      "mcp__fixture__alpha",
    ]);
  });

  it("leaves the previous generation intact when staging fails or collides", () => {
    const registry = new ToolRegistry();
    registry.register(registration("builtin", "builtin", "read"));
    registry.replaceNamespace("mcp", (register) => {
      register(registration("mcp__fixture__alpha", "alpha", "execute"));
    });
    const before = registry.catalogGeneration();
    const definitions = registry.definitions();

    expect(() =>
      registry.replaceNamespace("mcp", (register) => {
        register(registration("mcp__fixture__new", "new", "execute"));
        register(registration("builtin", "collision", "execute"));
      }),
    ).toThrow("conflicts with an existing Koda tool");
    expect(registry.catalogGeneration()).toEqual(before);
    expect(registry.definitions()).toEqual(definitions);

    expect(() =>
      registry.replaceNamespace("mcp", () => {
        throw new Error("staging failed");
      }),
    ).toThrow("staging failed");
    expect(registry.catalogGeneration()).toEqual(before);
  });

  it("keeps a prepared invocation bound to its old generation", async () => {
    const registry = new ToolRegistry();
    registry.replaceNamespace("mcp", (register) => {
      register(registration("mcp__fixture__value", "old", "execute"));
    });
    const oldInvocation = await prepare(registry, "mcp__fixture__value");

    registry.replaceNamespace("mcp", (register) => {
      register(registration("mcp__fixture__value", "new", "execute"));
    });
    const newInvocation = await prepare(registry, "mcp__fixture__value");

    await expect(oldInvocation.execute()).resolves.toEqual({
      status: "success",
      output: { value: "old" },
    });
    await expect(newInvocation.execute()).resolves.toEqual({
      status: "success",
      output: { value: "new" },
    });
  });

  it("includes opaque source identity and policy in generation identity", () => {
    const registry = new ToolRegistry();
    const first = registry.replaceNamespace("mcp", (register) => {
      register(
        registration("mcp__fixture__value", "same", "execute", "source-v1"),
      );
    });
    const identityChanged = registry.replaceNamespace("mcp", (register) => {
      register(
        registration("mcp__fixture__value", "same", "execute", "source-v2"),
      );
    });
    const effectChanged = registry.replaceNamespace("mcp", (register) => {
      register(
        registration("mcp__fixture__value", "same", "read", "source-v2"),
      );
    });

    expect(identityChanged.previous).toEqual(first.current);
    expect(identityChanged.changes[0]?.change).toBe("changed");
    expect(effectChanged.changes[0]?.change).toBe("changed");
    expect(effectChanged.current.generationId).not.toBe(
      identityChanged.current.generationId,
    );
  });
});

function registration(
  name: string,
  value: string,
  effect: "read" | "execute",
  sourceIdentity = value,
) {
  return {
    spec: {
      name,
      description: `Return ${value}.`,
      inputJsonSchema: { type: "object" },
    },
    inputSchema: z.object({}).strict(),
    concurrency: "exclusive" as const,
    effect,
    catalogIdentity: { source_identity: sourceIdentity },
    execute: async () => ({ value }),
  };
}

async function prepare(registry: ToolRegistry, name: string) {
  const result = await registry.prepare(
    {
      callId: toolCallIdSchema.parse(`call-${name}`),
      name,
      arguments: {},
    },
    {
      threadId: threadIdSchema.parse("catalog-thread"),
      turnId: turnIdSchema.parse("catalog-turn"),
      signal: new AbortController().signal,
    },
  );
  if (result.status !== "ready") {
    throw new Error(JSON.stringify(result.result));
  }
  return result.invocation;
}
