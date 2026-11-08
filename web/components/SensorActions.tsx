"use client";

import { useState } from "react";
import { ActionDialog } from "./ActionDialog";
import { post } from "@/lib/api";
import type { Sensor } from "@/lib/types";

export function SensorActions({ sensor, onDone }: { sensor: Sensor; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  if (sensor.lifecycle === "decommissioned") {
    return <span className="text-sm text-slate-600">No actions: decommissioned is permanent.</span>;
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Decommission ${sensor.sensor_id}`}
        className="rounded border border-red-700 bg-white px-2 py-1 text-xs font-semibold text-red-800 hover:bg-red-50"
      >
        Decommission
      </button>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Decommission ${sensor.sensor_id}?`}
        description="Decommissioning is permanent. The sensor stops being evaluated and any later action on it is rejected."
        confirmLabel="Decommission sensor"
        danger
        reason="required"
        onSubmit={async (reason) => {
          await post(`/api/v1/sensors/${encodeURIComponent(sensor.sensor_id)}/actions`, {
            action: "decommission",
            reason,
          });
          onDone();
        }}
      />
    </>
  );
}
