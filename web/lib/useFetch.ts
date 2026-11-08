"use client";

import { useCallback, useEffect, useState } from "react";
import { api, toApiError, type ApiError } from "./api";

interface State<T> {
  path: string | null;
  data?: T;
  error?: ApiError;
}

/**
 * Fetches `path` now and every `intervalMs` (default 5 s) while the tab is
 * visible. Keeps the last good data when a refresh fails. `refresh()` fetches
 * again straight away (used after operator actions).
 */
export function useFetch<T>(path: string | null, intervalMs = 5000) {
  const [state, setState] = useState<State<T>>({ path });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();

    const load = async () => {
      try {
        const data = await api<T>(path, { signal: ctrl.signal });
        if (!ctrl.signal.aborted) setState({ path, data });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const error = toApiError(err);
        setState((prev) => ({ path, data: prev.path === path ? prev.data : undefined, error }));
      }
    };

    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, intervalMs);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [path, intervalMs, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const current: State<T> = state.path === path ? state : { path };
  return {
    data: current.data,
    error: current.error,
    loading: path !== null && current.data === undefined && current.error === undefined,
    refresh,
  };
}
