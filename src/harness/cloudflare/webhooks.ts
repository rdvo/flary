import { z } from "zod";

export const VerifiedChannelEventSchema = z.object({
  provider: z.string().min(1),
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  tenantId: z.string().min(1),
  appId: z.string().min(1),
  receivedAt: z.number().int().nonnegative(),
  payload: z.unknown(),
});

export type VerifiedChannelEvent = z.infer<typeof VerifiedChannelEventSchema>;

export interface ChannelReceiptStore {
  /**
   * Returns true only for the first claim for this provider event.
   */
  claim(provider: string, eventId: string, receivedAt: number): Promise<boolean>;
}

export interface ChannelEventDispatcher {
  dispatch(event: VerifiedChannelEvent, idempotencyKey: string): Promise<void>;
}

export type ChannelIngestResult = "accepted" | "duplicate";

/**
 * Accepts only verified, normalized events. Signature checks stay in the
 * provider channel before this function is called.
 */
export async function ingestVerifiedChannelEvent(
  input: unknown,
  receipts: ChannelReceiptStore,
  dispatcher: ChannelEventDispatcher,
): Promise<ChannelIngestResult> {
  const event = VerifiedChannelEventSchema.parse(input);
  const claimed = await receipts.claim(event.provider, event.eventId, event.receivedAt);

  if (!claimed) return "duplicate";

  await dispatcher.dispatch(event, `channel:${event.provider}:${event.eventId}`);
  return "accepted";
}
