// Tool inputs are streamed from the model without server-side validation, so
// every input is checked against the tool's schema before the tool runs.
type Schema = Record<string, unknown>;

export function validateInput(schema: Schema, value: unknown, path = "input"): string | null {
  if (value && typeof value === "object" && "__invalid_json" in (value as object)) {
    return "arguments were not valid JSON";
  }
  return check(schema, value, path);
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" && Number.isInteger(v)) return "integer";
  return typeof v;
}

function check(schema: Schema, value: unknown, path: string): string | null {
  if (!schema || typeof schema !== "object") return null;
  const anyOf = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
  if (Array.isArray(anyOf)) {
    return anyOf.some((s) => check(s, value, path) === null) ? null : `${path} does not match any allowed shape`;
  }
  const t = schema.type as string | string[] | undefined;
  if (t) {
    const allowed = Array.isArray(t) ? t : [t];
    const actual = typeOf(value);
    const ok = allowed.some((a) => a === actual || (a === "number" && actual === "integer"));
    if (!ok) return `${path} should be ${allowed.join(" or ")}, got ${actual}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (obj[key] === undefined) return `${path}.${key} is required`;
    }
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, sub] of Object.entries(props)) {
      if (obj[key] === undefined) continue;
      const err = check(sub, obj[key], `${path}.${key}`);
      if (err) return err;
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    for (let i = 0; i < value.length; i++) {
      const err = check(schema.items as Schema, value[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}
