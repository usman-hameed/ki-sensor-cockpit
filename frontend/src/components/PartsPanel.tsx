// The quality station: every part that rested under the sensor, its height and verdict, and the rhythm of the line.
import { useEffect, useState } from "react";
import { controller } from "../controller";
import { api } from "../lib/api";
import { clock } from "../lib/format";
import { shownFor } from "../lib/units";
import { useStore } from "../state/store";
import type { PartRecord, StationState } from "../types";
import { Icon } from "./Icon";

const FLAG_WORDS: Record<string, string> = {
  jam: "possible jam",
  double_feed: "possible double feed",
  unsteady: "never steady",
};

function rhythmText(station: StationState): string {
  const r = station.rhythm;
  if (!r.known) {
    const left = Math.max(3 - station.parts, 1);
    return `Learning the rhythm of the parts: ${left} more part${left === 1 ? "" : "s"}.`;
  }
  const stay = r.dwell_s !== null ? `Parts usually stay ${r.dwell_s.toFixed(1)} s` : "";
  const gap = r.gap_s !== null ? ` and come ${r.gap_s.toFixed(1)} s apart` : "";
  return `${stay}${gap}. A part that stays longer than 6 s is a possible jam, one that comes less than 2 s after the one before a possible double feed.`;
}

function trendText(station: StationState): { text: string; warn: boolean } {
  const t = station.trend;
  if (!t) return { text: "The height trend shows after 8 good parts.", warn: false };
  if (!t.clear) return { text: "No trend in the heights: the good parts scatter around the same value.", warn: false };
  const left = t.parts_to_limit !== null ? ` At this rate they leave the band in about ${Math.round(t.parts_to_limit)} part${Math.round(t.parts_to_limit) === 1 ? "" : "s"}.` : "";
  return { text: `The good parts get ${t.direction} by ${Math.abs(t.slope_um_per_part).toFixed(1)} µm per part.${left}`,
    warn: t.parts_to_limit !== null && t.parts_to_limit <= 40 };
}

