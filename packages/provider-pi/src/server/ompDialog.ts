import type { OrchestrationV2UserInputQuestion as Question } from "@t3tools/contracts";
import { parseFragment, type DefaultTreeAdapterTypes as Tree } from "parse5";
import * as Schema from "effect/Schema";

const NativeQuestions = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    header: Schema.optional(Schema.String),
    question: Schema.String,
    options: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        description: Schema.optional(Schema.String),
        preview: Schema.optional(Schema.String),
      }),
    ),
    recommended: Schema.optional(Schema.Number),
    multi: Schema.optional(Schema.Boolean),
  }),
);

const isNativeQuestions = Schema.is(NativeQuestions);

export interface OmpDialog {
  readonly questions: ReadonlyArray<Question>;
  readonly response: (answers: Record<string, unknown>) => Record<string, unknown>;
}

const values = (answer: unknown): string[] =>
  typeof answer === "string"
    ? [answer]
    : Array.isArray(answer)
      ? answer.filter((value): value is string => typeof value === "string")
      : [];

export function ompAsk(input: unknown): OmpDialog | undefined {
  if (!isNativeQuestions(input) || !input.length) return undefined;
  const questions = input.map((q, index): Question => ({
    id: String(index),
    header: q.header?.trim() || q.id.trim() || "Question",
    question: q.question.trim() || q.id.trim() || "Question",
    multiSelect: q.multi ?? false,
    allowCustomAnswer: true,
    options: q.options.map((o) => ({
      label: o.label.trim() || "Empty value",
      value: o.label,
      description: o.description?.trim() || o.label.trim() || "Empty value",
      ...(o.preview ? { preview: o.preview } : {}),
    })),
    ...(q.recommended !== undefined && q.options[q.recommended]
      ? { initialOptionValues: [q.options[q.recommended]!.label] }
      : {}),
  }));
  return {
    questions,
    response: (answers) => ({
      answers: input.map((q, index) => {
        const labels = new Set(q.options.map((o) => o.label));
        const chosen = values(answers[String(index)]);
        return {
          id: q.id,
          selectedOptions: chosen.filter((v) => labels.has(v)),
          customInput: chosen.find((v) => !labels.has(v)),
        };
      }),
    }),
  };
}

const ignored = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "head",
  "title",
  "button",
  "svg",
]);
const attr = (element: Tree.Element, key: string) =>
  element.attrs.find((a) => a.name === key)?.value;
const isElement = (node: Tree.Node): node is Tree.Element => "tagName" in node;

function* descendants(root: Tree.ParentNode, skipControls = false) {
  const remaining: Tree.Node[] = root.childNodes.slice().reverse();
  while (remaining.length) {
    const node = remaining.pop()!;
    if (
      isElement(node) &&
      (ignored.has(node.tagName) ||
        (skipControls && ["textarea", "select", "input"].includes(node.tagName)))
    )
      continue;
    yield node;
    if ("childNodes" in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) remaining.push(node.childNodes[i]!);
    }
  }
}

function textOf(node: Tree.Element, skipControls = false) {
  return Array.from(descendants(node, skipControls), (n) =>
    n.nodeName === "#text" && "value" in n ? n.value : "",
  ).join("");
}

// Yield visible prose in reading order, excluding text owned by labels and inputs.
function* formContents(root: Tree.ParentNode): Generator<string | Tree.Element> {
  const stack = root.childNodes
    .slice()
    .reverse()
    .map((node) => ({ node, caption: true }));
  while (stack.length) {
    const { node, caption } = stack.pop()!;
    if (!isElement(node)) {
      if (caption && "value" in node) yield node.value;
      continue;
    }
    if (ignored.has(node.tagName)) continue;
    if (["input", "select", "textarea"].includes(node.tagName)) {
      yield node;
      continue;
    }
    if (caption && node.tagName === "img") yield attr(node, "alt") ?? "";
    if (
      caption &&
      ["br", "p", "li", "div", "legend", "tr", "pre", "h1", "h2", "h3", "h4", "h5", "h6"].includes(
        node.tagName,
      )
    )
      yield "\n";
    for (let index = node.childNodes.length - 1; index >= 0; index--) {
      stack.push({ node: node.childNodes[index]!, caption: caption && node.tagName !== "label" });
    }
  }
}

