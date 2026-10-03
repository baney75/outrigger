import { z } from 'zod';
export const draftSchema = z.object({
  text: z.string().max(100000),
  revision: z.string().uuid().optional(),
  uncertain: z.boolean().optional(),
  context: z
    .object({
      title: z.string().max(300),
      url: z.string().max(16000),
      selection: z.string().max(12000),
    })
    .optional(),
});
export type Draft = z.infer<typeof draftSchema>;
export interface DraftWrite {
  applied: boolean;
  value: Draft | null;
}
export function responseKey(environmentId: string, threadId: string, requestId: string) {
  return JSON.stringify([environmentId, threadId, requestId]);
}
