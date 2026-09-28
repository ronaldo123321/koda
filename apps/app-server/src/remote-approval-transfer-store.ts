import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface RemoteApprovalTransferRecord {
  ownerId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  callId: string;
  fromDeviceId: string;
  toDeviceId: string;
  requestedAt: string;
}

export class RemoteApprovalTransferStore {
  private constructor(private readonly root: string) {}

  public static async open(
    kodaHome: string,
  ): Promise<RemoteApprovalTransferStore> {
    if (process.platform === "win32") {
      throw new Error("Remote approval transfers are unavailable on Windows.");
    }
    const root = join(resolve(kodaHome), "remote", "approval-transfers");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    ) {
      throw new Error("Remote approval transfer directory is unsafe.");
    }
    await chmod(root, 0o700);
    return new RemoteApprovalTransferStore(root);
  }

  public async append(record: RemoteApprovalTransferRecord): Promise<void> {
    const path = join(this.root, `${randomUUID()}.json`);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(this.root, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
