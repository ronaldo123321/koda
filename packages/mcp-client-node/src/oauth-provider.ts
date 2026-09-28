import { randomBytes, timingSafeEqual } from "node:crypto";

import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import { McpOAuthVault } from "./oauth-vault.js";

const pendingSchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    redirectUrl: z.url(),
    createdAt: z.number().int(),
    codeVerifier: z.string().optional(),
  })
  .strict();
const storedSchema = z
  .object({
    version: z.literal(1),
    clients: z.record(z.string(), z.unknown()),
    tokens: z.record(z.string(), z.unknown()),
    lastIssuer: z.string().optional(),
    pending: pendingSchema.optional(),
    discovery: z.unknown().optional(),
  })
  .strict();

type StoredState = z.infer<typeof storedSchema>;

export class McpOAuthProvider implements OAuthClientProvider {
  public constructor(
    private readonly vault: McpOAuthVault,
    private readonly serverId: string,
    private readonly endpoint: string,
    public readonly redirectUrl: string,
    private readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>,
    private readonly preRegisteredClientId?: string,
  ) {
    const redirect = new URL(redirectUrl);
    if (
      redirect.protocol !== "http:" ||
      redirect.hostname !== "127.0.0.1" ||
      Number(redirect.port) < 1_024 ||
      Number(redirect.port) > 65_535 ||
      redirect.username !== "" ||
      redirect.password !== "" ||
      redirect.search !== "" ||
      redirect.hash !== "" ||
      redirect.pathname !== "/callback"
    ) {
      throw new Error("MCP OAuth redirect must be a loopback /callback URL.");
    }
  }

  public get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Koda",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  public async state(): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    await this.change((stored) => {
      stored.pending = {
        state,
        redirectUrl: this.redirectUrl,
        createdAt: Date.now(),
      };
    });
    return state;
  }

  public async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    if (context === undefined) return undefined;
    const saved = (await this.read()).clients[context.issuer] as
      StoredOAuthClientInformation | undefined;
    return (
      saved ??
      (this.preRegisteredClientId === undefined
        ? undefined
        : { client_id: this.preRegisteredClientId, issuer: context.issuer })
    );
  }

  public async saveClientInformation(
    information: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = requireIssuer(context?.issuer ?? information.issuer);
    await this.change((stored) => {
      stored.clients[issuer] = information;
    });
  }

  public async tokens(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthTokens | undefined> {
    const stored = await this.read();
    const issuer = context?.issuer ?? stored.lastIssuer;
    return issuer === undefined
      ? undefined
      : (stored.tokens[issuer] as StoredOAuthTokens | undefined);
  }

  public async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = requireIssuer(context?.issuer ?? tokens.issuer);
    await this.change((stored) => {
      stored.tokens[issuer] = tokens;
      stored.lastIssuer = issuer;
    });
  }

  public async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.change((stored) => {
      const pending = this.validPending(stored);
      stored.pending = { ...pending, codeVerifier };
    });
  }

  public async codeVerifier(): Promise<string> {
    const verifier = this.validPending(await this.read()).codeVerifier;
    if (verifier === undefined)
      throw new Error("MCP OAuth verifier is unavailable.");
    return verifier;
  }

  public async redirectToAuthorization(url: URL): Promise<void> {
    const pending = this.validPending(await this.read());
    if (
      url.protocol !== "https:" ||
      !sameSecret(url.searchParams.get("state"), pending.state) ||
      url.searchParams.get("redirect_uri") !== this.redirectUrl
    ) {
      throw new Error("MCP OAuth authorization URL is invalid.");
    }
    if (this.onAuthorizationUrl === undefined) {
      throw new Error("MCP OAuth requires owner-local authorization.");
    }
    await this.onAuthorizationUrl(url);
  }

  public async verifyCallback(state: string): Promise<void> {
    const pending = this.validPending(await this.read());
    if (
      !sameSecret(state, pending.state) ||
      pending.codeVerifier === undefined
    ) {
      throw new Error(
        "MCP OAuth callback does not match the pending authorization.",
      );
    }
  }

  public async clearPending(): Promise<void> {
    await this.change((stored) => {
      delete stored.pending;
    });
  }

  public async saveDiscoveryState(
    discovery: OAuthDiscoveryState,
  ): Promise<void> {
    await this.change((stored) => {
      stored.discovery = discovery;
    });
  }

  public async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discovery as OAuthDiscoveryState | undefined;
  }

  public async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      await this.vault.remove(this.serverId, this.endpoint);
      return;
    }
    await this.change((stored) => {
      if (scope === "client") stored.clients = {};
      if (scope === "tokens") {
        stored.tokens = {};
        delete stored.lastIssuer;
      }
      if (scope === "verifier") delete stored.pending;
      if (scope === "discovery") delete stored.discovery;
    });
  }

  private validPending(
    stored: StoredState,
  ): NonNullable<StoredState["pending"]> {
    const pending = stored.pending;
    if (
      pending === undefined ||
      pending.redirectUrl !== this.redirectUrl ||
      Date.now() - pending.createdAt > 10 * 60_000 ||
      pending.createdAt > Date.now() + 60_000
    ) {
      throw new Error("MCP OAuth authorization has expired or changed.");
    }
    return pending;
  }

  private async read(): Promise<StoredState> {
    const state = await this.vault.load(this.serverId, this.endpoint);
    return state === undefined
      ? { version: 1, clients: {}, tokens: {} }
      : storedSchema.parse(state);
  }

  private async change(edit: (stored: StoredState) => void): Promise<void> {
    await this.vault.update(this.serverId, this.endpoint, (current) => {
      const stored =
        current === undefined
          ? { version: 1 as const, clients: {}, tokens: {} }
          : storedSchema.parse(current);
      edit(stored);
      return storedSchema.parse(stored);
    });
  }
}

function requireIssuer(value: string | undefined): string {
  if (value === undefined || new URL(value).protocol !== "https:") {
    throw new Error("MCP OAuth issuer is invalid.");
  }
  return value;
}

function sameSecret(left: string | null, right: string): boolean {
  if (left === null) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
