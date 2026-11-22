import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';

/** Repository root (packages/telemetry/src → ../../..). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOME = homedir();

/** Replace machine-specific absolute paths (repo checkout, home directory) in stack traces. */
export function scrubPaths(text: string): string {
  const variants = (p: string) => [p, encodeURI(p), `file://${encodeURI(p)}`];
  let out = text;
  for (const v of variants(REPO_ROOT).reverse()) out = out.split(v).join('<repo>');
  for (const v of variants(HOME).reverse()) out = out.split(v).join('~');
  return out;
}

/**
 * Span processor that rewrites `exception.stacktrace` event attributes before
 * the spans reach the exporter. Stack traces otherwise contain absolute paths
 * such as /Users/<name>/…, which would leak the developer's username into
 * stored telemetry and screenshots. Must be registered before the exporting
 * processor so it runs first.
 */
export class StackTraceScrubber implements SpanProcessor {
  onStart(_span: Span, _ctx: Context): void {}

  onEnd(span: ReadableSpan): void {
    for (const event of span.events) {
      const stack = event.attributes?.['exception.stacktrace'];
      if (typeof stack === 'string') {
        (event.attributes as Record<string, unknown>)['exception.stacktrace'] = scrubPaths(stack);
      }
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
