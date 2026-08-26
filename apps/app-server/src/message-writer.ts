import type { Writable } from "node:stream";

import type { JsonValue } from "@koda/protocol";

export interface ProtocolMessageWriter {
  write(message: JsonValue): Promise<void>;
}

export class JsonRpcMessageWriter implements ProtocolMessageWriter {
  private writeChain = Promise.resolve();

  public constructor(private readonly output: Writable) {}

  public async write(message: JsonValue): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.output.write(line, "utf8", (error) => {
            if (error === null || error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        }),
    );
    await this.writeChain;
  }
}
