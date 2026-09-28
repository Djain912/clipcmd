import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigDir } from '../config/paths';

/**
 * Windows Terminal (1.24+) asks for confirmation before opening links with
 * a non-web scheme unless the scheme is listed in the global
 * `safeUriSchemes` setting. We add "clipcmd" so copy buttons work in one
 * click. settings.json is JSON with comments, so it is edited as text and the
 * result is validated before anything is written.
 */

/** settings.json of every installed Windows Terminal flavour (stable, preview, unpackaged). */
export function findWindowsTerminalSettings(localAppData = process.env.LOCALAPPDATA): string[] {
  if (!localAppData) return [];
  const candidates = [
    path.join(localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(localAppData, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(localAppData, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
  return candidates.filter((file) => fs.existsSync(file));
}

/** Removes // and /* *\/ comments outside strings, and trailing commas, so JSON.parse accepts it. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, ''));
}

function schemesOf(settings: unknown): string[] | undefined {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return undefined;
  const value = (settings as Record<string, unknown>).safeUriSchemes;
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : undefined;
}

function schemesOfText(text: string): string[] | undefined {
  try {
    return schemesOf(parseJsonc(text));
  } catch {
    return undefined;
  }
}

/**
 * Pure transform: returns settings text with `scheme` in safeUriSchemes, the
 * same text if already present, or undefined if the file could not be
 * edited safely.
 */
export function withSafeUriScheme(text: string, scheme: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  if (schemesOf(parsed)?.includes(scheme)) return text;

  let edited: string;
  const existing = /("safeUriSchemes"\s*:\s*\[)(\s*)([^\]]*?)(\s*\])/.exec(text);
  if (existing && schemesOf(parsed) !== undefined) {
    const [whole, open, space, items, close] = existing;
    const entries = items.trim() === '' ? `"${scheme}"` : `${items.trimEnd()}, "${scheme}"`;
    edited = text.replace(whole, `${open}${space}${entries}${close}`);
  } else if ('safeUriSchemes' in (parsed as object)) {
    return undefined; // present but not a simple array: leave it to the user
  } else {
    const brace = text.indexOf('{');
    const rest = text.slice(brace + 1);
    const isEmpty = /^\s*}/.test(rest);
    const indent = /\n([ \t]+)"/.exec(rest)?.[1] ?? '    ';
    edited = `${text.slice(0, brace + 1)}\n${indent}"safeUriSchemes": ["${scheme}"]${isEmpty ? '\n' : ','}${rest}`;
  }

  try {
    const check = parseJsonc(edited);
    return schemesOf(check)?.includes(scheme) ? edited : undefined;
  } catch {
    return undefined;
  }
}

/** Pure transform: removes `scheme` from safeUriSchemes (undefined if nothing to do or unsafe). */
export function withoutSafeUriScheme(text: string, scheme: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return undefined;
  }
  if (!schemesOf(parsed)?.includes(scheme)) return undefined;
  const quoted = `"${scheme}"`;
  let edited = text
    .replace(new RegExp(`(\\[[^\\]]*?)\\s*,\\s*${quoted}`), '$1')
    .replace(new RegExp(`(\\[\\s*)${quoted}\\s*,?\\s*`), '$1');
  // An empty list means the same as no setting: drop the key (restores the file as it was)
  if (schemesOfText(edited)?.length === 0) {
    const withoutKey = edited
      .replace(/\r?\n[ \t]*"safeUriSchemes"\s*:\s*\[\s*\],/, '')
      .replace(/,\s*"safeUriSchemes"\s*:\s*\[\s*\]/, '')
      .replace(/"safeUriSchemes"\s*:\s*\[\s*\]/, '');
    if (schemesOfText(withoutKey) === undefined) edited = withoutKey;
  }
  try {
    return schemesOf(parseJsonc(edited))?.includes(scheme) ? undefined : edited;
  } catch {
    return undefined;
  }
}

export type TerminalEditResult = { file: string; status: 'added' | 'present' | 'failed' };

/**
 * Adds the scheme to every Windows Terminal settings file, keeping a backup
 * of each original in ~/.config/clipcmd/backups/.
 */
export function allowSchemeInWindowsTerminal(scheme: string, files = findWindowsTerminalSettings()): TerminalEditResult[] {
  return files.map((file) => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { file, status: 'failed' as const };
    }
    const edited = withSafeUriScheme(text, scheme);
    if (edited === undefined) return { file, status: 'failed' as const };
    if (edited === text) return { file, status: 'present' as const };

    const backupDir = path.join(getConfigDir(), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const flavour = path.basename(path.dirname(path.dirname(file))).replace(/[^A-Za-z0-9._-]/g, '_');
    fs.writeFileSync(path.join(backupDir, `windows-terminal-${flavour}-settings.json`), text, 'utf8');
    fs.writeFileSync(file, edited, 'utf8');
    return { file, status: 'added' as const };
  });
}

/** Undoes allowSchemeInWindowsTerminal. */
export function disallowSchemeInWindowsTerminal(scheme: string, files = findWindowsTerminalSettings()): void {
  for (const file of files) {
    try {
      const edited = withoutSafeUriScheme(fs.readFileSync(file, 'utf8'), scheme);
      if (edited !== undefined) fs.writeFileSync(file, edited, 'utf8');
    } catch {
      // leave the file alone
    }
  }
}
