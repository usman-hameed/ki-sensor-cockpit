// The manuals the AI reads when it recommends what to check: add or remove PDFs, and try a question.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import type { ManualAnswer, ManualLibrary } from "../types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

function size(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ManualSheet() {
  const open = useStore((s) => s.manualsOpen);
  const knowledge = useStore((s) => s.knowledge);
  const patch = useStore((s) => s.patch);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<ManualAnswer | null>(null);
  const [library, setLibrary] = useState<ManualLibrary | null>(null);
  useEffect(() => {
    if (!open) return;
    let stop = false;
    const load = () => api.manualLibrary().then((l) => { if (!stop) setLibrary(l); }).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 4000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [open]);
  if (!open) return null;

  const close = () => patch({ manualsOpen: false });
  const fail = (e: unknown, prefix = "") => setError(`${prefix}${e instanceof Error ? e.message : String(e)}`);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      setBusy(`Reading ${file.name}…`);
      try {
        patch({ knowledge: await api.uploadManual(file) });
      } catch (e) {
        fail(e, `${file.name}: `);
      }
    }
    setBusy(null);
  };

  const remove = async (name: string) => {
    setError(null);
    try {
      patch({ knowledge: await api.deleteManual(name) });
    } catch (e) {
      fail(e);
    }
  };

  const ask = async () => {
    if (!question.trim()) return;
    setError(null);
    setBusy("Reading the manuals…");
    setAnswer(null);
    try {
      setAnswer(await api.askManual(question.trim()));
    } catch (e) {
      fail(e);
    }
    setBusy(null);
  };

  const emb = knowledge?.embeddings;
  const searchLine = !knowledge
    ? ""
    : emb?.enabled
      ? emb.error
        ? `Keyword search for now. Search by meaning is not available: ${emb.error}`
        : `Search by meaning and keywords (${emb.model}). ${emb.ready} of ${knowledge.passages} passages indexed.`
      : "Keyword search only. With an OpenAI key the search also works by meaning.";
  const docs = knowledge?.documents ?? [];

  return (
    <div className="sheet-backdrop" onClick={close}>
      <section className="sheet sheet-rec" role="dialog" aria-label="Manuals" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Manuals</h2>
          <div className="sheet-tools">
            <button className="icon-only" onClick={close} title="Close (Esc)"><Icon name="close" /></button>
          </div>
        </header>
        <div className="rec-body">
          <section className="rec-step">
            <h3>What the AI reads</h3>
            <p className="muted">
              When the AI recommends what to check, it reads the passages of these manuals that match the incident,
              and quotes the page. Add the manuals of the sensors in your setup. They stay on this computer, in the
              folder backend/data/knowledge.
            </p>
            {docs.length === 0 && <p className="rec-warn">No manual is loaded yet. Recommendations then rest on the measurements alone.</p>}
            {docs.length > 0 && (
              <ul className="man-list">
                {docs.map((doc) => (
                  <li key={doc.name}>
                    <a href={api.manualUrl(doc.name, null)} target="_blank" rel="noreferrer">{doc.name}</a>
                    <span className="muted">
                      {doc.pages > 0 ? `${doc.pages} pages · ` : ""}{doc.passages} passages · {size(doc.bytes)}
                    </span>
                    <button className="quiet-btn" onClick={() => void remove(doc.name)}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="rec-actions">
              <label className="solid-btn rec-file">
                Add a manual
                <input type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" multiple hidden
                  onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
              </label>
              <span className="muted">PDF, text or Markdown</span>
            </div>
            {knowledge?.warnings.map((w, i) => <p key={i} className="rec-warn">{w}</p>)}
            {busy && <p className="muted">{busy}</p>}
            {error && <p className="rec-error">{error}</p>}
            {searchLine && <p className="muted">{searchLine}</p>}
          </section>

          <section className="rec-step">
            <h3>Ask the manuals</h3>
            <p className="muted">
              Answers come only from the loaded manuals, every value with its section and page. For example: what is
              the linearity of the ILD5500-50, or what does a red LED mean?
            </p>
            <form className="man-ask" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
              <input type="text" value={question} placeholder="Ask the manuals" onChange={(e) => setQuestion(e.target.value)} />
              <button className="solid-btn" type="submit" disabled={!question.trim() || docs.length === 0 || busy !== null}>Ask</button>
            </form>
            {library && library.documents > 0 && (
              <p className="muted">
                Library: {library.documents} manuals, {Object.keys(library.families).length} product families, {library.passages.toLocaleString()} passages
                {library.state === "indexing" && " · reading the manuals…"}
                {library.state === "embedding" && ` · indexing by meaning ${Math.round(100 * library.embedded / Math.max(1, library.passages))} %`}
                {library.active_product && ` · answers for ${library.active_product} unless you name another model`}
              </p>
            )}
            {answer?.scope?.product && (
              <p className="man-scope">From the manuals of <strong>{answer.scope.product}</strong> ({answer.scope.source})</p>
            )}
            {answer?.scope && !answer.scope.product && answer.found && (
              <p className="man-scope">From all manuals: no product named and no sensor connected</p>
            )}
            {answer && (
              <div className={`man-answer ${answer.found ? "" : "is-missing"}`}>
                <Markdown text={answer.answer} />
              </div>
            )}
            {answer?.found && answer.mode === "extractive" && (
              <p className="muted">Quoted from the manual. With an OpenAI key the answer is written out.</p>
            )}
            {answer && answer.sources.length > 0 && (
              <ol className="man-hits">
                {answer.sources.map((hit, n) => (
                  <li key={hit.id}>
                    <a href={hit.url} target="_blank" rel="noreferrer">
                      S{n + 1} · {hit.citation}
                    </a>
                    <p>{hit.text.length > 420 ? `${hit.text.slice(0, 417)}…` : hit.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
