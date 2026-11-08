import type { Metadata } from "next";
import { SensorsView } from "@/components/SensorsView";
import { COLLECTIONS, LIFECYCLES, SENSOR_COVERAGES } from "@/lib/types";

export const metadata: Metadata = { title: "Sensors" };

type SP = Promise<Record<string, string | string[] | undefined>>;

function pick(sp: Record<string, string | string[] | undefined>, key: string, allowed: readonly string[]): string {
  const raw = Array.isArray(sp[key]) ? sp[key]![0] : sp[key];
  return raw && allowed.includes(raw) ? raw : "";
}

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return (
    <SensorsView
      filters={{
        lifecycle: pick(sp, "lifecycle", LIFECYCLES),
        coverage: pick(sp, "coverage", SENSOR_COVERAGES),
        collection: pick(sp, "collection", COLLECTIONS),
      }}
    />
  );
}
