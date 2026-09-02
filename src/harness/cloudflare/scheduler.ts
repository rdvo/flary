import { z } from "zod";

export const ScheduleTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    slug: z.string().min(1),
    instanceId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("flow"),
    slug: z.string().min(1),
  }),
]);

export const ScheduledInvocationSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  appId: z.string().min(1),
  target: ScheduleTargetSchema,
  input: z.record(z.string(), z.unknown()).default({}),
  expression: z.string().min(1),
  timeZone: z.string().min(1).default("UTC"),
  nextRunAt: z.number().int().nonnegative(),
  enabled: z.boolean().default(true),
});

export type ScheduledInvocation = z.infer<typeof ScheduledInvocationSchema>;

export interface ScheduleClaim extends ScheduledInvocation {
  scheduledFor: number;
  idempotencyKey: string;
}

export interface ScheduleStore {
  listDue(now: number, limit: number): Promise<readonly ScheduledInvocation[]>;
  claim(scheduleId: string, scheduledFor: number, nextRunAt: number): Promise<boolean>;
}

export interface ScheduleDispatcher {
  dispatch(claim: ScheduleClaim): Promise<void>;
}

export type NextOccurrence = (expression: string, timeZone: string, after: number) => number;

export interface DispatchDueOptions {
  now?: number;
  limit?: number;
}

export interface DispatchDueResult {
  claimed: number;
  dispatched: number;
  failed: Array<{ scheduleId: string; error: unknown }>;
}

/**
 * Claims due schedules before dispatch. The store must make claim atomic.
 * The idempotency key makes at-least-once alarms safe for downstream runs.
 */
export async function dispatchDueSchedules(
  store: ScheduleStore,
  dispatcher: ScheduleDispatcher,
  nextOccurrence: NextOccurrence,
  options: DispatchDueOptions = {},
): Promise<DispatchDueResult> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 100;
  const due = await store.listDue(now, limit);
  const claims: ScheduleClaim[] = [];

  for (const raw of due) {
    const schedule = ScheduledInvocationSchema.parse(raw);
    if (!schedule.enabled || schedule.nextRunAt > now) continue;

    const scheduledFor = schedule.nextRunAt;
    const nextRunAt = nextOccurrence(schedule.expression, schedule.timeZone, scheduledFor);
    const claimed = await store.claim(schedule.id, scheduledFor, nextRunAt);
    if (!claimed) continue;

    claims.push({
      ...schedule,
      scheduledFor,
      idempotencyKey: `schedule:${schedule.id}:${scheduledFor}`,
    });
  }

  const results = await Promise.allSettled(claims.map((claim) => dispatcher.dispatch(claim)));
  const failed: DispatchDueResult["failed"] = [];

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failed.push({
        scheduleId: claims[index].id,
        error: result.reason,
      });
    }
  });

  return {
    claimed: claims.length,
    dispatched: claims.length - failed.length,
    failed,
  };
}
