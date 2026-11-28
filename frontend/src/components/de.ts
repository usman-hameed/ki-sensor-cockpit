// German number formatting for the screen: decimal comma, minus sign. Only display, no logic.
import type { SensorInfo } from "../types";
import { shownFor } from "../lib/units";

export function de(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace("-", "−");
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
  standard: "Im Messbereich",
  before: "Näher als der Messbereich",
  after: "Weiter als der Messbereich",
  none: "Kein Messwert",
};

export const KIND_DE: Record<string, string> = {
  out_of_range: "Außerhalb des Messbereichs",
  invalid: "Ungültige Messwerte",
  wrong_part: "Anderes Teil",
  jam: "Möglicher Stau",
  double_feed: "Mögliche Doppelzuführung",
  trend: "Höhentrend",
};

export const PART_DE: Record<string, string> = {
  no_reference: "Kein Teil gelernt",
  waiting: "Warte auf ein Teil",
  match: "Gelerntes Teil",
  different: "Anderes Teil",
  empty: "Nichts unter dem Sensor",
};
