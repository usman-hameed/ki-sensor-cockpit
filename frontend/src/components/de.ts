// Number formatting and labels for the screen. Only display, no logic.
import type { SensorInfo } from "../types";
import { shownFor } from "../lib/units";

export function de(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace("-", "−");
}

/** A position of a sensor in its shown unit (mm for a sensor with a display), without the unit. */
export function pos(v: number | null | undefined, sensor: SensorInfo | undefined, digits?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v) || !sensor) return "–";
  const shown = shownFor(sensor);
  const scale = shown.display?.scale ?? 1;
  return de(v * scale, digits ?? shown.display?.decimals ?? 1);
}

export function unitOf(sensor: SensorInfo | undefined): string {
  return sensor ? shownFor(sensor).unit : "";
}

export const ZONE_DE: Record<string, string> = {
  standard: "In measuring range",
  before: "Closer than the range",
  after: "Beyond the range",
  none: "No reading",
};

export const KIND_DE: Record<string, string> = {
  out_of_range: "Out of measuring range",
  invalid: "Invalid readings",
  wrong_part: "Different part",
  jam: "Possible jam",
  double_feed: "Possible double feed",
  trend: "Height trend",
};

export const PART_DE: Record<string, string> = {
  no_reference: "No part taught",
  waiting: "Waiting for a part",
  match: "Taught part",
  different: "Different part",
  empty: "Nothing under the sensor",
};
