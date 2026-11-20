/**
 * Structured logger for the Ansible Lens VS Code client.
 * Routes all log lines to a VS Code OutputChannel (or pluggable sink in tests)
 * with zero raw `console.log` calls.
 */

export interface OutputChannelLike {
  appendLine(value: string): void;
}

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ClientLogger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

function formatEntry(
  level: ClientLogLevel,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] [client] ${message}`;
  if (!context || Object.keys(context).length === 0) {
    return base;
  }
  return `${base} ${JSON.stringify(context)}`;
}

/**
 * Creates a structured client logger writing to the given OutputChannel.
 */
export function createClientLogger(channel: OutputChannelLike): ClientLogger {
  return {
    debug(message, context) {
      channel.appendLine(formatEntry('debug', message, context));
    },
    info(message, context) {
      channel.appendLine(formatEntry('info', message, context));
    },
    warn(message, context) {
      channel.appendLine(formatEntry('warn', message, context));
    },
    error(message, context) {
      channel.appendLine(formatEntry('error', message, context));
    },
  };
}
