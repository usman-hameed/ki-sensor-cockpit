import { useEffect, useState } from "react";
import { controller } from "../controller";
import { KIND_LABEL, ago, clock } from "../lib/format";
import { useStore } from "../state/store";

export function EventLog() {
  const events = useStore((s) => s.events);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, []);
  const latest = [...events].reverse().slice(0, 40);

  return (
    <section className="events">
      <header className="section-head">
        <span>Events</span>
        <span className="muted">{events.length}</span>
      </header>
      {latest.length === 0 && <div className="events-empty">No alerts yet. The copilot speaks up when something changes.</div>}
      <ol className="event-list">
        {latest.map((event) => (
          <li key={event.id}>
            <button className={`event event-${event.severity}`} onClick={() => controller.showForEvent(event)}>
              <div className="event-top">
                <span className="event-kind">{KIND_LABEL[event.kind]}</span>
                <span className="event-time" title={clock(event.t)}>{ago(event.t)}</span>
              </div>
              <div className="event-sensor">
                {controller.sensorName(event.sensor)}
                {event.related_sensors.length > 0 && ` + ${event.related_sensors.map((s) => controller.sensorName(s)).join(", ")}`}
              </div>
              <div className="event-summary">{event.summary}</div>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
