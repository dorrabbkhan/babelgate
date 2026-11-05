import type Anthropic from '@anthropic-ai/sdk';

// Message Request
export type MessageCreateParams = Anthropic.MessageCreateParams;
export type MessageCreateParamsNonStreaming =
  Anthropic.MessageCreateParamsNonStreaming;
export type MessageCreateParamsStreaming =
  Anthropic.MessageCreateParamsStreaming;

// Message Response
export type Message = Anthropic.Message;

// Streaming
export type MessageStreamEvent = Anthropic.MessageStreamEvent;
export type ContentBlockDeltaEvent = Anthropic.ContentBlockDeltaEvent;
export type MessageDeltaEvent = Anthropic.MessageDeltaEvent;

// Content blocks
export type ContentBlock = Anthropic.ContentBlock;
export type ContentBlockParam = Anthropic.ContentBlockParam;
export type TextBlock = Anthropic.TextBlock;
export type ToolUseBlock = Anthropic.ToolUseBlock;

// Message params
export type MessageParam = Anthropic.MessageParam;
export type TextBlockParam = Anthropic.TextBlockParam;
export type ImageBlockParam = Anthropic.ImageBlockParam;
export type ToolUseBlockParam = Anthropic.ToolUseBlockParam;
export type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

// Tools
export type Tool = Anthropic.Tool;
export type ToolUnion = Anthropic.ToolUnion;
export type ToolChoice = Anthropic.ToolChoice;

// Prompt caching
export type CacheControlEphemeral = Anthropic.CacheControlEphemeral;

// Usage
export type Usage = Anthropic.Usage;

// Role
export type MessageRole = 'user' | 'assistant';
