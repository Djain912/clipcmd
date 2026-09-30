import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { getConfigDir } from '../config/paths';

/**
 * "Copied" confirmation after a button click.
 *
 * Windows: a small tag next to the mouse pointer ("✓ Copied command") that
 * fades out after about a second. It never takes focus, lets clicks through,
 * and unlike a notification it shows while Do Not Disturb is on. It is a tiny
 * WinForms program, compiled once with the C# compiler that ships with
 * Windows (.NET Framework 4), so it starts in a fraction of a second.
 * macOS and Linux: a desktop notification (osascript, notify-send).
 */

/** Source of the Windows tag program (C# 5: what .NET Framework's csc.exe accepts). */
export const COPIED_TAG_SOURCE = `// clipcmd copy confirmation: a small "Copied" tag next to the mouse pointer.
// It never takes focus, lets clicks through, and closes itself after ~1.5 s.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class Program
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static int Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }
        bool measure = args.Length > 0 && args[0] == "--measure";
        string text = args.Length > (measure ? 1 : 0) ? args[measure ? 1 : 0] : "";
        if (text.Length == 0) text = "Copied";
        if (text.Length > 80) text = text.Substring(0, 80);
        Application.EnableVisualStyles();
        Tag tag = new Tag(text);
        if (measure)
        {
            // For tests: lay the tag out without showing it
            Console.WriteLine(tag.Width + "x" + tag.Height);
            return 0;
        }
        Application.Run(tag);
        return 0;
    }
}

class Tag : Form
{
    const int WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000;
    const int FADE_IN_MS = 120, HOLD_MS = 1100, FADE_OUT_MS = 300;
    const double MAX_OPACITY = 0.96;

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    readonly string text;
    readonly Font font;
    readonly float scale;
    readonly Stopwatch clock = new Stopwatch();
    readonly Timer timer = new Timer();

    public Tag(string text)
    {
        this.text = text;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(32, 34, 37);
        ForeColor = Color.White;
        DoubleBuffered = true;
        Opacity = 0;
        using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;
        font = new Font("Segoe UI", 9.5f);

        Size textSize = TextRenderer.MeasureText(text, font);
        Width = S(10) + S(16) + S(7) + textSize.Width + S(10);
        Height = Math.Max(textSize.Height, S(16)) + S(12);

        Point pointer = Cursor.Position;
        Rectangle area = Screen.FromPoint(pointer).WorkingArea;
        int x = pointer.X + S(16), y = pointer.Y + S(18);
        if (x + Width > area.Right) x = pointer.X - Width - S(8);
        if (y + Height > area.Bottom) y = pointer.Y - Height - S(8);
        Location = new Point(Math.Max(area.Left, x), Math.Max(area.Top, y));

        timer.Interval = 15;
        timer.Tick += OnTick;
    }

    int S(float pixels) { return (int)Math.Round(pixels * scale); }

    // Topmost through the extended style: WinForms' TopMost property activates the window
    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int round = 2; // DWMWCP_ROUND: rounded corners on Windows 11, ignored elsewhere
        try { DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int)); } catch { }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        clock.Start();
        timer.Start();
    }

    void OnTick(object sender, EventArgs e)
    {
        long t = clock.ElapsedMilliseconds;
        if (t < FADE_IN_MS) Opacity = MAX_OPACITY * t / FADE_IN_MS;
        else if (t < FADE_IN_MS + HOLD_MS) Opacity = MAX_OPACITY;
        else if (t < FADE_IN_MS + HOLD_MS + FADE_OUT_MS) Opacity = MAX_OPACITY * (FADE_IN_MS + HOLD_MS + FADE_OUT_MS - t) / FADE_OUT_MS;
        else { timer.Stop(); Close(); }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        int d = S(16), left = S(10), top = (Height - d) / 2;
        using (Brush green = new SolidBrush(Color.FromArgb(34, 197, 94)))
            g.FillEllipse(green, left, top, d, d);
        using (Pen pen = new Pen(Color.White, Math.Max(1.5f, 1.8f * scale)))
        {
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            pen.LineJoin = LineJoin.Round;
            g.DrawLines(pen, new PointF[] {
                new PointF(left + d * 0.28f, top + d * 0.52f),
                new PointF(left + d * 0.44f, top + d * 0.68f),
                new PointF(left + d * 0.74f, top + d * 0.36f),
            });
        }
        Rectangle textBox = new Rectangle(left + d + S(7), 0, Width - (left + d + S(7)), Height);
        TextRenderer.DrawText(g, text, font, textBox, ForeColor, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding);
    }
}
`;

