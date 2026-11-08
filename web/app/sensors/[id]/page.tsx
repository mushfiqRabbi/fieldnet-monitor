import type { Metadata } from "next";
import { SensorDetailView } from "@/components/SensorDetailView";

export const metadata: Metadata = { title: "Sensor" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SensorDetailView id={decodeURIComponent(id)} />;
}