function captionText(parts: string[]) {
  return parts
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function nearest(node: Tree.Element, tag: string) {
  for (let p = node.parentNode; p && isElement(p); p = p.parentNode)
    if (p.tagName === tag) return p;
  return undefined;
}

interface Choice {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  checked: boolean;
}

interface FormField {
  readonly name: string;
  readonly prompt: string;
  readonly type: string;
  required: boolean;
  readonly value: string;
  readonly choices: Choice[];
  readonly multiple: boolean;
}

export function ompForm(html: unknown): OmpDialog | undefined {
  if (typeof html !== "string" || !html.trim()) return undefined;
  const document = parseFragment(html);
  const form =
    descendants(document).find((n): n is Tree.Element => isElement(n) && n.tagName === "form") ??
    document;

  const labels = new Map<string, string>();
  for (const el of descendants(form)) {
    if (!isElement(el) || el.tagName !== "label") continue;
    const target = attr(el, "for");
    if (target && !labels.has(target)) labels.set(target, textOf(el, true).trim());
  }
  const fields: FormField[] = [];
  const groups = new Map<string, FormField>();
  let context: string[] = [];
  for (const el of formContents(form)) {
    if (typeof el === "string") {
      context.push(el);
      continue;
    }
    const tag = el.tagName;
    const name = attr(el, "name");
    if (!name) continue;
    const type = tag === "input" ? (attr(el, "type") ?? "text").toLowerCase() : tag;
    if (["button", "hidden", "image", "file", "reset", "submit"].includes(type)) continue;
    const grouped = type === "checkbox" || type === "radio";
    const wrapping = nearest(el, "label");
    const label =
      (wrapping && textOf(wrapping, true).trim()) ||
      labels.get(attr(el, "id") ?? "") ||
      attr(el, "aria-label") ||
      attr(el, "title") ||
      "";
    const groupKey = type + "\0" + name;
    let field = grouped ? groups.get(groupKey) : undefined;
    if (!field) {
      const prompt = [captionText(context), !grouped && label].filter(Boolean).join("\n\n");
      field = {
        name,
        type,
        prompt: prompt || (grouped ? "" : attr(el, "placeholder")) || name,
        value: tag === "textarea" ? textOf(el) : (attr(el, "value") ?? ""),
        required: false,
        multiple: type === "checkbox" || (tag === "select" && attr(el, "multiple") !== undefined),
        choices: [],
      };
      fields.push(field);
      if (grouped) groups.set(groupKey, field);
      context = [];
    }
    field.required ||= attr(el, "required") !== undefined;
    if (grouped) {
      const value = attr(el, "value") ?? "on";
      field.choices.push({
        label: label || value || name,
        value,
        checked: attr(el, "checked") !== undefined,
        disabled: attr(el, "disabled") !== undefined,
      });
    } else if (tag === "select") {
      for (const option of descendants(el)) {
        if (!isElement(option) || option.tagName !== "option") continue;
        const title = textOf(option).replace(/\s+/g, " ").trim();
        const value = attr(option, "value") ?? title;
        field.choices.push({
          label: title || value || name,
          value,
          checked: attr(option, "selected") !== undefined,
          disabled: attr(option, "disabled") !== undefined,
        });
      }
      const first = field.choices.find((o) => !o.disabled);
      if (!field.multiple && first && !field.choices.some((o) => o.checked)) first.checked = true;
    }
  }

  const questions = fields.map((field, index): Question => {
    const choices = field.choices.filter((o) => !o.disabled);
    const choice = ["checkbox", "radio", "select"].includes(field.type);
    const other =
      field.type !== "select" &&
      field.choices.length > 1 &&
      !field.choices.some((o) => /^\s*other\b/i.test(o.label));
    return {
      id: String(index),
      header: field.name.trim() || "Question",
      question:
        [field.prompt, ...(index === fields.length - 1 ? [captionText(context)] : [])]
          .join("\n\n")
          .trim() || "Question",
      options: choices.map((o) => ({
        label: o.label.trim() || field.name.trim() || "Empty value",
        description: o.label.trim() || "Empty value",
        value: o.value,
      })),
      required: field.required,
      // A lone checkbox uses multi-select in the card so it can be unchecked, but OMP accepts a scalar.
      multiSelect: field.multiple,
      allowCustomAnswer: !choice || other,
      ...(choice
        ? { initialOptionValues: choices.filter((o) => o.checked).map((o) => o.value) }
        : { initialAnswer: field.value }),
    };
  });
  if (!questions.length)
    questions.push({
      id: "continue",
      header: "Form",
      question: captionText(context) || "Continue?",
      options: [{ label: "Continue", description: "Continue" }],
      allowCustomAnswer: false,
    });
  return {
    questions,
    response: (answers) => ({
      data: Object.fromEntries(
        fields.flatMap((f, i): [string, string | string[]][] => {
          const chosen = values(answers[String(i)]);
          if (f.multiple && f.choices.length > 1) return [[f.name, chosen]];
          return chosen.length ? [[f.name, chosen[0]!]] : [];
        }),
      ),
    }),
  };
}