export function PartsPanel() {
  const sensor = useStore((s) => s.partsFor);
  const patch = useStore((s) => s.patch);
  const info = useStore((s) => s.config?.sensors.find((x) => x.id === sensor));
  const station = useStore((s) => (sensor ? s.status?.sensors[sensor]?.station : undefined));
  const log = useStore((s) => (sensor ? s.partLog[sensor] : undefined));
  const [confirm, setConfirm] = useState(false);

  useEffect(() => setConfirm(false), [sensor]);
  if (!sensor) return null;
  const close = () => patch({ partsFor: null });

  const shown = shownFor(info);
  const scale = shown.display?.scale ?? 1;
  const length = (um: number | null | undefined) =>
    um === null || um === undefined ? "–" : `${(um * scale).toFixed(shown.display ? 3 : 1)} ${shown.unit}`;
  const records: PartRecord[] = log ?? [];
  const trend = station ? trendText(station) : null;
  const chart = (view: "parts" | "part_counts" | "part_heights") => {
    close();
    void controller.makeChart({ view, sensors: [sensor] }, false);
  };

  return (
    <div className="sheet-backdrop" onClick={close}>
      <section className="sheet sheet-parts" role="dialog" aria-label="Quality station" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Quality station{info ? `: ${info.name}` : ""}</h2>
          <button className="icon-only" onClick={close} title="Close (Esc)"><Icon name="close" /></button>
        </header>
        <div className="assist parts">
          {!station && <p className="assist-error">Waiting for the cockpit.</p>}
          {station && !station.ready && station.parts === 0 && (
            <>
              <p className="assist-verdict">{station.message}</p>
              <div className="part-actions">
                <button className="solid-btn" onClick={() => controller.openPartCheck(sensor)}>Open the part check</button>
              </div>
            </>
          )}
          {station && (station.ready || station.parts > 0) && (
            <>
              <div className="parts-numbers">
                <div>
                  <span className="assist-label">Parts</span>
                  <span className="assist-big" key={`n-${station.parts}`}>{station.parts}</span>
                  <span className="assist-label">{station.per_minute !== null ? `${station.per_minute} per minute` : "this run"}</span>
                </div>
                <div>
                  <span className="assist-label">Taught part</span>
                  <span className="assist-big part-match">{station.good}</span>
                  <span className="assist-label">good</span>
                </div>
                <div>
                  <span className="assist-label">Different part</span>
                  <span className={`assist-big ${station.different ? "part-different" : "is-quiet"}`}>{station.different}</span>
                  <span className="assist-label">
                    {station.jams || station.double_feeds
                      ? [station.jams ? `${station.jams} jam${station.jams === 1 ? "" : "s"}` : "",
                         station.double_feeds ? `${station.double_feeds} double feed${station.double_feeds === 1 ? "" : "s"}` : ""]
                          .filter(Boolean).join(", ")
                      : "flagged"}
                  </span>
                </div>
                <div>
                  <span className="assist-label">Yield</span>
                  <span className="assist-big is-quiet">{station.yield_percent !== null ? `${station.yield_percent.toFixed(0)} %` : "–"}</span>
                  <span className="assist-label">taught part</span>
                </div>
              </div>

              <p className={`assist-verdict parts-now ${station.current?.flags.includes("jam") ? "is-warn" : ""}`}>
                {station.current
                  ? <>Part {station.current.number} is under the sensor ({station.current.since_s.toFixed(0)} s){station.current.flags.includes("jam") ? ": possible jam" : ""}.</>
                  : station.ready ? "The plate is empty: waiting for the next part." : station.message}
              </p>
              <ul className="assist-reasons parts-facts">
                <li>{rhythmText(station)}</li>
                {trend && <li className={trend.warn ? "is-warn" : ""}>{trend.text}</li>}
              </ul>

              <div className="part-actions">
                <button className="solid-btn" onClick={() => chart("parts")}>Height of every part</button>
                <button className="btn" onClick={() => chart("part_counts")}>Bar chart</button>
                <button className="btn" onClick={() => chart("part_heights")}>Height spread</button>
                <button className="btn" onClick={() => patch({ partsFor: null, reportId: `run:${sensor}` })}>Run report and QR</button>
                <a className="btn" href={api.partsCsvUrl(sensor)} download>Download for Excel</a>
                {!confirm && <button className="quiet-btn" onClick={() => setConfirm(true)}>New run</button>}
                {confirm && (
                  <>
                    <button className="danger-btn" onClick={() => { void controller.newRun(sensor); setConfirm(false); }}>
                      Clear the part log
                    </button>
                    <button className="quiet-btn" onClick={() => setConfirm(false)}>Keep it</button>
                  </>
                )}
              </div>

              {records.length > 0 ? (
                <div className="parts-table-wrap">
                  <table className="parts-table">
                    <thead>
                      <tr><th>Part</th><th>Time</th><th>Height</th><th>Verdict</th><th>Stay</th><th>Gap</th><th>Note</th></tr>
                    </thead>
                    <tbody>
                      {records.map((r) => (
                        <tr key={r.number} className={`is-${r.verdict} is-link`} title="Open the part passport with its QR code"
                          onClick={() => patch({ partsFor: null, reportId: `part:${sensor}:${r.number}` })}>
                          <td>{r.number}{r.photo ? <> {"📷"}</> : null}</td>
                          <td>{clock(r.t_start)}</td>
                          <td className="num">{length(r.height_um)}</td>
                          <td><span className={`verdict verdict-${r.verdict}`}>{r.verdict === "good" ? "taught part" : "different part"}</span></td>
                          <td className="num">{r.dwell_s.toFixed(1)} s</td>
                          <td className="num">{r.gap_s === null ? "–" : `${r.gap_s.toFixed(1)} s`}</td>
                          <td>{r.flags.map((f) => FLAG_WORDS[f] ?? f).join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="assist-note">No parts yet. Put a part under the sensor, take it away: it is counted when it leaves.</p>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
