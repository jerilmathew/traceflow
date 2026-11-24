# Deploying the public demo

The `Dockerfile` builds one container that runs the dashboard, the read-only API,
the collector and the three demo services, next to one PostgreSQL database. Only
port `$PORT` (default 8080) is reachable. The collector and demo services listen
on `127.0.0.1` inside the container, so visitors cannot send or change telemetry.

## Configuration

| Variable                       | Default  | Purpose                                                                                                                                                |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                 | required | PostgreSQL (tested with 17); the role must be able to create the `inventory_demo` database                                                             |
| `CLIENT_IP_HEADER`             | empty    | header in which the host's edge puts the visitor's address. Empty uses the connection address, which behind an edge means all visitors share one limit |
| `RATE_LIMIT_PER_MINUTE`        | `300`    | per visitor (IPv6: per /64)                                                                                                                            |
| `GLOBAL_RATE_LIMIT_PER_MINUTE` | `3000`   | all visitors together; still holds if a visitor forges an address                                                                                      |
| `RETENTION_HOURS`              | `24`     | older traces are deleted every 10 minutes                                                                                                              |
| `DEMO_RPS`                     | `0.05`   | demo requests per second (about 3 per minute)                                                                                                          |
| `SOURCE_URL`                   | empty    | "View source" link in the demo notice                                                                                                                  |
| `TRUST_PROXY`                  | empty    | for your own reverse proxy: its IPs/CIDRs, used with `X-Forwarded-For`                                                                                 |

## Measured footprint

Measured locally on linux/arm64 in a container limited to 256 MB and 1 CPU, with a
read-only filesystem and no capabilities. Expect some difference on other hosts.

|                        | Development setup | This image                                         |
| ---------------------- | ----------------- | -------------------------------------------------- |
| Memory at demo traffic | 554 MB            | 140–200 MB                                         |
| Image size             | 1.18 GB           | 243 MB                                             |
| CPU at demo traffic    | about 6%          | about 2% of one vCPU                               |
| PostgreSQL memory      | 83 MB             | 50–96 MB                                           |
| Storage                |                   | about 35 KB per trace, roughly 150 MB for 24 hours |

Most of the saving comes from compiling ahead of time: the development setup runs a
TypeScript compiler beside every process.

## Cost estimate

List prices read from official pages on 25 November 2026, USD, before tax. These are
estimates, not quotes. **Check the host's own calculator before activating billing.**

| Option                    | Estimate per month    | Notes                                                                                                                                                                    |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Railway Hobby             | about $5              | $5 fee includes $5 of usage; this demo is estimated at $3–4 of usage (below)                                                                                             |
| Railway Free              | $0, but not always on | $1 of monthly credit is roughly a week of this demo, then services stop                                                                                                  |
| Fly.io                    | about $6              | 256 MB machine $2.19 + Managed Postgres Developer $4.00. Fly also lists $5 of monthly usage once a card is added; whether that covers Managed Postgres was not confirmed |
| Render Free               | $0, not suitable      | sleeps after 15 idle minutes and its free database expires after 30 days. Paid prices could not be read                                                                  |
| Neon Free (database only) | not suitable          | always suspends when idle and has a monthly compute cap; live updates need a permanent connection                                                                        |
| Hetzner VPS               | from €5.49 + VAT      | one server to patch and secure; that size was listed as unavailable                                                                                                      |

Railway usage: RAM 0.3 GB × $10 = $3.00, CPU 0.025 vCPU × $20 = $0.50, storage
0.5 GB × $0.15 = $0.08, plus $0.05 per GB of traffic.
A Railway hard usage limit cannot be set below $10, and reaching it takes every
workload in the workspace offline.

Sources: [Railway plans](https://docs.railway.com/reference/pricing/plans),
[Railway usage limits](https://docs.railway.com/reference/usage-limits),
[Railway free plan](https://docs.railway.com/pricing/free-plan),
[Fly.io pricing](https://fly.io/docs/about/pricing/), [Fly.io Managed Postgres](https://docs.fly.io/mpg),
[Render free tier](https://render.com/docs/free), [Neon pricing](https://neon.com/pricing),
[Hetzner Cloud](https://www.hetzner.com/cloud/regular-performance/).

## Railway, step by step

1. Sign in at railway.com with the GitHub account that owns the repository and choose a plan.
2. **New Project → Deploy from GitHub repo →** this repository. Railway detects the `Dockerfile`.
3. In the same project add **Database → PostgreSQL**.
4. On the app service set these variables:

   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   CLIENT_IP_HEADER=x-real-ip
   SOURCE_URL=https://github.com/jerilmathew3-web/traceflow
   ```

5. Set the health check path to `/api/health` and keep one replica.
6. **Settings → Networking → Generate Domain.** Do not expose any other port or the database.
7. Optionally set a usage alert and hard limit in the workspace's usage settings.
8. From a checkout of this repository, verify the result:

   ```bash
   pnpm verify:deployment https://<your-domain>
   ```

   If "spoofed client addresses get no extra quota" fails, remove `CLIENT_IP_HEADER`.
   Visitors then share one limit, but nobody can dodge it.

### Why the client address needs checking

Railway documents `X-Real-IP` as the client's address, but its documentation does not
say whether a value sent by the visitor is always replaced, and it publishes no proxy
address ranges. Staff answers on its forum say the edge replaces it; some user reports
disagree. The app therefore treats the header as a convenience for fair limits, not as
a security boundary: a site-wide limit, a live-connection cap and query timeouts apply
whatever address a request claims. On Fly.io use `CLIENT_IP_HEADER=fly-client-ip`.

## Operations

- Any process exiting stops the container, and the host restarts it. Data is in PostgreSQL.
- Migrations run on start. Roll back by redeploying an earlier commit.
- A fresh or idle instance sends about 120 demo requests on start, including one slow and
  one failed request, so the dashboard is never empty.
