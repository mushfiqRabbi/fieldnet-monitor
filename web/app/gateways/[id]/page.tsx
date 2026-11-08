import type { Metadata } from "next";
import { GatewayDetailView } from "@/components/GatewayDetailView";

export const metadata: Metadata = { title: "Gateway" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GatewayDetailView id={decodeURIComponent(id)} />;
}
