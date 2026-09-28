import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../cli';

/** A fake clipcmd that echoes its arguments and exits with `code`. */
function fake(dir: string, code: number): string {
  if (process.platform === 'win32') {
    const file = path.join(dir, `clipcmd-${code}.cmd`);
    fs.writeFileSync(file, `@echo args: %*\r\n@echo oops 1>&2\r\n@exit /b ${code}\r\n`);
    return file;
  }
  const file = path.join(dir, `clipcmd-${code}`);
  fs.writeFileSync(file, `#!/bin/sh\necho "args: $*"\necho oops >&2\nexit ${code}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

suite('runCli', () => {
  let dir: string;
  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcmd cli test '));
  });
  suiteTeardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('runs the given executable (even in a path with spaces) and returns its output', async () => {
    const result = await runCli(['start', '--quiet'], fake(dir, 0));
    assert.equal(result.code, 0);
    assert.equal(result.notFound, false);
    assert.equal(result.stdout.trim(), 'args: start --quiet');
    assert.equal(result.stderr.trim(), 'oops');
  });

  test('reports the exit code of a failing run', async () => {
    const result = await runCli(['start'], fake(dir, 3));
    assert.equal(result.code, 3);
    assert.equal(result.notFound, false);
  });

  test('says when the executable does not exist', async () => {
    const result = await runCli(['start'], path.join(dir, 'nope', 'clipcmd'));
    assert.equal(result.notFound, true);
    assert.notEqual(result.code, 0);
  });

  test('uses clipcmd from PATH by default', async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(dir, 'empty');
    try {
      const result = await runCli(['--version']);
      assert.equal(result.notFound, true);
    } finally {
      process.env.PATH = saved;
    }
  });
});
