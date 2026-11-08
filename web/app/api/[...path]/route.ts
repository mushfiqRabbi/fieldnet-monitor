import type { NextRequest } from "next/server";

// Runtime proxy to the API service. Reads API_URL on every request.
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  const base = (process.env.API_URL || "http://localhost:8000").replace(/\/$/, "");
  const url = `${base}/api/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const headers: Record<string, string> = { accept: "application/json" };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? await req.text() : undefined,
      cache: "no-store",
      redirect: "manual",
    });
  } catch (err) {
    return Response.json(
      {
        error: "api_unreachable",
        detail: `The console could not reach the API at ${base}. ${
          err instanceof Error ? err.message : ""
        }`.trim(),
      },
      { status: 502 },
    );
  }

  const out = new Headers();
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) out.set("content-type", upstreamType);
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) out.set("retry-after", retryAfter);
  out.set("cache-control", "no-store");

  const noBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(noBody ? null : upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
