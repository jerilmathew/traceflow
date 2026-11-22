import { isTimeWindow, type TimeWindow } from '@traceflow/shared';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/** The selected time window lives in the URL (?window=1h) so views are shareable. */
export function useTimeWindow(fallback: TimeWindow = '1h'): [TimeWindow, (w: TimeWindow) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('window');
  const window = isTimeWindow(raw) ? raw : fallback;
  const setWindow = useCallback(
    (w: TimeWindow) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('window', w);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [window, setWindow];
}
