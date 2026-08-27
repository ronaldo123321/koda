import { randomUUID } from "node:crypto";

import type {
  ApprovalGrantManager,
  PreparedApprovalGrant,
} from "@koda/agent-core";
import {
  APPROVAL_GRANT_MAXIMUM_RECORDS,
  approvalGrantCandidateSchema,
  approvalGrantIdSchema,
  approvalGrantRecordSchema,
  approvalGrantSelectionSchema,
  type ApprovalGrantCandidate,
  type ApprovalGrantId,
  type ApprovalGrantRecord,
  type ApprovalGrantSelection,
} from "@koda/protocol";

export interface ApprovalGrantRegistryOptions {
  now?: () => number;
  nextId?: () => ApprovalGrantId;
}

export class ApprovalGrantRegistryError extends Error {
  public constructor(
    public readonly code:
      | "APPROVAL_GRANT_INVALID"
      | "APPROVAL_GRANT_UNAVAILABLE"
      | "APPROVAL_GRANT_LIMIT_EXCEEDED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApprovalGrantRegistryError";
  }
}

interface PendingGrant {
  record: ApprovalGrantRecord;
  replacementIds: ApprovalGrantId[];
  state: "pending" | "activated" | "cancelled";
}

export class ApprovalGrantRegistry {
  private readonly active = new Map<ApprovalGrantId, ApprovalGrantRecord>();
  private readonly pending = new Map<ApprovalGrantId, PendingGrant>();
  private readonly now: () => number;
  private readonly nextId: () => ApprovalGrantId;

  public constructor(options: ApprovalGrantRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.nextId =
      options.nextId ??
      (() => approvalGrantIdSchema.parse(`grant:${randomUUID()}`));
  }

  public forWorkspace(workspaceRoot: string): ApprovalGrantManager {
    return {
      match: (toolName, candidate) =>
        this.match(workspaceRoot, toolName, candidate),
      prepare: (toolName, candidate, selection) =>
        this.prepare(workspaceRoot, toolName, candidate, selection),
      markUsed: (grantId) => this.markUsed(workspaceRoot, grantId),
    };
  }

  public list(workspaceRoot: string): ApprovalGrantRecord[] {
    this.purgeExpired();
    return [...this.active.values()]
      .filter((grant) => grant.workspaceRoot === workspaceRoot)
      .sort(
        (left, right) =>
          left.expiresAt.localeCompare(right.expiresAt) ||
          left.id.localeCompare(right.id),
      )
      .map((grant) => ({ ...grant }));
  }

  public revoke(workspaceRoot: string, grantId: ApprovalGrantId): boolean {
    this.purgeExpired();
    const grant = this.active.get(grantId);
    if (grant === undefined || grant.workspaceRoot !== workspaceRoot) {
      return false;
    }
    return this.active.delete(grantId);
  }

  public revokeAll(workspaceRoot: string): number {
    this.purgeExpired();
    let revoked = 0;
    for (const [grantId, grant] of this.active) {
      if (grant.workspaceRoot === workspaceRoot) {
        this.active.delete(grantId);
        revoked += 1;
      }
    }
    return revoked;
  }

  private match(
    workspaceRoot: string,
    toolName: string,
    rawCandidate: ApprovalGrantCandidate,
  ): ApprovalGrantRecord | undefined {
    this.purgeExpired();
    const candidate = approvalGrantCandidateSchema.parse(rawCandidate);
    if (toolName !== "exec_command") {
      return undefined;
    }
    const matches = [...this.active.values()].filter(
      (grant) =>
        grant.workspaceRoot === workspaceRoot &&
        grant.toolName === toolName &&
        grant.kind === candidate.kind &&
        grant.key === candidate.key,
    );
    const grant = matches.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0];
    return grant === undefined ? undefined : { ...grant };
  }

  private prepare(
    workspaceRoot: string,
    toolName: string,
    rawCandidate: ApprovalGrantCandidate,
    rawSelection: ApprovalGrantSelection,
  ): PreparedApprovalGrant {
    this.purgeExpired();
    const candidate = approvalGrantCandidateSchema.parse(rawCandidate);
    const selection = approvalGrantSelectionSchema.parse(rawSelection);
    if (toolName !== "exec_command") {
      throw new ApprovalGrantRegistryError(
        "APPROVAL_GRANT_UNAVAILABLE",
        "Only exec_command supports session approval grants.",
      );
    }
    if (selection.expiresInSeconds > candidate.maximumExpiresInSeconds) {
      throw new ApprovalGrantRegistryError(
        "APPROVAL_GRANT_INVALID",
        `Grant duration exceeds the candidate maximum of ${candidate.maximumExpiresInSeconds} seconds.`,
      );
    }
    const replacementIds = [...this.active.values()]
      .filter(
        (grant) =>
          grant.workspaceRoot === workspaceRoot &&
          grant.toolName === toolName &&
          grant.kind === candidate.kind &&
          grant.key === candidate.key,
      )
      .map((grant) => grant.id);
    if (
      this.active.size +
        this.pending.size -
        Math.min(1, replacementIds.length) >=
      APPROVAL_GRANT_MAXIMUM_RECORDS
    ) {
      throw new ApprovalGrantRegistryError(
        "APPROVAL_GRANT_LIMIT_EXCEEDED",
        `The session already has ${APPROVAL_GRANT_MAXIMUM_RECORDS} approval grants or pending reservations.`,
      );
    }
    const createdAtMs = this.now();
    const id = this.nextId();
    if (this.active.has(id) || this.pending.has(id)) {
      throw new ApprovalGrantRegistryError(
        "APPROVAL_GRANT_UNAVAILABLE",
        `Approval grant ID '${id}' is already in use.`,
      );
    }
    const record = approvalGrantRecordSchema.parse({
      id,
      kind: candidate.kind,
      toolName,
      workspaceRoot,
      key: candidate.key,
      summary: candidate.summary,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(
        createdAtMs + selection.expiresInSeconds * 1_000,
      ).toISOString(),
      uses: 0,
    });
    const pending: PendingGrant = {
      record,
      replacementIds,
      state: "pending",
    };
    this.pending.set(record.id, pending);
    return {
      record: { ...record },
      activate: () => {
        if (pending.state !== "pending") {
          throw new Error(`Approval grant '${record.id}' is not pending.`);
        }
        pending.state = "activated";
        this.pending.delete(record.id);
        for (const [activeId, activeGrant] of this.active) {
          if (
            activeGrant.workspaceRoot === record.workspaceRoot &&
            activeGrant.toolName === record.toolName &&
            activeGrant.kind === record.kind &&
            activeGrant.key === record.key
          ) {
            this.active.delete(activeId);
          }
        }
        this.active.set(record.id, record);
      },
      cancel: () => {
        if (pending.state === "pending") {
          pending.state = "cancelled";
          this.pending.delete(record.id);
        }
      },
    };
  }

  private markUsed(workspaceRoot: string, grantId: ApprovalGrantId): boolean {
    this.purgeExpired();
    const grant = this.active.get(grantId);
    if (grant === undefined || grant.workspaceRoot !== workspaceRoot) {
      return false;
    }
    this.active.set(
      grantId,
      approvalGrantRecordSchema.parse({ ...grant, uses: grant.uses + 1 }),
    );
    return true;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [grantId, grant] of this.active) {
      if (Date.parse(grant.expiresAt) <= now) {
        this.active.delete(grantId);
      }
    }
  }
}
