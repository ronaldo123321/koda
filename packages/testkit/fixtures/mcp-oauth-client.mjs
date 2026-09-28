import { readFile } from "node:fs/promises";

import {
  connectOfficialMcpClient,
  loadMcpConfiguration,
  loginMcpOAuthServer,
  revokeMcpOAuthServer,
} from "../../../packages/mcp-client-node/dist/index.js";

const [home] = process.argv.slice(2);
const config = await loadMcpConfiguration({
  environment: process.env,
  kodaHome: home,
  processDirectory: home,
});
const server = config.servers.find((item) => item.id === "fixture");
if (!server) throw new Error("Missing OAuth fixture configuration.");
const signal = new AbortController().signal;
await loginMcpOAuthServer("fixture", {
  environment: process.env,
  kodaHome: home,
  processDirectory: home,
  signal,
  onAuthorizationUrl: async (url) => {
    const redirect = url.searchParams.get("redirect_uri");
    if (!redirect) throw new Error("OAuth authorization omitted redirect.");
    const invalid = new URL(redirect);
    invalid.searchParams.set("state", "wrong-state");
    invalid.searchParams.set("code", "fixture-code");
    const denied = await fetch(invalid);
    if (denied.status !== 400)
      throw new Error("Invalid OAuth state was accepted.");
    const response = await fetch(url);
    if (!response.ok) throw new Error("Browser fixture authorization failed.");
  },
});
const connection = await connectOfficialMcpClient(
  server,
  process.env,
  signal,
  home,
);
try {
  const tools = await connection.listTools(signal, 5_000);
  const tool = tools.find((item) => item.name === "echo");
  if (!tool) throw new Error("OAuth MCP tool is missing.");
  const result = await connection.callTool(
    tool,
    { value: "hello" },
    signal,
    5_000,
  );
  process.stdout.write(
    `${JSON.stringify({ tools: tools.map((item) => item.name), result })}\n`,
  );
} finally {
  await connection.close();
}
const revocation = await revokeMcpOAuthServer("fixture", {
  environment: process.env,
  kodaHome: home,
  processDirectory: home,
});
if (revocation !== "remote_revoked")
  throw new Error("Provider revocation failed.");
const vault = await readFile(`${home}/mcp-oauth/vault.json`, "utf8");
if (vault.includes("fixture-rotated-token"))
  throw new Error("Token leaked to vault file.");
try {
  const revoked = await connectOfficialMcpClient(
    server,
    process.env,
    signal,
    home,
  );
  await revoked.close();
  throw new Error("Revoked OAuth connection unexpectedly succeeded.");
} catch (error) {
  if (error?.message === "Revoked OAuth connection unexpectedly succeeded.")
    throw error;
}