const TAG_FILE = /^copied-[0-9a-f]{8}(-\d+\.tmp)?\.exe$/;

function tagDir(): string {
  return path.join(getConfigDir(), 'protocol');
}

/** The compiled tag program; its name changes with the source, so upgrades rebuild it. */
export function getCopiedTagPath(): string {
  const version = createHash('sha256').update(COPIED_TAG_SOURCE).digest('hex').slice(0, 8);
  return path.join(tagDir(), `copied-${version}.exe`);
}

/** .NET Framework 4's C# compiler, part of every Windows 10 and 11 installation. */
export function findCsc(): string | undefined {
  const windows = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  for (const framework of ['Framework64', 'Framework']) {
    const csc = path.join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) return csc;
  }
  return undefined;
}

/** Compiled tag programs of any version, their source, and unfinished builds. */
export function removeCopiedTag(): void {
  let files: string[];
  try {
    files = fs.readdirSync(tagDir());
  } catch {
    return;
  }
  for (const file of files) {
    if (!TAG_FILE.test(file) && file !== 'copied.cs') continue;
    try {
      fs.rmSync(path.join(tagDir(), file), { force: true });
    } catch {
      // still running (it exits within two seconds)
    }
  }
}

/**
 * Compiles the tag program unless this version exists. Resolves to an error
 * message, or undefined once the program is ready.
 */
export function buildCopiedTag(): Promise<string | undefined> {
  const exe = getCopiedTagPath();
  if (fs.existsSync(exe)) return Promise.resolve(undefined);
  const csc = findCsc();
  if (!csc) return Promise.resolve('the C# compiler of .NET Framework 4 (csc.exe) was not found');
  try {
    removeCopiedTag(); // older versions
    fs.mkdirSync(tagDir(), { recursive: true });
    fs.writeFileSync(path.join(tagDir(), 'copied.cs'), COPIED_TAG_SOURCE);
  } catch (err) {
    return Promise.resolve(err instanceof Error ? err.message : String(err));
  }
  // Built under another name first, so a half-written program never runs
  const partial = exe.replace(/\.exe$/, `-${process.pid}.tmp.exe`);
  return new Promise((resolve) => {
    const child = spawn(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${partial}`, path.join(tagDir(), 'copied.cs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (err) => resolve(`could not run ${csc}: ${err.message}`));
    child.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(`csc.exe exited with code ${code}: ${output.trim().slice(0, 500)}`);
        fs.renameSync(partial, exe);
        resolve(undefined);
      } catch (err) {
        fs.rmSync(partial, { force: true });
        resolve(err instanceof Error ? err.message : String(err));
      }
    });
  });
}

export type CopyFeedback = (message: string) => void;

export interface CopyFeedbackDeps {
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** An AppleScript string literal. */
function appleScriptString(text: string): string {
  return `"${text.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * The daemon's copy confirmation for this platform, or undefined where there
 * is none. Never throws, and never delays the copy itself.
 */
export function createCopyFeedback(log: (message: string) => void, deps: CopyFeedbackDeps = {}): CopyFeedback | undefined {
  const platform = deps.platform ?? process.platform;
  const run = deps.spawn ?? spawn;
  const start = (command: string, args: string[], onError?: (err: Error) => void): ChildProcess | undefined => {
    try {
      const child = run(command, args, { stdio: 'ignore', windowsHide: false });
      child.on('error', (err) => onError?.(err));
      child.unref();
      return child;
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      return undefined;
    }
  };

  switch (platform) {
    case 'win32': {
      let ready: boolean | undefined; // undefined while building
      const built = buildCopiedTag().then((error) => {
        if (error) log(`No copy confirmation: ${error}`);
        ready = !error;
      });
      let current: ChildProcess | undefined;
      const show = (message: string): void => {
        if (!ready) return;
        current?.kill(); // a new click replaces the previous tag
        const child = start(getCopiedTagPath(), [message], (err) => log(`Copy confirmation failed: ${err.message}`));
        current = child;
        child?.on('exit', () => {
          if (current === child) current = undefined;
        });
      };
      return (message) => {
        if (ready === undefined) void built.then(() => show(message));
        else show(message);
      };
    }
    case 'darwin':
      return (message) => {
        start('osascript', ['-e', `display notification ${appleScriptString(message)} with title "clipcmd"`]);
      };
    case 'linux': {
      let unavailable = false;
      return (message) => {
        if (unavailable) return;
        start(
          'notify-send',
          ['--app-name=clipcmd', '--expire-time=1500', '--hint=int:transient:1', '--icon=edit-copy', 'clipcmd', message],
          () => (unavailable = true) // not installed
        );
      };
    }
    default:
      return undefined;
  }
}
