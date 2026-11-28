// ECharts setup and the option builders for the chart views.
import { BarChart, BoxplotChart, EffectScatterChart, LineChart, ScatterChart } from "echarts/charts";
import {
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type {
  Anchor, BoxplotData, CockpitEvent, HistogramData, HistoryData, InsightStep, PartCountsData, PartsData, Series,
  Severity, Tolerance, ViewData,
} from "../types";
import { KIND_LABEL, relSeconds } from "./format";
import { axisFormatter, limitLabel, nearLimit, pos, posUnit, shownOf, type Shown } from "./units";

echarts.use([
  LineChart,
  BarChart,
  BoxplotChart,
  ScatterChart,
  EffectScatterChart,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };
export type ChartOption = echarts.EChartsCoreOption;

// Two themes: the light measuring-room cockpit and the dark mission mode.
// Option builders read these objects, so a theme switch only needs a redraw.
const LIGHT = {
  text: "#4f5d6b", dim: "#7d8a97", grid: "rgba(21, 32, 43, 0.07)", axis: "rgba(21, 32, 43, 0.22)",
  cyan: "#c4161c", violet: "#68717b", amber: "#d97706", red: "#c4161c", green: "#1e8e3e",
  series: ["#c4161c", "#1d2329", "#1e6fd9", "#d97706"],
};
const DARK = {
  text: "#a9b8d0", dim: "#6d7c95", grid: "rgba(150, 170, 255, 0.08)", axis: "rgba(150, 170, 255, 0.24)",
  cyan: "#8f80ff", violet: "#c4b8ff", amber: "#ffb020", red: "#ff4d63", green: "#2ed39a",
  series: ["#8f80ff", "#ff7aa2", "#2ed39a", "#ffb020"],
};
export const COLORS = { ...LIGHT, series: [...LIGHT.series] };
const SEVERITY_FILL: Record<Severity, string> = { info: "", warning: "", critical: "" };
const THEME = { tipBg: "", tipBorder: "", tipText: "", pointer: "", nowLine: "", labelBg: "", dark: false };

export function setChartTheme(dark: boolean): void {
  const src = dark ? DARK : LIGHT;
  Object.assign(COLORS, { ...src, series: [...src.series] });
  SEVERITY_FILL.info = hexToRgba(COLORS.cyan, dark ? 0.16 : 0.1);
  SEVERITY_FILL.warning = hexToRgba(COLORS.amber, dark ? 0.18 : 0.13);
  SEVERITY_FILL.critical = hexToRgba(COLORS.red, dark ? 0.22 : 0.13);
  Object.assign(THEME, {
    dark,
    tipBg: dark ? "rgba(8, 10, 28, 0.94)" : "rgba(255, 255, 255, 0.97)",
    tipBorder: hexToRgba(COLORS.cyan, 0.4),
    tipText: dark ? "#eef0ff" : "#15202b",
    pointer: hexToRgba(COLORS.cyan, 0.5),
    nowLine: dark ? "rgba(238, 240, 255, 0.35)" : "rgba(21, 32, 43, 0.3)",
    labelBg: dark ? "rgba(8, 10, 28, 0.9)" : "rgba(255, 255, 255, 0.95)",
  });
}

const FONT = "'IBM Plex Sans Condensed', 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif";
const HIDDEN = "_"; // series whose name starts with this stay out of tooltips and legends

function hexToRgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

setChartTheme(false);

function tooltip(unit: string, shown?: Shown): Record<string, unknown> {
  return {
    trigger: "axis",
    backgroundColor: THEME.tipBg,
    borderColor: THEME.tipBorder,
    textStyle: { color: THEME.tipText, fontFamily: FONT, fontSize: 13 },
    axisPointer: { lineStyle: { color: THEME.pointer } },
    formatter: (params: unknown) => {
      const list = (Array.isArray(params) ? params : [params]) as {
        seriesName: string;
        value: [number, number | null];
        marker: string;
      }[];
      const visible = list.filter((p) => !p.seriesName.startsWith(HIDDEN) && p.value?.[1] !== null);
      if (!visible.length) return "";
      const text = (v: number) => (shown?.display ? pos(v, shown) : v.toFixed(2));
      const rows = visible.map((p) => `${p.marker}${p.seriesName}: <b>${text(Number(p.value[1]))}</b> ${shown ? shown.unit : unit}`);
      return rows.join("<br/>");
    },
  };
}

function base(unit: string, shown?: Shown): ChartOption {
  return {
    backgroundColor: "transparent",
    textStyle: { color: COLORS.text, fontFamily: FONT },
    animation: true,
    animationDuration: 900,
    animationEasing: "cubicOut",
    animationDurationUpdate: 300,
    tooltip: tooltip(unit, shown),
  };
}

function niceRange(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.12;
  const raw = (hi - lo + 2 * pad) / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  return [Math.floor((lo - pad) / step) * step, Math.ceil((hi + pad) / step) * step];
}

function extent(values: (number | null)[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || Number.isNaN(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

function valueAxis(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "value",
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: COLORS.dim, fontSize: 11 },
    splitLine: { lineStyle: { color: COLORS.grid } },
    ...extra,
  };
}

/** Tick labels in the sensor's own unit when it has one; the axis keeps the signal unit underneath. */
function labelsIn(shown: Shown, step?: number): Record<string, unknown> {
  const formatter = axisFormatter(shown, step);
  return formatter ? { axisLabel: { color: COLORS.dim, fontSize: 11, formatter } } : {};
}

function glow(color: string, width = 1.6): Record<string, unknown> {
  return { color, width, shadowBlur: 10, shadowColor: color };
}

function toleranceMarks(tolerance: Tolerance, shown: Shown): Record<string, unknown>[] {
  return [
    { yAxis: tolerance.high, label: { formatter: limitLabel(tolerance.high, shown, "high") } },
    { yAxis: tolerance.low, label: { formatter: limitLabel(tolerance.low, shown, "low"), position: "insideEndBottom" } },
  ];
}

/** Which of a sorted list of times get a label, so labels never pile up. */
function spacedOut(times: number[], t0: number, t1: number, minShare = 0.08, newestFirst = false): boolean[] {
  const span = Math.max(t1 - t0, 1e-9);
  const order = times.map((_, i) => i);
  if (newestFirst) order.reverse();
  const show = times.map(() => false);
  let last: number | null = null;
  for (const i of order) {
    const f = (times[i] - t0) / span;
    if (f < -0.02 || f > 1.02 || (last !== null && Math.abs(f - last) < minShare)) continue;
    show[i] = true;
    last = f;
  }
  return show;
}

/** A tick every whole second, minute or hour, so a 5-minute axis reads −5 min … now. */
function tickStep(windowS: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  return steps.find((step) => windowS / step <= 7) ?? 7200;
}

function eventAreas(events: CockpitEvent[], tNow: number, windowS: number): Record<string, unknown> {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const show = spacedOut(sorted.map((e) => e.t), tNow - windowS, tNow, 0.1, true);
  return {
    silent: true,
    data: sorted.map((e, i) => [
      {
        xAxis: e.t - tNow - 1.2,
        itemStyle: { color: SEVERITY_FILL[e.severity] },
        label: show[i]
          ? { show: true, position: "insideTop", color: COLORS.amber, fontSize: 10, formatter: KIND_LABEL[e.kind] }
          : { show: false },
      },
      { xAxis: e.t - tNow + 1.2 },
    ]),
  };
}

/**
 * One sensor's trace. Thinned data arrives as min/max pairs; drawn as a faint
 * envelope (so short spikes stay visible) plus a bright centre line (so long
 * windows stay readable instead of turning into a solid wall).
 */
function traceSeries(s: Series, tNow: number, color: string, axis: number, extras: Record<string, unknown>) {
  const thinned = s.values.length > 400 && s.dt > 0.004;
  const indexes = { xAxisIndex: axis, yAxisIndex: axis };
  const raw = s.values.map((v, i) => [s.t0 + i * s.dt - tNow, v]);
  if (!thinned) {
    return [{
      type: "line", name: s.name, ...indexes, showSymbol: false, connectNulls: false, data: raw,
      lineStyle: glow(color), itemStyle: { color }, emphasis: { disabled: true }, ...extras,
    }];
  }
  const middle: [number, number | null][] = [];
  for (let i = 0; i + 1 < s.values.length; i += 2) {
    const a = s.values[i];
    const b = s.values[i + 1];
    middle.push([s.t0 + (i + 0.5) * s.dt - tNow, a === null || b === null ? null : (a + b) / 2]);
  }
  return [
    {
      type: "line", name: `${HIDDEN}envelope`, ...indexes, data: raw, showSymbol: false, silent: true,
      connectNulls: false, emphasis: { disabled: true }, lineStyle: { color: hexToRgba(color, 0.3), width: 1 },
    },
    {
      type: "line", name: s.name, ...indexes, showSymbol: false, connectNulls: false, data: middle,
      lineStyle: glow(color, 1.6), itemStyle: { color }, emphasis: { disabled: true }, ...extras,
    },
  ];
}

/** Timeseries (one sensor) and compare (sensors stacked on one time axis). */
export function historyOption(data: HistoryData): ChartOption {
  const unit = data.series[0]?.unit ?? "";
  const shownFirst = shownOf(unit, data.series[0]?.display, data.series[0]?.limit_word);
  const n = Math.max(1, data.series.length);
  // Stacked grids for compare: percentages, since ECharts has no calc().
  const topPct = 5;
  const bottomPct = 10;
  const gapPct = 7;
  const heightPct = (100 - topPct - bottomPct - gapPct * (n - 1)) / n;
  const grids: Record<string, unknown>[] = [];
  const xAxes: Record<string, unknown>[] = [];
  const yAxes: Record<string, unknown>[] = [];
  const series: Record<string, unknown>[] = [];

  data.series.forEach((s, index) => {
    const color = COLORS.series[index % COLORS.series.length];
    grids.push(
      n === 1
        ? { left: 70, right: 30, top: 22, bottom: 38 }
        : { left: 70, right: 30, top: `${topPct + index * (heightPct + gapPct)}%`, height: `${heightPct}%` },
    );
    const last = index === n - 1;
    xAxes.push({
      type: "value",
      gridIndex: index,
      min: -data.window_s,
      max: 0,
      interval: tickStep(data.window_s),
      axisLine: { lineStyle: { color: COLORS.axis } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: last, color: COLORS.dim, fontSize: 11, formatter: (v: number) => relSeconds(v) },
    });

    const [lo, hi] = extent(s.values);
    // Show the limits only when the signal gets near them; otherwise they would squash the trace into a flat line.
    const shown = shownOf(s.unit, s.display, s.limit_word);
    const near = nearLimit(s.tolerance, lo, hi, shown);
    const [yMin, yMax] = near
      ? niceRange(Math.min(lo, s.tolerance.low), Math.max(hi, s.tolerance.high))
      : niceRange(lo, hi);
    yAxes.push(valueAxis({
      gridIndex: index,
      min: yMin,
      max: yMax,
      splitNumber: n > 1 ? 3 : 5,
      ...labelsIn(shown, (yMax - yMin) / (n > 1 ? 3 : 5)),
      name: n > 1 ? s.name : "",
      nameLocation: "middle",
      nameGap: 48,
      nameTextStyle: { color, fontSize: 12, fontWeight: "bold" },
    }));

    // only this sensor's events
    const mine = data.events.filter((e) => e.sensor === s.sensor || e.related_sensors.includes(s.sensor));
    const extras: Record<string, unknown> = { markArea: eventAreas(mine, data.t_now, data.window_s) };
    if (near) {
      extras.markLine = {
        silent: true,
        symbol: "none",
        lineStyle: { color: COLORS.red, type: "dashed", width: 1, opacity: 0.8 },
        label: { color: COLORS.red, fontSize: 10, position: "insideEndTop" },
        data: toleranceMarks(s.tolerance, shown),
      };
    }
    series.push(...traceSeries(s, data.t_now, color, index, extras));
  });

  return {
    ...base(unit, shownFirst),
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    series,
    axisPointer: n > 1 ? { link: [{ xAxisIndex: "all" }] } : undefined,
  };
}

function plainTooltip(): Record<string, unknown> {
  return {
    trigger: "item",
    backgroundColor: THEME.tipBg,
    borderColor: THEME.tipBorder,
    textStyle: { color: THEME.tipText, fontFamily: FONT, fontSize: 13 },
  };
}

/** How readings are spread: a stepped area per sensor on a value axis. */
export function histogramOption(data: HistogramData): ChartOption {
  const per = data.view === "part_heights" ? "parts" : "readings";
  const unit = data.series[0]?.unit ?? "";
  const shown = shownOf(unit, data.series[0]?.display, data.series[0]?.limit_word);
  const edges = data.series.flatMap((s) => [s.edges[0], s.edges[s.edges.length - 1]]);
  const step = edges.length ? (Math.max(...edges) - Math.min(...edges)) / 6 : undefined;
  const series = data.series.map((s, i) => {
    const color = COLORS.series[i % COLORS.series.length];
    const centres = s.counts.map((c, k) => [(s.edges[k] + s.edges[k + 1]) / 2, c]);
    // the tolerance limits, when the readings come anywhere near them
    const lo = s.edges[0];
    const hi = s.edges[s.edges.length - 1];
    const limits = i === 0 ? [s.tolerance.low, s.tolerance.high].filter((v) => v >= lo && v <= hi) : [];
    return {
      type: "line", name: s.name, step: "middle", showSymbol: false, data: centres,
      lineStyle: { color, width: 1.6 }, itemStyle: { color },
      areaStyle: { color: hexToRgba(color, data.series.length > 1 ? 0.18 : 0.28) },
      emphasis: { disabled: true },
      ...(limits.length ? { markLine: {
        symbol: "none", silent: true, animation: false,
        lineStyle: { color: COLORS.red, type: "dashed", width: 1.2 },
        label: { color: COLORS.red, fontSize: 10, position: "insideEndTop",
          formatter: (p: { value: number }) => limitLabel(p.value, shown, p.value <= s.tolerance.low ? "low" : "high") },
        data: limits.map((v) => ({ xAxis: v })),
      } } : {}),
    };
  });
  const tip = shown.display
    ? { ...plainTooltip(), trigger: "axis", formatter: (params: { seriesName: string; value: [number, number] }[]) => {
        const list = Array.isArray(params) ? params : [params];
        if (!list.length) return "";
        return `${posUnit(list[0].value[0], shown)}<br/>${list.map((p) => `${p.seriesName}: <b>${p.value[1]}</b> ${per}`).join("<br/>")}`;
      } }
    : { ...plainTooltip(), trigger: "axis" };
  return {
    ...base(unit, shown),
    tooltip: tip,
    legend: data.series.length > 1 ? { top: 0, right: 8, textStyle: { color: COLORS.text } } : undefined,
    grid: { left: 64, right: 26, top: 30, bottom: 38 },
    xAxis: valueAxis({ scale: true, name: shown.unit, nameLocation: "end", nameTextStyle: { color: COLORS.dim },
      splitLine: { show: false }, axisLine: { show: true, lineStyle: { color: COLORS.axis } }, ...labelsIn(shown, step) }),
    yAxis: valueAxis({ name: per, nameTextStyle: { color: COLORS.dim }, minInterval: 1 }),
    series,
  };
}

export function boxplotOption(data: BoxplotData): ChartOption {
  const shown = shownOf(data.unit, data.display);
  const at = (v: number) => (shown.display ? pos(v, shown) : signed(v, 2));
  const all = data.boxes.flat();
  const step = all.length ? (Math.max(...all) - Math.min(...all)) / 5 : undefined;
  return {
    ...base(data.unit, shown),
    tooltip: {
      ...plainTooltip(),
      formatter: (p: { name: string; value: number[] }) => {
        const [, lo, q1, med, q3, hi] = p.value;
        return `${p.name}<br/>median ${at(med)} ${shown.unit}<br/>middle half ${at(q1)} to ${at(q3)}`
          + `<br/>98% within ${at(lo)} to ${at(hi)}`;
      },
    },
    grid: { left: 64, right: 26, top: 24, bottom: 40 },
    xAxis: { type: "category", data: data.categories, axisLine: { lineStyle: { color: COLORS.axis } },
      axisTick: { show: false }, axisLabel: { color: COLORS.dim, fontSize: 12 } },
    yAxis: valueAxis({ scale: true, name: shown.unit, nameTextStyle: { color: COLORS.dim }, ...labelsIn(shown, step) }),
    series: [{
      type: "boxplot", name: "spread", data: data.boxes, boxWidth: [8, 42],
      itemStyle: { color: hexToRgba(COLORS.cyan, 0.16), borderColor: COLORS.cyan, borderWidth: 1.6 },
      emphasis: { disabled: true },
    }],
  };
}

function signed(v: number | null | undefined, digits: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
}

// ---------------------------------------------------------------------------
// The part log: one value per part
// ---------------------------------------------------------------------------

/** The height of every part in the order they came: green dots for the taught part, red for the others. */
export function partsOption(data: PartsData): ChartOption {
  const shown = shownOf(data.unit, data.display, "band of the taught part");
  const heights = data.parts.map((p) => p.height_um);
  const band = data.band;
  const all = band ? [...heights, band.low, band.high] : heights;
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  const pad = Math.max((hi - lo) * 0.18, 20);
  const step = (hi - lo + 2 * pad) / 5;
  const first = data.parts[0]?.number ?? 0;
  const last = data.parts[data.parts.length - 1]?.number ?? 1;
  const dot = (verdict: "good" | "different") => data.parts
    .filter((p) => p.verdict === verdict)
    .map((p) => ({ value: [p.number, p.height_um], flags: p.flags, dwell: p.dwell_s }));
  const series: Record<string, unknown>[] = [
    {
      type: "scatter", name: "taught part", data: dot("good"), symbolSize: 9,
      itemStyle: { color: COLORS.green, borderColor: "rgba(255,255,255,0.85)", borderWidth: 1 },
      emphasis: { scale: 1.6 },
      ...(band ? { markArea: {
        silent: true, animation: false,
        itemStyle: { color: hexToRgba(COLORS.green, THEME.dark ? 0.12 : 0.09) },
        label: { show: true, position: "insideTopRight", color: COLORS.green, fontSize: 11, formatter: "taught part" },
        data: [[{ yAxis: band.low }, { yAxis: band.high }]],
      } } : {}),
    },
    {
      type: "scatter", name: "different part", data: dot("different"), symbolSize: 11, symbol: "diamond",
      itemStyle: { color: COLORS.red, borderColor: "rgba(255,255,255,0.85)", borderWidth: 1 },
      emphasis: { scale: 1.6 },
    },
  ];
  if (data.trend && data.trend.clear) {
    series.push({
      type: "line", name: `${HIDDEN}trend`, silent: true, showSymbol: false, animation: false,
      data: [[data.trend.x0, data.trend.y0], [data.trend.x1, data.trend.y1]],
      lineStyle: { color: COLORS.amber, width: 2, type: "dashed" }, tooltip: { show: false },
    });
  }
  return {
    ...base(data.unit, shown),
    tooltip: {
      ...plainTooltip(),
      formatter: (p: { seriesName: string; value: [number, number]; data: { flags?: string[]; dwell?: number } }) => {
        const flags = (p.data?.flags ?? []).filter((f) => f !== "unsteady").map((f) => f.replace("_", " "));
        return `Part ${p.value[0]}: <b>${posUnit(p.value[1], shown)}</b> high<br/>${p.seriesName}`
          + `${p.data?.dwell !== undefined ? `, ${p.data.dwell.toFixed(1)} s under the sensor` : ""}`
          + `${flags.length ? `<br/>${flags.join(", ")}` : ""}`;
      },
    },
    legend: { top: 0, right: 8, textStyle: { color: COLORS.text },
      data: ["taught part", "different part"] },
    grid: { left: 70, right: 26, top: 30, bottom: 40 },
    xAxis: valueAxis({ name: "part", nameLocation: "end", nameTextStyle: { color: COLORS.dim }, minInterval: 1,
      min: Math.max(0, first - 1), max: last + 1, splitLine: { show: false },
      axisLine: { show: true, lineStyle: { color: COLORS.axis } } }),
    yAxis: valueAxis({ name: `height, ${shown.unit}`, nameTextStyle: { color: COLORS.dim },
      min: lo - pad, max: hi + pad, ...labelsIn(shown, step) }),
    series,
  };
}

/** Good and different parts per period, stacked. */
export function partCountsOption(data: PartCountsData): ChartOption {
  return {
    ...base("parts"),
    tooltip: { ...plainTooltip(), trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { top: 0, right: 8, textStyle: { color: COLORS.text } },
    grid: { left: 52, right: 26, top: 30, bottom: 40 },
    xAxis: { type: "category", data: data.categories, axisLine: { lineStyle: { color: COLORS.axis } },
      axisTick: { show: false }, axisLabel: { color: COLORS.dim, fontSize: 12 } },
    yAxis: valueAxis({ name: "parts", nameTextStyle: { color: COLORS.dim }, minInterval: 1 }),
    series: [
      { type: "bar", name: "taught part", stack: "parts", data: data.good, barMaxWidth: 46,
        itemStyle: { color: COLORS.green, borderRadius: [0, 0, 0, 0] }, emphasis: { focus: "series" } },
      { type: "bar", name: "different part", stack: "parts", data: data.different, barMaxWidth: 46,
        itemStyle: { color: COLORS.red, borderRadius: [3, 3, 0, 0] }, emphasis: { focus: "series" } },
    ],
  };
}

type Mark = Record<string, unknown>;

function stepLabel(n: number, text: string | undefined, active: boolean): Record<string, unknown> {
  return {
    show: true,
    formatter: text ? `{n|${n}} {t|${text}}` : `{n|${n}}`,
    rich: {
      n: { backgroundColor: active ? COLORS.cyan : COLORS.dim, color: "#fff", borderRadius: 10, width: 20, height: 20,
        align: "center", fontFamily: FONT, fontSize: 12, fontWeight: 700 },
      t: { color: active ? THEME.tipText : COLORS.dim, backgroundColor: THEME.labelBg, padding: [3, 6], borderRadius: 4,
        fontFamily: FONT, fontSize: 13, fontWeight: active ? 600 : 400 },
    },
  };
}

/** Which grid an anchor belongs to: every chart has one. */
function gridsFor(_view: ViewData, _anchor: Anchor): number[] {
  return [0];
}

/** Anchor x in the chart's own units. */
function xOf(view: ViewData, anchor: Anchor, key: "t" | "t0" | "t1" = "t"): number | undefined {
  const xKey = key === "t" ? "x" : key === "t0" ? "x0" : "x1";
  if (anchor[key] !== undefined && "t_now" in view && view.view === "timeseries") {
    return (anchor[key] as number) - (view as HistoryData).t_now;
  }
  return anchor[xKey] ?? (anchor[key] as number | undefined);
}

/** The x axis range of a view, where it is known before drawing. */
function xRange(view: ViewData): [number, number] | null {
  switch (view.view) {
    case "timeseries":
      return [-(view as HistoryData).window_s, 0];
    case "histogram":
    case "part_heights": {
      const edges = (view as HistogramData).series.flatMap((s) => [s.edges[0], s.edges[s.edges.length - 1]]);
      return edges.length ? [Math.min(...edges), Math.max(...edges)] : null;
    }
    case "parts": {
      const parts = (view as PartsData).parts;
      return parts.length ? [Math.max(0, parts[0].number - 1), parts[parts.length - 1].number + 1] : null;
    }
    default:
      return null;
  }
}

/** True when a label starting at x would run off the right edge, so it goes to the left instead. */
function nearRight(view: ViewData, x: number): boolean {
  const r = xRange(view);
  return !!r && r[1] > r[0] && (x - r[0]) / (r[1] - r[0]) > 0.72;
}

/** Adds the explanation marks for the steps shown so far; the newest one is highlighted. */
export function withAnnotations(option: ChartOption, view: ViewData, steps: InsightStep[]): ChartOption {
  if (!steps.length) return option;
  const perGrid = new Map<number, { lines: (Mark | Mark[])[]; areas: Mark[][]; points: Mark[] }>();
  const ripples: { grid: number; value: [number | string, number]; active: boolean }[] = [];
  const bucket = (g: number) => {
    if (!perGrid.has(g)) perGrid.set(g, { lines: [], areas: [], points: [] });
    return perGrid.get(g)!;
  };
  const categories: string[] = view.view === "boxplot" ? (view as BoxplotData).categories
    : view.view === "part_counts" ? (view as PartCountsData).categories : [];

  steps.forEach((step, i) => {
    const a = step.anchor;
    if (!a || a.type === "zoom") return;
    const n = i + 1;
    const active = i === steps.length - 1;
    const color = active ? COLORS.cyan : COLORS.dim;
    for (const g of gridsFor(view, a)) {
      const b = bucket(g);
      switch (a.type) {
        case "x": {
          const x = xOf(view, a);
          if (x === undefined) break;
          b.lines.push({ xAxis: x, lineStyle: { color, width: active ? 2.4 : 1.4, type: "solid" },
            label: { show: false } });
          // a line label cannot be moved down reliably, so the label sits on a zero-width area
          const left = nearRight(view, x);
          b.areas.push([{ xAxis: x, itemStyle: { color: "transparent" },
            label: { ...stepLabel(n, a.label, active), position: left ? "insideTopRight" : "insideTopLeft",
              offset: [left ? -2 : 2, (n - 1) * 24] } },
          { xAxis: x }]);
          break;
        }
        case "point": {
          const x = xOf(view, a);
          if (x === undefined || a.y === undefined) break;
          b.points.push({ coord: [x, a.y], symbol: "circle", symbolSize: active ? 14 : 9,
            itemStyle: { color, borderColor: "#fff", borderWidth: 2 },
            label: { ...stepLabel(n, a.label, active), position: "top", distance: 10 } });
          if (active) ripples.push({ grid: g, value: [x, a.y], active });
          break;
        }
        case "xspan": {
          const x0 = xOf(view, a, "t0");
          const x1 = xOf(view, a, "t1");
          if (x0 === undefined || x1 === undefined) break;
          b.areas.push([{ xAxis: x0, itemStyle: { color: hexToRgba(color, active ? 0.16 : 0.07) },
            label: { ...stepLabel(n, a.label, active), position: nearRight(view, x0) ? "insideTopRight" : "insideTopLeft",
              offset: [nearRight(view, x0) ? -2 : 2, (n - 1) * 24] } },
          { xAxis: x1 }]);
          break;
        }
        case "yspan":
          if (a.y0 === undefined || a.y1 === undefined) break;
          b.areas.push([{ yAxis: a.y0, itemStyle: { color: hexToRgba(color, active ? 0.16 : 0.07) },
            label: { ...stepLabel(n, a.label, active), position: "insideTopLeft", offset: [(n - 1) * 30, 0] } },
          { yAxis: a.y1 }]);
          break;
        case "grid": {
          const w = "window_s" in view ? (view as HistoryData).window_s : 0;
          b.areas.push([{ xAxis: -w, itemStyle: { color: hexToRgba(color, active ? 0.12 : 0.05) },
            label: { ...stepLabel(n, a.label, active), position: "insideTopRight" } }, { xAxis: 0 }]);
          break;
        }
        case "category": {
          const name = a.index !== undefined ? categories[a.index] : undefined;
          if (name === undefined) break;
          b.areas.push([{ xAxis: name, itemStyle: { color: hexToRgba(color, active ? 0.18 : 0.07) },
            label: { ...stepLabel(n, a.label, active), position: "insideTop" } }, { xAxis: name }]);
          break;
        }
        case "line":
          if (a.x0 === undefined || a.x1 === undefined || a.y0 === undefined || a.y1 === undefined) break;
          b.lines.push([{ coord: [a.x0, a.y0], lineStyle: { color, width: active ? 3 : 1.6, type: "solid" },
            label: { show: false } }, { coord: [a.x1, a.y1] }]);
          // label just inside the end of the line, on the side the line leaves free
          b.points.push({ coord: [a.x0 + 0.96 * (a.x1 - a.x0), a.y0 + 0.96 * (a.y1 - a.y0)], symbol: "circle",
            symbolSize: 1, itemStyle: { color: "transparent" },
            label: { ...stepLabel(n, a.label, active), position: a.y1 >= a.y0 ? "top" : "bottom", align: "right",
              distance: 8 } });
          break;
      }
    }
  });

  const extra: Record<string, unknown>[] = [];
  perGrid.forEach((b, g) => {
    extra.push({
      type: "line", name: `${HIDDEN}notes`, data: [], xAxisIndex: g, yAxisIndex: g, silent: true, z: 20,
      markLine: { symbol: "none", silent: true, animationDuration: 500, data: b.lines },
      markArea: { silent: true, animationDuration: 500, data: b.areas },
      markPoint: { silent: true, animationDuration: 500, data: b.points },
    });
  });
  for (const r of ripples) {
    extra.push({
      type: "effectScatter", name: `${HIDDEN}pulse`, xAxisIndex: r.grid, yAxisIndex: r.grid, data: [r.value],
      symbolSize: 16, z: 21, silent: true, itemStyle: { color: COLORS.cyan },
      rippleEffect: { brushType: "stroke", scale: 3.2, period: 1.6 },
    });
  }
  const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : [];
  return { ...option, series: [...(series as Record<string, unknown>[]), ...extra] };
}
