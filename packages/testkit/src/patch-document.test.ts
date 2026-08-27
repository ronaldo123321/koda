import {
  MAX_PATCH_DOCUMENT_BYTES,
  MAX_PATCH_DOCUMENT_CHANGES,
  MAX_PATCH_DOCUMENT_HUNKS,
  MAX_PATCH_DOCUMENT_LINE_BYTES,
  WorkspaceError,
  parsePatchDocument,
} from "@koda/runtime-node";
import { describe, expect, it } from "vitest";

describe("Koda Patch v1 parser", () => {
  it("parses create, ordered update hunks, move, and delete sections", () => {
    expect(
      parsePatchDocument(`*** Begin Patch
*** Add File: created.txt
+first
+second
*** Update File: source.txt
@@
 before
-old
+new
@@
 tail
+appended
*** Move File: move.txt
*** To: nested/moved.txt
*** Delete File: delete.txt
*** End Patch`),
    ).toEqual([
      {
        operation: "create",
        path: "created.txt",
        content: "first\nsecond\n",
      },
      {
        operation: "update",
        path: "source.txt",
        edits: [
          {
            oldLines: ["before", "old"],
            newLines: ["before", "new"],
          },
          {
            oldLines: ["tail"],
            newLines: ["tail", "appended"],
          },
        ],
      },
      {
        operation: "move",
        fromPath: "move.txt",
        toPath: "nested/moved.txt",
      },
      { operation: "delete", path: "delete.txt" },
    ]);
  });

  it("accepts consistent CRLF syntax and an explicit missing final newline", () => {
    expect(
      parsePatchDocument(
        "*** Begin Patch\r\n*** Add File: plain.txt\r\n+one\r\n+two\r\n*** No Final Newline\r\n*** End Patch\r\n",
      ),
    ).toEqual([
      {
        operation: "create",
        path: "plain.txt",
        content: "one\ntwo",
      },
    ]);
  });

  it.each([
    ["missing begin", "*** Add File: a\n+x\n*** End Patch"],
    ["empty", "*** Begin Patch\n*** End Patch"],
    ["missing end", "*** Begin Patch\n*** Add File: a\n+x"],
    ["unknown marker", "*** Begin Patch\n*** Copy File: a\n*** End Patch"],
    [
      "unprefixed add line",
      "*** Begin Patch\n*** Add File: a\ntext\n*** End Patch",
    ],
    [
      "no-op update",
      "*** Begin Patch\n*** Update File: a\n@@\n same\n*** End Patch",
    ],
    [
      "insertion without context",
      "*** Begin Patch\n*** Update File: a\n@@\n+new\n*** End Patch",
    ],
    [
      "missing move destination",
      "*** Begin Patch\n*** Move File: a\n*** End Patch",
    ],
    [
      "surrounding path whitespace",
      "*** Begin Patch\n*** Delete File: a \n*** End Patch",
    ],
    [
      "mixed document line endings",
      "*** Begin Patch\r\n*** Delete File: a\n*** End Patch\r\n",
    ],
    [
      "trailing data",
      "*** Begin Patch\n*** Delete File: a\n*** End Patch\ntrailing",
    ],
  ])("rejects %s", (_label, document) => {
    expect(() => parsePatchDocument(document)).toThrowError(
      expect.objectContaining({ code: "PATCH_DOCUMENT_INVALID" }),
    );
  });

  it("rejects forbidden control text and exact section limits", () => {
    expect(() =>
      parsePatchDocument(
        "*** Begin Patch\n*** Add File: a\n+bad\u0000text\n*** End Patch",
      ),
    ).toThrowError(expect.objectContaining({ code: "PATCH_DOCUMENT_INVALID" }));

    const sections = Array.from(
      { length: MAX_PATCH_DOCUMENT_CHANGES + 1 },
      (_, index) => `*** Add File: ${index}.txt\n+x`,
    ).join("\n");
    try {
      parsePatchDocument(`*** Begin Patch\n${sections}\n*** End Patch`);
      throw new Error("Expected parser to reject an oversized document.");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect(error).toMatchObject({
        code: "PATCH_DOCUMENT_LIMIT_EXCEEDED",
      });
    }

    const maximumSections = Array.from(
      { length: MAX_PATCH_DOCUMENT_CHANGES },
      (_, index) => `*** Add File: max-${index}.txt\n+x`,
    ).join("\n");
    expect(
      parsePatchDocument(`*** Begin Patch\n${maximumSections}\n*** End Patch`),
    ).toHaveLength(MAX_PATCH_DOCUMENT_CHANGES);
  });

  it("rejects exact hunk, line, and document byte overflows", () => {
    const hunks = Array.from(
      { length: MAX_PATCH_DOCUMENT_HUNKS + 1 },
      (_, index) => `@@\n-old-${index}\n+new-${index}`,
    ).join("\n");
    expect(() =>
      parsePatchDocument(
        `*** Begin Patch\n*** Update File: a\n${hunks}\n*** End Patch`,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "PATCH_DOCUMENT_LIMIT_EXCEEDED" }),
    );

    expect(() =>
      parsePatchDocument(
        `*** Begin Patch\n*** Add File: a\n+${"x".repeat(MAX_PATCH_DOCUMENT_LINE_BYTES + 1)}\n*** End Patch`,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "PATCH_DOCUMENT_LIMIT_EXCEEDED" }),
    );

    expect(() =>
      parsePatchDocument("x".repeat(MAX_PATCH_DOCUMENT_BYTES + 1)),
    ).toThrowError(
      expect.objectContaining({ code: "PATCH_DOCUMENT_LIMIT_EXCEEDED" }),
    );
  });
});
