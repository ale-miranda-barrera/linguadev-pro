import { z } from 'zod';

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().min(1).max(8000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatPresetSchema = z.enum(['general', 'english-tutor', 'aws-tutor', 'custom']);
export type ChatPreset = z.infer<typeof ChatPresetSchema>;

export const ChatRequestSchema = z.object({
  conversationId: z.string().min(1).max(128),
  preset: ChatPresetSchema.default('general'),
  systemOverride: z.string().max(4000).optional(),
  messages: z.array(ChatMessageSchema).min(1).max(60),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatTitleRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(6),
});
export const ChatTitleResponseSchema = z.object({
  title: z.string().min(1).max(80),
});
export type ChatTitleRequest = z.infer<typeof ChatTitleRequestSchema>;
export type ChatTitleResponse = z.infer<typeof ChatTitleResponseSchema>;

export const AiStatusResponseSchema = z.object({
  configured: z.boolean(),
  provider: z.enum(['anthropic', 'openai', 'deepseek', 'bedrock', 'unavailable']),
  model: z.string().nullable(),
});
export type AiStatusResponse = z.infer<typeof AiStatusResponseSchema>;
