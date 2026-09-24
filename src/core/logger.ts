import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ValidationPoint = 'P1' | 'P2' | 'P3' | 'P4';
export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'UNVERIFIED' | 'INFO';

/** One explicit validation verdict. Never swallowed: always logged at a visible level. */
export interface ValidationCheck {
  point: ValidationPoint;
  name: string;
  status: CheckStatus;
  message: string;
  runLabel?: string;
  jobInstanceId?: string;
  /** Query activity the check applies to (Lookup1, Script1...), when relevant. */
  activity?: string;
  evidence?: unknown;
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  msg: string;
  context: Record<string, string>;
  data?: unknown;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

export class Logger {
  constructor(
    private readonly sinks: LogSink[],
    private readonly context: Record<string, string> = {},
  ) {}

  child(context: Record<string, string>): Logger {
    return new Logger(this.sinks, { ...this.context, ...context });
  }

  debug(event: string, msg: string, data?: unknown): void {
    this.emit('debug', event, msg, data);
  }
  info(event: string, msg: string, data?: unknown): void {
    this.emit('info', event, msg, data);
  }
  warn(event: string, msg: string, data?: unknown): void {
    this.emit('warn', event, msg, data);
  }
  error(event: string, msg: string, data?: unknown): void {
    this.emit('error', event, msg, data);
  }

  check(check: ValidationCheck): ValidationCheck {
    const level: LogLevel =
      check.status === 'FAIL'
        ? 'error'
        : check.status === 'PASS' || check.status === 'INFO'
          ? 'info'
          : 'warn';
    this.emit(
      level,
      `validation.${check.point}.${check.name}`,
      `[${check.point}][${check.status}] ${check.message}`,
      check.evidence,
    );
    return check;
  }

  private emit(level: LogLevel, event: string, msg: string, data?: unknown): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      msg,
      context: this.context,
      data,
    };
    for (const sink of this.sinks) {
      try {
        sink.write(entry);
      } catch {
        // A broken sink must not break the run.
      }
    }
  }
}

export function formatEntry(entry: LogEntry, withData = true): string {
  const ctx = Object.entries(entry.context)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  let line = `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} ${ctx ? `[${ctx}] ` : ''}${entry.event} — ${entry.msg}`;
  if (withData && entry.data !== undefined)
    line += `\n${indent(JSON.stringify(entry.data, null, 2))}`;
  return line;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

export class JsonlFileSink implements LogSink {
  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  write(entry: LogEntry): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export class ConsoleSink implements LogSink {
  constructor(private readonly minLevel: LogLevel = 'info') {}
  write(entry: LogEntry): void {
    if (LEVELS[entry.level] < LEVELS[this.minLevel]) return;
    const text = formatEntry(entry, entry.level !== 'debug');
    const color =
      entry.level === 'error'
        ? '\x1b[31m'
        : entry.level === 'warn'
          ? '\x1b[33m'
          : entry.event.startsWith('validation.')
            ? '\x1b[32m'
            : '';
    process.stdout.write(color ? `${color}${text}\x1b[0m\n` : `${text}\n`);
  }
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}
