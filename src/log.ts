/** Tiny structured-ish logger. */
function line(level: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  // eslint-disable-next-line no-console
  console.log(`${ts} ${level} ${msg}${suffix}`);
}

export const log = {
  info: (msg: string, extra?: unknown) => line("INFO", msg, extra),
  warn: (msg: string, extra?: unknown) => line("WARN", msg, extra),
  error: (msg: string, extra?: unknown) => line("ERROR", msg, extra),
};
