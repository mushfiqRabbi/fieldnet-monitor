import type { Metadata } from "next";
import { GatewaysView } from "@/components/GatewaysView";
import { GATEWAY_STATUSES } from "@/lib/types";

export const metadata: Metadata = { title: "Gateways" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = raw && (GATEWAY_STATUSES as readonly string[]).includes(raw) ? raw : "";
  const flagged = (Array.isArray(sp.flagged) ? sp.flagged[0] : sp.flagged) === "1";
  return <GatewaysView status={status} flagged={flagged} />;
}
