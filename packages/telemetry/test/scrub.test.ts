import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scrubPaths } from '../src/scrub';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('scrubPaths', () => {
  it('replaces the repository root and home directory in stack traces', () => {
    const stack = `Error: boom\n    at f (${repo}/apps/x.ts:1:1)\n    at g (file://${encodeURI(repo)}/y.ts:2:2)\n    at h (${homedir()}/other/z.js:3:3)`;
    const out = scrubPaths(stack);
    expect(out).toContain('<repo>/apps/x.ts:1:1');
    expect(out).toContain('<repo>/y.ts:2:2');
    expect(out).toContain('~/other/z.js');
    expect(out).not.toContain(homedir());
  });
});
