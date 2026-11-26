import type {
  ApiErrorBody,
  DemoInfo,
  DependencyGraph,
  Overview,
  Paginated,
  ServiceDetail,
  ServiceSummary,
  TimeWindow,
  TraceDetail,
  TraceSummary,
} from '@traceflow/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiRequestError(0, 'network_error', 'TraceFlow API is unreachable');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiRequestError(
      response.status,
      body?.error.code ?? 'http_error',
      body?.error.message ?? `Request failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

export interface TraceQuery {
  q?: string;
  service?: string;
  status?: 'ok' | 'error' | 'all';
  minDurationMs?: number;
  maxDurationMs?: number;
  from?: string;
  to?: string;
  sort?: 'startTime' | 'duration' | 'spanCount';
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const api = {
  meta: (signal?: AbortSignal) => request<{ demo: DemoInfo | null }>('/api/meta', signal),
  overview: (window: TimeWindow, signal?: AbortSignal) =>
    request<Overview>(`/api/overview${qs({ window })}`, signal),
  traces: (query: TraceQuery, signal?: AbortSignal) =>
    request<Paginated<TraceSummary>>(`/api/traces${qs(query)}`, signal),
  trace: (traceId: string, signal?: AbortSignal) =>
    request<TraceDetail>(`/api/traces/${encodeURIComponent(traceId)}`, signal),
  services: (window: TimeWindow, signal?: AbortSignal) =>
    request<{ window: TimeWindow; items: ServiceSummary[] }>(
      `/api/services${qs({ window })}`,
      signal,
    ),
  service: (name: string, window: TimeWindow, signal?: AbortSignal) =>
    request<ServiceDetail>(`/api/services/${encodeURIComponent(name)}${qs({ window })}`, signal),
  dependencies: (window: TimeWindow, signal?: AbortSignal) =>
    request<DependencyGraph>(`/api/dependencies${qs({ window })}`, signal),
};

export const queryKeys = {
  meta: ['meta'] as const,
  overview: (window: TimeWindow) => ['overview', window] as const,
  traces: (query: TraceQuery) => ['traces', query] as const,
  trace: (id: string) => ['trace', id] as const,
  services: (window: TimeWindow) => ['services', window] as const,
  service: (name: string, window: TimeWindow) => ['service', name, window] as const,
  dependencies: (window: TimeWindow) => ['dependencies', window] as const,
};
