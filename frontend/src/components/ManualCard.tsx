// What the manual lookup found, shown on screen while the copilot speaks about it.
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

export function ManualCard() {
  const hit = useStore((s) => s.manualHit);
  const patch = useStore((s) => s.patch);
  if (!hit) return null;
  const shown = hit.passages.slice(0, 3);
  return (
    <aside className="manual-card" aria-label="From the manuals">
      <header>
        <div>
          <h3>From the manuals</h3>
          <p className="muted">“{hit.query}”</p>
        </div>
        <button className="icon-only" onClick={() => patch({ manualHit: null })} title="Close (Esc)">
          <Icon name="close" />
        </button>
      </header>
      {shown.length === 0 ? (
        <p className="muted">{hit.message || "Nothing in the loaded manuals matches this."}</p>
      ) : (
        <ol>
          {shown.map((p) => (
            <li key={p.uid}>
              <a href={p.url ?? api.manualUrl(p.doc, p.page)} target="_blank" rel="noreferrer">
                {p.section && p.section !== p.doc ? p.section : `${p.doc}${p.page ? `, page ${p.page}` : ""}`}
              </a>
              <p>{p.text.length > 300 ? `${p.text.slice(0, 297)}…` : p.text}</p>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
