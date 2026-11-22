import './index.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppLayout } from '@/components/layout';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LiveProvider } from '@/hooks/use-live';
import { ApiRequestError } from '@/lib/api';
import { NotFoundPage } from '@/pages/not-found';
import { OverviewPage } from '@/pages/overview';
import { TraceDetailPage } from '@/pages/trace-detail';
import { TracesPage } from '@/pages/traces';
import { ServicesPage } from '@/pages/services';
import { ServiceDetailPage } from '@/pages/service-detail';

// React Flow is only needed on the map page: load it on demand.
const ServiceMapPage = lazy(() => import('@/pages/service-map'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      // Don't hammer the API for client errors; back off on network/5xx.
      retry: (count, error) =>
        !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) &&
        count < 3,
      retryDelay: (attempt) => Math.min(8_000, 500 * 2 ** attempt),
    },
  },
});

const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/traces', element: <TracesPage /> },
      { path: '/traces/:traceId', element: <TraceDetailPage /> },
      {
        path: '/map',
        element: (
          <Suspense fallback={<div className="p-6 text-xs text-ink-3">Loading map…</div>}>
            <ServiceMapPage />
          </Suspense>
        ),
      },
      { path: '/services', element: <ServicesPage /> },
      { path: '/services/:name', element: <ServiceDetailPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <LiveProvider>
          <RouterProvider router={router} />
        </LiveProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
