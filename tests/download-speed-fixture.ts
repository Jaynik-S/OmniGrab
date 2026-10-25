import assert from 'node:assert/strict';

/** Representative bounded object sizes, repeated in the same playlist order for each run. */
export function windowFixture(origin: string) {
  const sizes = [524288, 2474065, 3311316, 6360152];
  const resources = Array.from({ length: 32 }, (_, index) => ({ url: `${origin}/window-${index}.bin?size=${sizes[index % sizes.length]}` }));
  const expectedBytes = Array.from({ length: 32 }, (_, index) => sizes[index % sizes.length]!).reduce((sum, size) => sum + size, 0);
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' + resources.map(({ url }) => `#EXTINF:4,\n${url}`).join('\n') + '\n#EXT-X-ENDLIST';
  return { resources, expectedBytes, text };
}

export function verifySavedReceipt(receipt: { chromeState: string; actualBytes: number; expectedBytes: number; maximumActive: number }) {
  assert.equal(receipt.chromeState, 'complete');
  assert.equal(receipt.actualBytes, receipt.expectedBytes);
  assert.ok(receipt.maximumActive <= 4, 'physical fetch bound');
}
