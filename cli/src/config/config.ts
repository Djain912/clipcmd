import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigFile } from './paths';

export interface ClipCmdConfig {
  port: number;
  ringBufferSize: number;
  /** Upper bound on captured output kept per block; older bytes are dropped. */
  maxOutputBytes: number;
  /**
   * How buttons open: 'clipcmd' links (silent, needs the handler `clipcmd init`
   * registers on Windows), 'http' links (open a browser tab), or 'auto'.
   */
  links: 'auto' | 'clipcmd' | 'http';
  /**
   * Start interactive PowerShell sessions inside `clipcmd shell` so command
   * output can be copied (not in VS Code, whose extension captures output).
   */
  autoShell: boolean;
  /**
   * Confirm each click: a "Copied" tag next to the mouse pointer on Windows,
   * a notification on macOS and Linux.
   */
  copyFeedback: boolean;
}

export const DEFAULT_CONFIG: ClipCmdConfig = {
  port: 9666,
  ringBufferSize: 200,
  maxOutputBytes: 1024 * 1024,
  links: 'auto',
  autoShell: true,
  copyFeedback: true,
};

type Rule =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' };

const RULES: Record<keyof ClipCmdConfig, Rule> = {
  port: { kind: 'int', min: 1, max: 65535 },
  ringBufferSize: { kind: 'int', min: 1, max: 10000 },
  maxOutputBytes: { kind: 'int', min: 0, max: 64 * 1024 * 1024 },
  links: { kind: 'enum', values: ['auto', 'clipcmd', 'http'] },
  autoShell: { kind: 'bool' },
  copyFeedback: { kind: 'bool' },
};

function isValid(rule: Rule, value: unknown): boolean {
  switch (rule.kind) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= rule.min && value <= rule.max;
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value);
    case 'bool':
      return typeof value === 'boolean';
  }
}

function describe(rule: Rule): string {
  switch (rule.kind) {
    case 'int':
      return `an integer from ${rule.min} to ${rule.max}`;
    case 'enum':
      return `one of ${rule.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'bool':
      return 'true or false';
  }
}

/**
 * Merges a parsed JSON value over the defaults, keeping only keys whose values
 * are valid. Anything else (wrong type, out of range, non-object JSON) falls
 * back to the default for that key so a partly broken config file can never
 * crash the daemon.
 */
export function normalizeConfig(
  raw: unknown,
  onWarning: (message: string) => void = () => {}
): ClipCmdConfig {
  const config: ClipCmdConfig = { ...DEFAULT_CONFIG };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    onWarning('Config file does not contain a JSON object; using defaults');
    return config;
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(RULES) as (keyof ClipCmdConfig)[]) {
    if (!(key in record)) continue;
    const value = record[key];
    const rule = RULES[key];
    if (isValid(rule, value)) {
      (config as unknown as Record<string, unknown>)[key] = value;
    } else {
      onWarning(
        `Ignoring invalid config value ${key}=${JSON.stringify(value)} ` +
          `(expected ${describe(rule)}); using ${JSON.stringify(DEFAULT_CONFIG[key])}`
      );
    }
  }

  return config;
}

export const ConfigManager = {
  /**
   * Reads ~/.config/clipcmd/config.json and returns the validated config.
   * Falls back to defaults when the file is missing, is not valid JSON, or
   * contains invalid values. Never throws to the caller.
   */
  load(onWarning?: (message: string) => void): ClipCmdConfig {
    let raw: string;
    try {
      raw = fs.readFileSync(getConfigFile(), 'utf8');
    } catch {
      return { ...DEFAULT_CONFIG };
    }

    try {
      // Strip a UTF-8 BOM, which some Windows editors add
      return normalizeConfig(JSON.parse(raw.replace(/^﻿/, '')), onWarning);
    } catch {
      onWarning?.('Config file is not valid JSON; using defaults');
      return { ...DEFAULT_CONFIG };
    }
  },

  /**
   * Writes the given config to ~/.config/clipcmd/config.json as formatted JSON.
   * Creates the directory if it does not already exist.
   */
  save(config: ClipCmdConfig): void {
    const file = getConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  },
};
