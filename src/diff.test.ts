import { lineDiff, splitDiffRows } from "./diff.ts";

Deno.test("lineDiff reports changed lines and line numbers", () => {
  const lines = lineDiff("one\ntwo\nthree", "one\nchanged\nthree", 3);
  if (!lines.some((line) => line.kind === "removed" && line.text === "two" && line.oldLine === 2)) throw new Error("missing removal");
  if (!lines.some((line) => line.kind === "added" && line.text === "changed" && line.newLine === 2)) throw new Error("missing addition");
});

Deno.test("lineDiff collapses distant unchanged lines", () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  const after = before.replace("line 10", "changed");
  if (!lineDiff(before, after, 2).some((line) => line.kind === "gap")) throw new Error("missing collapsed context");
});

Deno.test("splitDiffRows aligns removed and added lines into two columns", () => {
  const rows = splitDiffRows(lineDiff("same\nold one\nold two\nend", "same\nnew one\nend", 99));
  const changed = rows.filter((row) => !("gap" in row) && (row.left?.kind !== "same" || row.right?.kind !== "same"));
  if (changed.length !== 2 || "gap" in changed[0] || "gap" in changed[1]) throw new Error("expected two changed rows");
  if (changed[0].left?.text !== "old one" || changed[0].right?.text !== "new one") throw new Error("first changed row was not aligned");
  if (changed[1].left?.text !== "old two" || changed[1].right !== null) throw new Error("missing empty Drive-side cell");
});
