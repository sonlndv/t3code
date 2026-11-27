import { describe, expect, it } from "vite-plus/test";
import { ompAsk, ompForm } from "./ompDialog.ts";

describe("OMP native questions", () => {
  it("returns ordered ask answers with option labels and custom text", () => {
    const dialog = ompAsk([
      {
        id: "multiple",
        question: "Features?",
        options: [{ label: "A" }, { label: "B" }],
        multi: true,
        recommended: 1,
      },
      { id: "single", question: "Why?", options: [] },
    ]);
    expect(dialog?.questions[0]?.initialOptionValues).toEqual(["B"]);
    expect(dialog?.response({ "1": "for testing", "0": ["B", "A"] })).toEqual({
      answers: [
        { id: "multiple", selectedOptions: ["B", "A"] },
        { id: "single", selectedOptions: [], customInput: "for testing" },
      ],
    });
  });

  it("preserves OMP scalar, array and omitted form values, including reserved names", () => {
    const dialog = ompForm(`<form><label><input type=checkbox name="multi" value="a,b">First</label>
      <label><input type=checkbox name="multi" value="b" disabled>Disabled</label>
      <label><input type=checkbox name="single" value="yes">Agree</label>
      <select multiple name="one"><option value="x" selected>X</option></select>
      <input type="hidden" name="secret" value="x"><textarea name="__proto__">a &amp; b</textarea>
      </form>`);
    expect(dialog?.questions.map((q) => q.options.map((o) => o.label))).toEqual([
      ["First"],
      ["Agree"],
      ["X"],
      [],
    ]);
    expect(dialog?.questions[3]?.initialAnswer).toBe("a & b");
    expect(dialog?.response({ "0": ["a,b"], "1": [], "2": ["x"], "3": "ok" })).toEqual({
      data: { multi: ["a,b"], one: "x", ["__proto__"]: "ok" },
    });
  });
});
