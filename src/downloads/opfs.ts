import type { SeekableOutput } from './model.ts';

/** The native synchronous OPFS handle is available in a dedicated worker. */
export interface OpfsAccessHandle {
  write(data: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}

export class OpfsOutput implements SeekableOutput {
  private closed = false;
  private readonly handle: OpfsAccessHandle;
  constructor(handle: OpfsAccessHandle) { this.handle = handle; }

  async write(data: Uint8Array, position: number): Promise<void> {
    if (this.closed) throw new Error('OPFS output is closed');
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(position + data.length))
      throw new Error('Invalid output position');
    let written = 0;
    while (written < data.length) {
      const count = this.handle.write(data.subarray(written), { at: position + written });
      if (!Number.isSafeInteger(count) || count <= 0 || count > data.length - written)
        throw new Error('OPFS write made invalid progress');
      written += count;
    }
  }

  async flush(): Promise<void> {
    if (this.closed) throw new Error('OPFS output is closed');
    this.handle.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handle.close();
  }
}

/** Creates a fresh temporary file; callers may getFile only after the engine closes it. */
export async function createOpfsOutput(directory: FileSystemDirectoryHandle, filename: string): Promise<OpfsOutput> {
  if (!filename || filename === '.' || filename === '..' || /[\\/\x00]/.test(filename))
    throw new Error('Invalid OPFS filename');
  const file = await directory.getFileHandle(filename, { create: true });
  // TS's window DOM declarations omit the worker-only synchronous API.
  const handle = await (file as FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<OpfsAccessHandle & { truncate(size: number): void }>;
  }).createSyncAccessHandle();
  try { handle.truncate(0); return new OpfsOutput(handle); }
  catch (error) { handle.close(); throw error; }
}
