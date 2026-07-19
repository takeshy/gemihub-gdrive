export type DiffLine = {
  kind: "same" | "added" | "removed" | "gap";
  text: string;
  oldLine?: number;
  newLine?: number;
};

function splitLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function roughDiff(before: string[], after: string[]): Array<Omit<DiffLine, "oldLine" | "newLine">> {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return [
    ...before.slice(0, prefix).map((text) => ({ kind: "same" as const, text })),
    ...before.slice(prefix, before.length - suffix).map((text) => ({ kind: "removed" as const, text })),
    ...after.slice(prefix, after.length - suffix).map((text) => ({ kind: "added" as const, text })),
    ...before.slice(before.length - suffix).map((text) => ({ kind: "same" as const, text })),
  ];
}

/** Line-oriented LCS diff with a bounded fallback for very large files. */
export function lineDiff(beforeText: string, afterText: string, context = 3): DiffLine[] {
  const before = splitLines(beforeText), after = splitLines(afterText);
  let raw: Array<Omit<DiffLine, "oldLine" | "newLine">>;
  if (before.length * after.length > 500_000) raw = roughDiff(before, after);
  else {
    const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
    for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    raw = [];
    let i = 0, j = 0;
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && before[i] === after[j]) { raw.push({ kind: "same", text: before[i] }); i++; j++; }
      else if (j < after.length && (i === before.length || table[i][j + 1] >= table[i + 1][j])) { raw.push({ kind: "added", text: after[j++] }); }
      else { raw.push({ kind: "removed", text: before[i++] }); }
    }
  }

  let oldLine = 1, newLine = 1;
  const numbered = raw.map((line): DiffLine => {
    const result = { ...line, oldLine: line.kind === "added" ? undefined : oldLine, newLine: line.kind === "removed" ? undefined : newLine };
    if (line.kind !== "added") oldLine++;
    if (line.kind !== "removed") newLine++;
    return result;
  });
  const changed = numbered.map((line) => line.kind !== "same");
  const keep = changed.map((value, index) => value || changed.some((other, otherIndex) => other && Math.abs(otherIndex - index) <= context));
  const result: DiffLine[] = [];
  for (let index = 0; index < numbered.length;) {
    if (keep[index]) { result.push(numbered[index++]); continue; }
    const start = index;
    while (index < numbered.length && !keep[index]) index++;
    result.push({ kind: "gap", text: `${index - start} unchanged line(s)` });
  }
  return result;
}
