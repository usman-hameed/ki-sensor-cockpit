// The big live diagram: the last 10 or 30 seconds of every shown sensor, alerts shaded.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { echarts, type ChartOption } from "../lib/charts";
import { series, serverNow } from "../lib/live";
import { shownFor } from "../lib/units";
import { useStore } from "../state/store";
import { de, unitOf } from "./de";

export const LINE_COLORS = ["#c4161c", "#1d2329", "#1e6fd9", "#d97706"];
const SHADE_KINDS = new Set(["wrong_part", "invalid", "out_of_range"]);

export interface LiveChartHandle {
  image: () => string | null;
  /** min, max of what the chart shows now, per sensor, in µm */
  span: (sensor: string) => { min: number; max: number } | null;
}

export const LiveChart = forwardRef<LiveChartHandle, { windowS: number; paused: boolean; hidden: Set<string>; compact?: boolean }>(
  function LiveChart({ windowS, paused, hidden, compact }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const chart = useRef<echarts.ECharts | null>(null);
    const spans = useRef(new Map<string, { min: number; max: number }>());
    const props = useRef({ windowS, paused, hidden });
    props.current = { windowS, paused, hidden };

    useImperativeHandle(ref, () => ({
      image: () => chart.current?.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#fff" }) ?? null,
      span: (sensor) => spans.current.get(sensor) ?? null,
    }), []);

    useEffect(() => {
      if (!host.current) return;
      const c = echarts.init(host.current, undefined, { renderer: "canvas" });
      chart.current = c;
      const ro = new ResizeObserver(() => c.resize());
      ro.observe(host.current);
      let raf = 0;
      let last = 0;
      const draw = (now: number) => {
        raf = requestAnimationFrame(draw);
        if (now - last < 200 || props.current.paused) return;
        last = now;
        const state = useStore.getState();
        const sensors = (state.config?.sensors ?? []).filter((s) => !props.current.hidden.has(s.id));
        const win = props.current.windowS;
        const tNow = serverNow();
        const lines: Record<string, unknown>[] = [];
        let unit = "";
        sensors.forEach((sensor, i) => {
          const shown = shownFor(sensor);
          const scale = shown.display?.scale ?? 1;
          unit = unitOf(sensor);
          const data: [number, number | null][] = [];
          let min = Infinity;
          let max = -Infinity;
          series(sensor.id).forEachSince(tNow - win, (t, v) => {
            const ok = Number.isFinite(v);
            if (ok) { min = Math.min(min, v); max = Math.max(max, v); }
            data.push([t - tNow, ok ? v * scale : null]);
          });
          if (Number.isFinite(min)) spans.current.set(sensor.id, { min, max });
          const marks = state.events
            .filter((e) => e.sensor === sensor.id && SHADE_KINDS.has(e.kind) && e.t >= tNow - win - 5)
            .map((e) => {
              const active = state.status?.sensors[sensor.id]?.active.includes(e.kind);
              const end = active ? 0 : Math.min(e.t + 3 - tNow, 0);
              return [{ xAxis: Math.max(e.t - tNow, -win) }, { xAxis: end }];
            });
          lines.push({
            type: "line", name: sensor.name, data, showSymbol: false, connectNulls: false, animation: false,
            lineStyle: { width: 1.4, color: LINE_COLORS[i % LINE_COLORS.length] },
            itemStyle: { color: LINE_COLORS[i % LINE_COLORS.length] },
            markArea: marks.length ? { silent: true, itemStyle: { color: "rgba(196,22,28,0.08)" }, data: marks } : undefined,
          });
        });
        const option: ChartOption = {
          animation: false,
          grid: compact ? { left: 52, right: 12, top: 22, bottom: 24 } : { left: 64, right: 18, top: 28, bottom: 30 },
          tooltip: { trigger: "axis", valueFormatter: (v: unknown) => (typeof v === "number" ? `${de(v, 4)} ${unit}` : "–") },
          xAxis: {
            type: "value", min: -win, max: 0, splitNumber: 4,
            axisLine: { lineStyle: { color: "#dcdfe4" } }, axisTick: { show: false },
            splitLine: { lineStyle: { color: "#eceef1" } },
            axisLabel: { color: "#68717b", fontSize: 12, formatter: (v: number) => (v === 0 ? "now" : `${de(v, 0)} s`) },
          },
          yAxis: {
            type: "value", scale: true, name: unit, nameTextStyle: { color: "#68717b", fontSize: 11, align: "left" },
            axisLine: { show: false }, splitLine: { lineStyle: { color: "#eceef1" } },
            axisLabel: { color: "#68717b", fontSize: 12, formatter: (v: number) => de(v, 3) },
          },
          series: lines,
        };
        c.setOption(option, { notMerge: true, lazyUpdate: true });
      };
      raf = requestAnimationFrame(draw);
      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        c.dispose();
        chart.current = null;
      };
    }, [compact]);

    return <div className="live-chart" ref={host} />;
  });
