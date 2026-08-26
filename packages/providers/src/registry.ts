import type { ModelProvider } from "@koda/agent-core";
import {
  modelProviderIdSchema,
  providerMetadataSchema,
  type ModelProviderId,
  type ProviderMetadata,
  type JsonObject,
} from "@koda/protocol";

import { createAnthropicMessagesProvider } from "./anthropic-messages.js";
import {
  createOpenAICompatibleChatProvider,
  type OpenAICompatibleProfile,
} from "./openai-compatible-chat.js";
import { createOpenAIResponsesProvider } from "./openai-responses.js";

export interface BuiltInProviderProfile extends ProviderMetadata {
  protocol: "openai-responses" | "anthropic-messages" | "openai-chat";
  baseURL?: string;
  requestExtensions?: JsonObject;
}

export interface CreateRegisteredProviderOptions {
  provider: ModelProviderId;
  apiKey: string;
  model: string;
  instructions: string;
  maxOutputTokens: number;
}

const profiles = Object.freeze({
  openai: Object.freeze({
    id: "openai",
    displayName: "OpenAI",
    credentialEnvironmentVariable: "OPENAI_API_KEY",
    defaultModel: "gpt-5.6-terra",
    protocol: "openai-responses",
  }),
  anthropic: Object.freeze({
    id: "anthropic",
    displayName: "Anthropic",
    credentialEnvironmentVariable: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
    protocol: "anthropic-messages",
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    displayName: "DeepSeek",
    credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-pro",
    protocol: "openai-chat",
    baseURL: "https://api.deepseek.com",
  }),
  kimi: Object.freeze({
    id: "kimi",
    displayName: "Kimi",
    credentialEnvironmentVariable: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2.6",
    protocol: "openai-chat",
    baseURL: "https://api.moonshot.cn/v1",
    requestExtensions: Object.freeze({
      thinking: Object.freeze({ type: "enabled" }),
    }),
  }),
  glm: Object.freeze({
    id: "glm",
    displayName: "GLM",
    credentialEnvironmentVariable: "ZAI_API_KEY",
    defaultModel: "glm-5.2",
    protocol: "openai-chat",
    baseURL: "https://open.bigmodel.cn/api/paas/v4/",
    requestExtensions: Object.freeze({
      thinking: Object.freeze({ type: "enabled" }),
    }),
  }),
} as const satisfies Record<ModelProviderId, BuiltInProviderProfile>);

export const BUILT_IN_PROVIDER_IDS = modelProviderIdSchema.options;

export const BUILT_IN_PROVIDER_METADATA: readonly ProviderMetadata[] =
  Object.freeze(
    BUILT_IN_PROVIDER_IDS.map((id) =>
      Object.freeze(
        providerMetadataSchema.parse({
          id,
          displayName: profiles[id].displayName,
          credentialEnvironmentVariable:
            profiles[id].credentialEnvironmentVariable,
          defaultModel: profiles[id].defaultModel,
        }),
      ),
    ),
  );

export function getBuiltInProviderProfile(
  provider: ModelProviderId,
): BuiltInProviderProfile {
  return profiles[provider];
}

export function createRegisteredProvider(
  options: CreateRegisteredProviderOptions,
): ModelProvider {
  const profile = getBuiltInProviderProfile(options.provider);
  if (profile.protocol === "openai-responses") {
    return createOpenAIResponsesProvider({
      apiKey: options.apiKey,
      model: options.model,
      instructions: options.instructions,
      reasoningEffort: "medium",
      maxOutputTokens: options.maxOutputTokens,
    });
  }
  if (profile.protocol === "anthropic-messages") {
    return createAnthropicMessagesProvider({
      apiKey: options.apiKey,
      model: options.model,
      instructions: options.instructions,
      maxOutputTokens: options.maxOutputTokens,
    });
  }
  if (profile.baseURL === undefined) {
    throw new Error(`Provider '${profile.id}' has no configured base URL.`);
  }
  const compatibleProfile: OpenAICompatibleProfile = {
    id: profile.id as OpenAICompatibleProfile["id"],
    displayName: profile.displayName,
    baseURL: profile.baseURL,
    ...(profile.requestExtensions === undefined
      ? {}
      : { requestExtensions: profile.requestExtensions }),
  };
  return createOpenAICompatibleChatProvider({
    apiKey: options.apiKey,
    profile: compatibleProfile,
    model: options.model,
    instructions: options.instructions,
    maxOutputTokens: options.maxOutputTokens,
  });
}
