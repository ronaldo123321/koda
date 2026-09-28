import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpOAuthProvider, McpOAuthVault } from "@koda/mcp-client-node";
import { describe, expect, it } from "vitest";

const endpoint = "https://mcp.example.test/mcp";

describe.skipIf(process.platform !== "darwin")("macOS MCP OAuth vault", () => {
  it("isolates server state, encrypts it, revokes it, and rotates the key", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-mcp-oauth-vault-"));
    const oldKey = randomBytes(32).toString("base64");
    const newKey = randomBytes(32).toString("base64");
    try {
      const vault = await McpOAuthVault.open(home, oldKey);
      const state = {
        accessToken: "secret-access-token",
        refreshToken: "secret-refresh-token",
        codeVerifier: "secret-pkce-verifier",
      };
      await vault.save("reviewed", endpoint, state);
      expect(await vault.load("reviewed", endpoint)).toEqual(state);
      expect(await vault.load("other", endpoint)).toBeUndefined();
      expect(
        await vault.load("reviewed", "https://mcp.example.test/other"),
      ).toBeUndefined();
      const path = join(home, "mcp-oauth", "vault.json");
      const raw = await readFile(path, "utf8");
      expect(raw).not.toContain("secret-access-token");
      expect(raw).not.toContain("secret-refresh-token");
      expect(raw).not.toContain("secret-pkce-verifier");
      expect((await stat(path)).mode & 0o077).toBe(0);

      await vault.rotateKey(newKey);
      await expect(McpOAuthVault.open(home, oldKey)).rejects.toThrow(
        "could not be decrypted",
      );
      const reopened = await McpOAuthVault.open(home, newKey);
      expect(await reopened.load("reviewed", endpoint)).toEqual(state);
      await reopened.remove("reviewed", endpoint);
      expect(await reopened.load("reviewed", endpoint)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects tampering, bad keys, and a linked vault file", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-mcp-oauth-tamper-"));
    const key = randomBytes(32).toString("base64");
    try {
      await expect(McpOAuthVault.open(home, "bad-key")).rejects.toThrow(
        "canonical Base64",
      );
      const vault = await McpOAuthVault.open(home, key);
      await vault.save("reviewed", endpoint, { token: "sensitive" });
      const path = join(home, "mcp-oauth", "vault.json");
      const raw = JSON.parse(await readFile(path, "utf8")) as {
        ciphertext: string;
      };
      raw.ciphertext = randomBytes(32).toString("base64");
      await writeFile(path, JSON.stringify(raw));
      await expect(McpOAuthVault.open(home, key)).rejects.toThrow(
        "could not be decrypted",
      );
      await rm(path);
      await symlink(join(home, "outside"), path);
      await expect(McpOAuthVault.open(home, key)).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("binds the callback state, redirect, and issuer-scoped credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-mcp-oauth-provider-"));
    try {
      const vault = await McpOAuthVault.open(
        home,
        randomBytes(32).toString("base64"),
      );
      const redirect = "http://127.0.0.1:8765/callback";
      let authorization: string | undefined;
      const provider = new McpOAuthProvider(
        vault,
        "reviewed",
        endpoint,
        redirect,
        (url) => {
          authorization = url.href;
        },
      );
      const state = await provider.state();
      await provider.saveCodeVerifier("pkce-verifier");
      await expect(provider.verifyCallback("wrong-state")).rejects.toThrow(
        "does not match",
      );
      await provider.verifyCallback(state);
      expect(await provider.codeVerifier()).toBe("pkce-verifier");
      await expect(
        provider.redirectToAuthorization(
          new URL(
            `https://auth.example.test/authorize?state=${state}&redirect_uri=http://127.0.0.1:9999/callback`,
          ),
        ),
      ).rejects.toThrow("authorization URL is invalid");
      await provider.redirectToAuthorization(
        new URL(
          `https://auth.example.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
        ),
      );
      expect(authorization).toContain("https://auth.example.test/authorize");
      const issuer = "https://auth.example.test";
      const registered = new McpOAuthProvider(
        vault,
        "reviewed",
        endpoint,
        redirect,
        undefined,
        "registered-client",
      );
      expect((await registered.clientInformation({ issuer }))?.client_id).toBe(
        "registered-client",
      );
      await provider.saveClientInformation(
        { client_id: "koda-client", issuer },
        { issuer },
      );
      await provider.saveTokens(
        { access_token: "secret-token", token_type: "Bearer", issuer },
        { issuer },
      );
      expect((await provider.tokens())?.access_token).toBe("secret-token");
      expect(
        await provider.tokens({ issuer: "https://other.example.test" }),
      ).toBeUndefined();
      expect((await provider.clientInformation({ issuer }))?.client_id).toBe(
        "koda-client",
      );
      await provider.invalidateCredentials("tokens");
      expect(await provider.tokens()).toBeUndefined();
      await provider.clearPending();
      await expect(provider.verifyCallback(state)).rejects.toThrow(
        "expired or changed",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
