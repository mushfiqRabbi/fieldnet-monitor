import Link from "next/link";
import type { ApiError } from "@/lib/api";
import { formatAbsolute } from "@/lib/format";

export function PageHeader({
  title,
  subtitle,
  now,
  children,
}: {
  title: string;
  subtitle?: string;
  now?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-700">{subtitle}</p> : null}
      </div>
      <div className="text-xs text-slate-600">
        {now ? (
          <p>
            Server clock: <time dateTime={now}>{formatAbsolute(now)}</time>. Updates every 5 seconds.
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="rounded border border-slate-300 bg-white p-4 text-sm text-slate-700">
      Loading {what}...
    </p>
  );
}

export function ErrorNote({ error, hasData }: { error: ApiError; hasData: boolean }) {
  const notFound = error.status === 404;
  return (
    <div role="alert" className="mb-4 rounded border border-red-700 bg-red-50 p-3 text-sm text-red-900">
      <p className="font-semibold">
        {notFound
          ? "Not found."
          : hasData
            ? "Could not refresh. Showing the last data received."
            : "Could not load this page."}
      </p>
      <p>
        {error.detail} <span className="text-xs">(Error code: {error.code})</span>
      </p>
      {!notFound ? <p className="mt-1 text-xs">The page keeps retrying every 5 seconds.</p> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-slate-400 bg-white p-6 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <p className="mt-1 text-sm text-slate-700">{children}</p> : null}
    </div>
  );
}

export function Breadcrumb({ href, label }: { href: string; label: string }) {
  return (
    <p className="mb-2 text-sm">
      <Link href={href} className="text-blue-800 underline">
        {label}
      </Link>
    </p>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-slate-300 bg-white p-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

export const LINK = "text-blue-800 underline hover:text-blue-950";
export const TH = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-700";
export const TD = "px-3 py-2 align-top text-sm";
