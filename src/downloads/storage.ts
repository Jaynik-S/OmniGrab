/** Fixed diagnostics only: platform and library errors can contain private source URLs. */
const messages = {
  'download-storage-insufficient': 'Estimated browser storage is too low for temporary and saved copies. Free space and retry.',
  'download-storage-budget-unknown': 'This source does not declare enough size information for a storage check.',
  'download-storage-estimate-unavailable': 'Browser storage capacity could not be estimated. Retry when storage is available.',
  'download-storage-quota-exceeded': 'Browser storage quota was exceeded. Free space and retry.',
  'download-storage-write-failed': 'The temporary output could not be written. Check disk space and retry.',
} as const;
export function safeStorageCode(value: unknown): keyof typeof messages | undefined {
  return typeof value === 'string' && Object.hasOwn(messages, value) ? value as keyof typeof messages : undefined;
}
export function storageFailureMessage(code: string): string | undefined {
  const safe = safeStorageCode(code); return safe ? messages[safe] : undefined;
}
/** Use only at an actual filesystem IO boundary, never around arbitrary remux/network work. */
export function storageIoError(error: unknown): Error {
  return Error(error instanceof Error && error.name === 'QuotaExceededError' ?
    'download-storage-quota-exceeded' : 'download-storage-write-failed');
}
/** Approximate origin quota only; does not measure free physical disk or the Downloads volume. */
export async function checkStorageBudget(mediaBytes: number | undefined, estimate: () => Promise<StorageEstimate>): Promise<void> {
  const budget = Math.ceil((mediaBytes ?? NaN) * 2.5) + 16 * 1024 * 1024;
  if (!Number.isSafeInteger(mediaBytes) || mediaBytes! <= 0 || !Number.isSafeInteger(budget))
    throw Error('download-storage-budget-unknown');
  let capacity: StorageEstimate;
  try { capacity = await estimate(); } catch { throw Error('download-storage-estimate-unavailable'); }
  const { quota, usage } = capacity ?? {};
  if (!Number.isSafeInteger(quota) || quota! < 0 || !Number.isSafeInteger(usage) || usage! < 0)
    throw Error('download-storage-estimate-unavailable');
  if (quota! - usage! < budget) throw Error('download-storage-insufficient');
}
