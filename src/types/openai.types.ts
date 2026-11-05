import type OpenAI from 'openai';

// Chat Completion Request
export type ChatCompletionRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParams;

// Chat Completion Response
export type ChatCompletionResponse = OpenAI.Chat.Completions.ChatCompletion;

// Streaming
export type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

// Messages
export type ChatCompletionMessage =
  OpenAI.Chat.Completions.ChatCompletionMessage;
export type ChatCompletionMessageParam =
  OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatCompletionRole = OpenAI.Chat.Completions.ChatCompletionRole;

// System/User/Assistant message params
export type ChatCompletionSystemMessageParam =
  OpenAI.Chat.Completions.ChatCompletionSystemMessageParam;
export type ChatCompletionUserMessageParam =
  OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
export type ChatCompletionAssistantMessageParam =
  OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
export type ChatCompletionToolMessageParam =
  OpenAI.Chat.Completions.ChatCompletionToolMessageParam;

// Tools / Function calling
export type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;
export type ChatCompletionToolChoiceOption =
  OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;

// Choice
export type ChatCompletionChoice = ChatCompletionResponse['choices'][number];
export type ChatCompletionChunkChoice =
  ChatCompletionChunk['choices'][number];

// Usage
export type CompletionUsage = OpenAI.Completions.CompletionUsage;

/**
 * DeepSeek-style usage extension: OpenAI-compatible upstreams that report
 * prompt-cache hits as top-level fields instead of `prompt_tokens_details`
 * (https://api-docs.deepseek.com "KV Cache"). Only the hit count is mapped
 * into canonical usage; `prompt_cache_miss_tokens` stays a wire field.
 */
export interface OpenAICompatibleUsage extends CompletionUsage {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}
