import { CredentialRecoveryUnavailableError } from "./provider-credentials";

export const UNSETTLED_SUBMISSION_STATUSES = [
  "processing",
  "admitted",
] as const;

export function isUnsettledSubmissionStatus(status: string): boolean {
  return (UNSETTLED_SUBMISSION_STATUSES as readonly string[]).includes(status);
}

export async function recoverUnsettledSubmissions<
  T extends { id: string; status: string },
>(
  submissions: readonly T[],
  prepare: (submission: T) => Promise<string>,
  fail: (
    submission: T,
    error: CredentialRecoveryUnavailableError,
  ) => Promise<void>,
): Promise<Map<string, string>> {
  const recovered = new Map<string, string>();
  for (const submission of submissions) {
    if (!isUnsettledSubmissionStatus(submission.status)) continue;
    try {
      recovered.set(submission.id, await prepare(submission));
    } catch (error) {
      if (!(error instanceof CredentialRecoveryUnavailableError)) throw error;
      await fail(submission, error);
    }
  }
  return recovered;
}
