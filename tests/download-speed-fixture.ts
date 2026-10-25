import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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

/** FFmpeg may interleave decoded audio/video records differently between identical inputs. */
export async function digestFrameRecords(lines: Iterable<string> | AsyncIterable<string>) {
  const timebases = new Map<string, string>();
  const streams = new Map<string, { records: number; hash: ReturnType<typeof createHash> }>();
  for await (const line of lines) {
    const header = /^#tb (\d+):\s*(\S+)/.exec(line);
    if (header) timebases.set(header[1]!, header[2]!);
    if (!line.trim() || line.startsWith('#')) continue;
    const id = /^(\d+),/.exec(line)?.[1]; assert.ok(id, 'invalid framehash record');
    let stream = streams.get(id);
    if (!stream) { stream = { records: 0, hash: createHash('sha256') }; streams.set(id, stream); }
    stream.records++; stream.hash.update(line.trim() + '\n');
  }
  return Object.fromEntries([...streams].map(([id, stream]) => {
    const timebase = timebases.get(id); assert.ok(timebase, 'missing framehash timebase');
    return [id, { timebase, records: stream.records, sha256: stream.hash.digest('hex') }];
  }));
}
