// Loaded with `--import` so the SDK is running before any application module.
import { startTelemetry } from '@traceflow/telemetry';

startTelemetry({ serviceName: 'users-service' });
