"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/cx";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/gateways", label: "Gateways" },
  { href: "/sensors", label: "Sensors" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-b border-slate-300 bg-slate-900 text-white">
      <div className="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 sm:px-6">
        <span className="text-base font-semibold tracking-tight">FieldNet Monitor</span>
        <nav aria-label="Main">
          <ul className="flex gap-1">
            {LINKS.map((l) => {
              const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
              return (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "inline-block rounded px-3 py-2 text-sm font-medium",
                      active ? "bg-white text-slate-900" : "text-slate-100 hover:bg-slate-700",
                    )}
                  >
                    {l.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
