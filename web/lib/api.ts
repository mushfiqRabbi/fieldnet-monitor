import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  status: number;
  code: string;
  detail: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError(
    0,
    "network_error",
    err instanceof Error ? err.message : "The request failed before reaching the server.",
  );
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", ...init.headers },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw toApiError(err);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (!res.ok) {
    const e = body as Partial<ApiErrorBody> | undefined;
    throw new ApiError(
      res.status,
      e?.error ?? `http_${res.status}`,
      e?.detail ?? (res.status === 503 ? "The server is busy. Try again shortly." : res.statusText || "Request failed."),
    );
  }
  return body as T;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}
