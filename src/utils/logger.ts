import pino from 'pino';
import pretty from 'pino-pretty';
import { createPinoSink, loadPersistedEntries } from './log-buffer.js';

let logger: pino.Logger | null = null;

export function createLogger(level: string = 'info'): pino.Logger {
  if (logger) return logger;

  // Load any warnings from prior runs so the System page shows them
  // immediately on first paint after a restart.
  loadPersistedEntries();

  // Pretty-printed human-readable stream for stdout (what `docker logs`
  // shows). Same options the previous transport-based setup used.
  const prettyStream = pretty({
    colorize: true,
    translateTime: 'SYS:HH:MM:ss',
    ignore: 'pid,hostname',
  });

  // Multistream lets us tee logs to multiple destinations with
  // per-destination level filters. Stdout gets everything at the
  // configured level; the in-app warning buffer only gets warn+.
  const streams: pino.StreamEntry[] = [
    { stream: prettyStream as unknown as NodeJS.WritableStream },
    { level: 'warn', stream: createPinoSink() },
  ];

  logger = pino({ level }, pino.multistream(streams));

  return logger;
}

export function getLogger(): pino.Logger {
  return logger ?? createLogger();
}

export function childLogger(module: string): pino.Logger {
  return getLogger().child({ module });
}
