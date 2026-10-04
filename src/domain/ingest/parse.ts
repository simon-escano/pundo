import { RecipeSchema, type Recipe } from "../schemas/blueprint";
import { checkInvariants, findPriceFields, type IngestIssue } from "./invariants";

export type { IngestIssue };
export type IngestResult =
  | { ok: true; recipe: Recipe; warnings: IngestIssue[] }
  | { ok: false; errors: IngestIssue[]; warnings: IngestIssue[] };

/** ['prep_items', 2, 'cut_technique'] → "prep_items[2].cut_technique" */
export function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, seg) => {
    if (typeof seg === "number") return `${acc}[${seg}]`;
    const s = String(seg);
    return acc === "" ? s : `${acc}.${s}`;
  }, "");
}

function lineCol(text: string, pos: number): { line: number; col: number } {
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  return { line, col: pos - before.lastIndexOf("\n") };
}

class JsonSyntaxError extends Error {
  constructor(
    readonly pos: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Engine-independent JSON syntax scanner returning the offset of the first error.
 * JSON.parse messages differ between V8, Safari and Firefox, so we never parse them.
 */
export function locateJsonError(text: string): { pos: number; message: string } | null {
  let i = 0;
  const fail = (message: string, at = i): never => {
    throw new JsonSyntaxError(at, message);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const describe = () => (i >= text.length ? "end of input" : `'${text[i]}'`);
  const expectChar = (c: string) => {
    if (text[i] !== c) fail(`Expected '${c}' but found ${describe()}`);
    i++;
  };
  const str = () => {
    expectChar('"');
    for (;;) {
      if (i >= text.length) fail("Unterminated string");
      const c = text[i]!;
      if (c === '"') return void i++;
      if (c < " ") fail("Control character in string");
      if (c === "\\") {
        const n = text[i + 1];
        if (n !== undefined && '"\\/bfnrt'.includes(n)) i += 2;
        else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) i += 6;
        else fail("Invalid escape sequence");
      } else i++;
    }
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") return void i++;
      for (;;) {
        ws();
        str();
        ws();
        expectChar(":");
        value();
        ws();
        if (text[i] === ",") i++;
        else return expectChar("}");
      }
    } else if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ",") i++;
        else return expectChar("]");
      }
    } else if (c === '"') str();
    else if (c !== undefined && (c === "-" || (c >= "0" && c <= "9"))) {
      const m = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
      m.lastIndex = i;
      const hit = m.exec(text);
      if (!hit) fail("Invalid number");
      i += hit![0].length;
    } else {
      const lit = ["true", "false", "null"].find((l) => text.startsWith(l, i));
      if (!lit) fail(`Unexpected ${describe()}`);
      i += lit!.length;
    }
  };
  try {
    value();
    ws();
    if (i < text.length) fail(`Unexpected ${describe()} after JSON value`);
    return null;
  } catch (e) {
    if (e instanceof JsonSyntaxError) return { pos: e.pos, message: e.message };
    throw e;
  }
}

/** JSON.parse with a human-readable "line:col" location on syntax errors. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: IngestIssue } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const found = locateJsonError(text);
    const message = found
      ? `Invalid JSON at line ${lineCol(text, found.pos).line}:${lineCol(text, found.pos).col}: ${found.message}`
      : `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, error: { path: "(json)", message, severity: "error" } };
  }
}

/** Validate an already-parsed value: price-field guard → RecipeSchema → domain invariants. */
export function validateRecipe(raw: unknown): IngestResult {
  const priceIssues = findPriceFields(raw);
  const result = RecipeSchema.safeParse(raw);
  if (!result.success) {
    const errors: IngestIssue[] = result.error.issues.map((i) => ({
      path: formatPath(i.path),
      message: i.message,
      severity: "error",
    }));
    return { ok: false, errors: [...priceIssues, ...errors], warnings: [] };
  }

  const issues = [...priceIssues, ...checkInvariants(result.data)];
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return errors.length > 0 ? { ok: false, errors, warnings } : { ok: true, recipe: result.data, warnings };
}

/** Full pipeline: JSON text → syntax check → validateRecipe. */
export function ingestRecipe(text: string): IngestResult {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, errors: [parsed.error], warnings: [] };
  return validateRecipe(parsed.value);
}
