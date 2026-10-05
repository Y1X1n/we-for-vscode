/**
 * Leveled logger over a VS Code log output channel.
 *
 * The level filtering mirrors upstream's `lib/log.js` three levels
 * (error/warn/info, default warn): the DSH plugin's reasoning was that info is
 * noisy enough to be opt-in, and that survives the port unchanged.
 */

import * as vscode from 'vscode';

export type Level = 'error' | 'warn' | 'info';

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2 };

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(private level: Level) {
    this.channel = vscode.window.createOutputChannel('Wallpaper Engine', { log: true });
  }

  setLevel(level: Level): void {
    this.level = level;
  }

  private emit(level: Level, message: string, args: unknown[]): void {
    if (ORDER[level] > ORDER[this.level]) return;
    const suffix = args.length
      ? ' ' +
        args
          .map((a) => {
            if (typeof a === 'string') return a;
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(' ')
      : '';
    this.channel[level](message + suffix);
  }

  info(message: string, ...args: unknown[]): void {
    this.emit('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.emit('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.emit('error', message, args);
  }

  /** The media server takes a plain callback so it stays free of the vscode import. */
  readonly logFn = (level: Level, message: string): void => this.emit(level, message, []);

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
