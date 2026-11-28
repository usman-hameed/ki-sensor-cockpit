// A small Markdown renderer for AI answers: paragraphs, lists, tables, bold, code and citation chips.
import { Fragment, type ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[(?:S\d+[^\]]*|Section[^\]]*|Page[^\]]*|Tab\.[^\]]*|Fig\.[^\]]*)\])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) out.push(<strong key={m.index}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={m.index}>{token.slice(1, -1)}</code>);
    else out.push(<span key={m.index} className="manual-chip">{token.slice(1, -1)}</span>);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div className="manual-table" key={`t${i}`}>
          <table>
            <thead><tr>{head.map((h, j) => <th key={j}>{inline(h)}</th>)}</tr></thead>
            <tbody>{rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*•]|\d+\.)\s+/, ""));
      }
      blocks.push(<ul key={`l${i}`}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ul>);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      blocks.push(<h3 key={`h${i}`}>{inline(heading[1])}</h3>);
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*•]\s|\d+\.\s|#)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push(<p key={`p${i}`}>{para.map((p, k) => <Fragment key={k}>{k > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return <>{blocks}</>;
}
