/**
 * Structured logger for `@ansible-lens/server`.
 *
 * Avoids raw `console.log` by routing log records through a pluggable sink
 * (LSP connection logger in production, or silent/captured sink in tests).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ServerLogSink {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ServerLogger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

function formatLogLine(
  level: LogLevel,
  component: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): string {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level.toUpperCase()}] [${component}] ${message}`;
  if (!context || Object.keys(context).length === 0) {
    return base;
  }
  return `${base} ${JSON.stringify(context)}`;
}

/**
 * Creates a structured server logger backed by the supplied `ServerLogSink`.
 */
export function createServerLogger(component: string, sink?: ServerLogSink): ServerLogger {
  const safeSink: ServerLogSink = sink ?? {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  return {
    debug(message, context) {
      safeSink.log(formatLogLine('debug', component, message, context));
    },
    info(message, context) {
      safeSink.log(formatLogLine('info', component, message, context));
    },
    warn(message, context) {
      safeSink.warn(formatLogLine('warn', component, message, context));
    },
    error(message, context) {
      safeSink.error(formatLogLine('error', component, message, context));
    },
  };
}
