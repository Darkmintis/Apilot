import { Fragment, useMemo, useState } from "react";
import { diffLines, diffWordsWithSpace } from "diff";

type Side = { n: number; text: string; kind: "ctx" | "del" | "add" | "empty"; pair?: string };
type Row = { l: Side; r: Side } | { fold: number; start: number };

const CONTEXT = 3;

/** GitHub-style split diff with folded unchanged regions and word highlights. */
export function JsonDiff({ left, right, leftTitle, rightTitle }: { left: string; right: string; leftTitle: string; rightTitle: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const rows = useMemo(() => buildRows(left, right), [left, right]);
  const visible = useMemo(() => fold(rows, open), [rows, open]);
  const changed = rows.some((r) => "l" in r && (r.l.kind !== "ctx" || r.r.kind !== "ctx"));

  return (
    <div className="diff">
      <div className="diff-head">
        <span className="del-t">{leftTitle}</span>
        <span className="add-t">{rightTitle}</span>
      </div>
      {!changed && <div className="muted small pad">Bodies are identical.</div>}
      <table>
        <colgroup>
          <col className="ln-col" />
          <col />
          <col className="ln-col" />
          <col />
        </colgroup>
        <tbody>
          {visible.map((row, i) =>
            "fold" in row ? (
              <tr key={`f${i}`} className="fold">
                <td colSpan={4}>
                  <button className="link" onClick={() => setOpen(new Set(open).add(row.start))}>
                    ⋯ Show {row.fold} unchanged line{row.fold === 1 ? "" : "s"}
                  </button>
                </td>
              </tr>
            ) : (
              <tr key={i}>
                <Cell side={row.l} />
                <Cell side={row.r} />
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ side }: { side: Side }) {
  if (side.kind === "empty") return <><td className="ln empty" /><td className="code empty" /></>;
  return (
    <>
      <td className={`ln ${side.kind}`}>{side.n}</td>
      <td className={`code ${side.kind}`}>
        <span className="sign">{side.kind === "del" ? "−" : side.kind === "add" ? "+" : " "}</span>
        {side.pair !== undefined ? <Words a={side.kind === "del" ? side.text : side.pair} b={side.kind === "del" ? side.pair : side.text} show={side.kind} /> : side.text}
      </td>
    </>
  );
}

function Words({ a, b, show }: { a: string; b: string; show: "del" | "add" | "ctx" | "empty" }) {
  const parts = diffWordsWithSpace(a, b);
  return (
    <>
      {parts.map((p, i) =>
        show === "del" ? (p.added ? null : <Fragment key={i}>{p.removed ? <mark>{p.value}</mark> : p.value}</Fragment>)
        : p.removed ? null : <Fragment key={i}>{p.added ? <mark>{p.value}</mark> : p.value}</Fragment>
      )}
    </>
  );
}

const split = (s: string) => {
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

function buildRows(left: string, right: string): Row[] {
  const rows: Row[] = [];
  let ln = 1;
  let rn = 1;
  const parts = diffLines(left, right);
  const empty: Side = { n: 0, text: "", kind: "empty" };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const lines = split(p.value);
    if (p.removed && parts[i + 1]?.added) {
      const added = split(parts[++i]!.value);
      for (let j = 0; j < Math.max(lines.length, added.length); j++) {
        const a = lines[j];
        const b = added[j];
        rows.push({
          l: a !== undefined ? { n: ln++, text: a, kind: "del", pair: b } : empty,
          r: b !== undefined ? { n: rn++, text: b, kind: "add", pair: a } : empty,
        });
      }
    } else if (p.removed) {
      lines.forEach((t) => rows.push({ l: { n: ln++, text: t, kind: "del" }, r: empty }));
    } else if (p.added) {
      lines.forEach((t) => rows.push({ l: empty, r: { n: rn++, text: t, kind: "add" } }));
    } else {
      lines.forEach((t) => rows.push({ l: { n: ln++, text: t, kind: "ctx" }, r: { n: rn++, text: t, kind: "ctx" } }));
    }
  }
  return rows;
}

function fold(rows: Row[], open: Set<number>): Row[] {
  const isCtx = (r: Row) => "l" in r && r.l.kind === "ctx";
  const out: Row[] = [];
  let i = 0;
  while (i < rows.length) {
    if (!isCtx(rows[i]!)) {
      out.push(rows[i++]!);
      continue;
    }
    let j = i;
    while (j < rows.length && isCtx(rows[j]!)) j++;
    const head = i === 0 ? 0 : CONTEXT;
    const tail = j === rows.length ? 0 : CONTEXT;
    const hidden = j - i - head - tail;
    if (hidden > 1 && !open.has(i)) {
      out.push(...rows.slice(i, i + head), { fold: hidden, start: i }, ...rows.slice(j - tail, j));
    } else {
      out.push(...rows.slice(i, j));
    }
    i = j;
  }
  return out;
}
