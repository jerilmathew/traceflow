import { DEFAULT_DATABASE_URL, redactUrl } from './client';
import { runMigrations } from './migrate';

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const started = Date.now();
runMigrations(url)
  .then(() => {
    console.log(`✓ migrations applied to ${redactUrl(url)} in ${Date.now() - started}ms`);
  })
  .catch((error: unknown) => {
    console.error(`✗ migration failed for ${redactUrl(url)}`);
    console.error(error);
    process.exit(1);
  });
