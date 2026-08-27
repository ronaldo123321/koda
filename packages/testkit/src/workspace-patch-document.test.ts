import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ReadOnlyWorkspace,
  type WorkspaceChangeSetOperationalEvent,
  parsePatchDocument,
} from "@koda/runtime-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporaryRoot: string;
let workspaceRoot: string;
let workspace: ReadOnlyWorkspace;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "koda-patch-document-"));
  workspaceRoot = join(temporaryRoot, "repo");
  await mkdir(join(workspaceRoot, "nested"), { recursive: true });
  workspace = await ReadOnlyWorkspace.open(workspaceRoot);
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("workspace patch-document compilation", () => {
  it("resolves ordered hunks against the evolving LF candidate", async () => {
    await writeFile(join(workspaceRoot, "source.txt"), "start\nold\nend\n");
    const prepared = await workspace.prepareChangeSet({
      changes: parsePatchDocument(`*** Begin Patch
*** Update File: source.txt
@@
 start
-old
+middle
 end
@@
 middle
+added
 end
*** End Patch`),
    });
    const events: WorkspaceChangeSetOperationalEvent[] = [];

    await prepared.apply(new AbortController().signal, (event) => {
      events.push(event);
      return Promise.resolve();
    });

    expect(await readFile(join(workspaceRoot, "source.txt"), "utf8")).toBe(
      "start\nmiddle\nadded\nend\n",
    );
    expect(events.map((event) => event.type)).toEqual([
      "workspace.change_set_prepared",
      "workspace.change_set_committed",
    ]);
  });

  it("preserves CRLF and each target's final-newline state", async () => {
    await writeFile(join(workspaceRoot, "crlf.txt"), "head\r\nold\r\ntail\r\n");
    await writeFile(join(workspaceRoot, "no-final.txt"), "head\nold");
    const prepared = await workspace.prepareChangeSet({
      changes: parsePatchDocument(`*** Begin Patch
*** Update File: crlf.txt
@@
 head
-old
+new
 tail
*** Update File: no-final.txt
@@
 head
-old
+new
*** End Patch`),
    });

    await prepared.apply(new AbortController().signal, () => Promise.resolve());

    expect(await readFile(join(workspaceRoot, "crlf.txt"), "utf8")).toBe(
      "head\r\nnew\r\ntail\r\n",
    );
    expect(await readFile(join(workspaceRoot, "no-final.txt"), "utf8")).toBe(
      "head\nnew",
    );
  });

  it("rejects missing, ambiguous, and unsupported mixed-ending hunks", async () => {
    await writeFile(join(workspaceRoot, "ambiguous.txt"), "same\nx\nsame\n");
    await writeFile(join(workspaceRoot, "mixed.txt"), "one\ntwo\r\n");

    await expect(
      workspace.prepareChangeSet({
        changes: parsePatchDocument(`*** Begin Patch
*** Update File: ambiguous.txt
@@
-same
+changed
*** End Patch`),
      }),
    ).rejects.toMatchObject({ code: "PATCH_MATCH_AMBIGUOUS" });
    await expect(
      workspace.prepareChangeSet({
        changes: parsePatchDocument(`*** Begin Patch
*** Update File: ambiguous.txt
@@
-missing
+changed
*** End Patch`),
      }),
    ).rejects.toMatchObject({ code: "PATCH_MATCH_NOT_FOUND" });
    await expect(
      workspace.prepareChangeSet({
        changes: parsePatchDocument(`*** Begin Patch
*** Update File: mixed.txt
@@
-one
+changed
*** End Patch`),
      }),
    ).rejects.toMatchObject({ code: "PATCH_LINE_ENDINGS_UNSUPPORTED" });
  });

  it("compiles every section into the existing coordinated transaction", async () => {
    await writeFile(join(workspaceRoot, "move.txt"), "move\n");
    await writeFile(join(workspaceRoot, "delete.txt"), "delete\n");
    const prepared = await workspace.prepareChangeSet({
      changes: parsePatchDocument(`*** Begin Patch
*** Add File: created.txt
+created
*** Move File: move.txt
*** To: nested/moved.txt
*** Delete File: delete.txt
*** End Patch`),
    });

    const result = await prepared.apply(new AbortController().signal, () =>
      Promise.resolve(),
    );

    expect(result.changes.map((change) => change.operation)).toEqual([
      "create",
      "move",
      "delete",
    ]);
    expect(await readFile(join(workspaceRoot, "created.txt"), "utf8")).toBe(
      "created\n",
    );
    expect(
      await readFile(join(workspaceRoot, "nested/moved.txt"), "utf8"),
    ).toBe("move\n");
    await expect(
      readFile(join(workspaceRoot, "delete.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
