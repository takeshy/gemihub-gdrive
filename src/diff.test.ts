import { lineDiff } from "./diff.ts";

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
