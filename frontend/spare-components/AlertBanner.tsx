import { controller } from "../controller";
import { KIND_LABEL, SEVERITY_LABEL } from "../lib/format";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

export function AlertBanner() {
  const alert = useStore((s) => s.alert);
  const patch = useStore((s) => s.patch);
  if (!alert) return null;
  return (
    <div key={alert.id} className={`alert alert-${alert.severity}`} role="alert">
      <div className="alert-icon">
        <Icon name="bolt" size={22} />
      </div>
      <div className="alert-body">
        <div className="alert-kicker">
          {SEVERITY_LABEL[alert.severity]} · {KIND_LABEL[alert.kind]} · {controller.sensorName(alert.sensor)}
          {alert.forecast_min !== null && <> · limit in ~{Math.round(alert.forecast_min)} min</>}
        </div>
        <div className="alert-text">{alert.summary}</div>
      </div>
      <div className="alert-actions">
        <button className="btn btn-accent" onClick={() => controller.showForEvent(alert)}>Show me</button>
        <button className="icon-btn" onClick={() => patch({ alert: null })} title="Dismiss">
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
