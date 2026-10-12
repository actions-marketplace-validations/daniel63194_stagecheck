import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('published package', () => {
  // npm only makes a bin executable when it creates the link, so a reinstall
  // over an existing link (for example in the npx cache) keeps the file's own
  // mode. The tarball must therefore carry the executable bit itself.
  it.skipIf(process.platform === 'win32')('ships the CLI as an executable file', () => {
    expect(statSync(join(import.meta.dirname, '..', 'dist', 'cli.js')).mode & 0o111).toBe(0o111);
  });
});
