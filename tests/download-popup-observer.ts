interface Connection {
  readonly closed: boolean;
  close(): void;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
}
interface ObserverOptions {
  connection: Connection;
  recover(): Promise<Connection>;
  isAlive(): boolean;
  diagnostics: { errorCount: number; errors: string[] };
  onError(): Promise<void>;
  delay(): Promise<void>;
}

// Read-only calls may recover their observer; download-start must never use this retry path.
export function createPopupObserver(options: ObserverOptions) {
  let connection: Connection | undefined = options.connection;
  const assertAlive = () => {
    if (!options.isAlive()) throw Error('Owned browser closed; download outcome is unobserved');
  };
  const record = async (error: unknown) => {
    options.diagnostics.errorCount++;
    options.diagnostics.errors.push(String(error).slice(0, 1000));
    options.diagnostics.errors.splice(0, Math.max(0, options.diagnostics.errors.length - 20));
    await options.onError();
  };
  return { async evaluate(fn: unknown, arg?: unknown) {
    for (;;) {
      assertAlive();
      if (!connection) {
        try { connection = await options.recover(); }
        catch (error) { assertAlive(); await record(error); await options.delay(); continue; }
      }
      try {
        if (connection.closed) throw Error('target closed');
        return await connection.evaluate(fn, arg);
      } catch (error) {
        assertAlive();
        if (!connection.closed && !/^(?:Error: )?(?:target closed|CDP timeout)/.test(String(error))) throw error;
        connection.close(); connection = undefined;
        await record(error); await options.delay();
      }
    }
  } };
}
