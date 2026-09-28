import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPortFile } from './paths';

/**
 * The Port_File records where the running daemon listens, as `{port}:{pid}`.
 * Older daemons wrote a bare `{port}`, so the pid is optional when reading.
 */
export interface PortFileInfo {
  port: number;
  pid?: number;
}

/** Parses Port_File content; returns undefined for anything malformed. */
export function parsePortFile(content: string): PortFileInfo | undefined {
  const match = /^(\d{1,5})(?::(\d{1,10}))?$/.exec(content.replace(/^﻿/, '').trim());
  if (!match) return undefined;

  const port = Number(match[1]);
  if (port < 1 || port > 65535) return undefined;

  const pid = match[2] === undefined ? undefined : Number(match[2]);
  return { port, pid: pid !== undefined && pid > 0 ? pid : undefined };
}

/** Reads and parses the Port_File. Never throws: unreadable counts as absent. */
export function readPortFile(file: string = getPortFile()): PortFileInfo | undefined {
  try {
    return parsePortFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Writes `{port}:{pid}` via a temp file + rename so concurrent readers (shell
 * hooks run on every command) never observe a half-written file.
 */
export function writePortFile(port: number, pid: number, file: string = getPortFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${port}:${pid}`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // Rename can fail on Windows if another process holds the file open.
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, `${port}:${pid}`, 'utf8');
  }
}

/**
 * Deletes the Port_File only if it still belongs to `pid`, so a daemon that is
 * shutting down never removes the registration of a newer daemon.
 */
export function removePortFileIfOwned(pid: number, file: string = getPortFile()): void {
  const info = readPortFile(file);
  if (info && info.pid !== undefined && info.pid !== pid) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone
  }
}

/** True if a process with this pid exists (EPERM means it exists but is not ours). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
