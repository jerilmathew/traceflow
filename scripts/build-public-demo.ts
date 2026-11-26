/**
 * Bundles the servers for the public demo image into `out/`, mirroring the
 * source layout. `pg` stays external so the OpenTelemetry instrumentation can
 * patch it when it is required. Code splitting keeps one shared copy of the
 * OpenTelemetry SDK between each service's preload and server.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const OUT = 'out';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);

const services = ['gateway', 'users', 'inventory'];
await build({
  entryPoints: [
    'scripts/public-demo.ts',
    'apps/collector/src/server.ts',
    'apps/api/src/server.ts',
    ...services.flatMap((s) => [
      `examples/microservices/src/${s}/instrument.ts`,
      `examples/microservices/src/${s}/server.ts`,
    ]),
  ],
  outdir: OUT,
  outbase: '.',
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minifySyntax: true,
  external: ['pg', 'pg-native'],
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  logLevel: 'warning',
});

const { dependencies } = JSON.parse(
  readFileSync('examples/microservices/package.json', 'utf8'),
) as { dependencies: Record<string, string> };
writeFileSync(
  `${OUT}/package.json`,
  JSON.stringify({ private: true, type: 'module', dependencies: { pg: dependencies.pg } }),
);
cpSync('packages/db/drizzle', `${OUT}/drizzle`, { recursive: true });
cpSync('apps/web/dist', `${OUT}/apps/web/dist`, { recursive: true });
cpSync('docs/openapi.yaml', `${OUT}/docs/openapi.yaml`);
