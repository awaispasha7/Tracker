// Minimal OpenAPI 3.0 response validator for the vendored Aviapages spec. Covers what the spec
// uses: $ref, allOf/oneOf/anyOf, nullable, type, required, properties, items, enum. Used to keep
// our mock honest (tests) and to verify the live API matches what we coded against (contract check).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Schema = Record<string, unknown>;
interface Spec {
  paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, { content?: Record<string, { schema: Schema }> }> }>>;
  components: { schemas: Record<string, Schema> };
}

let cached: Spec | null = null;
export function loadSpec(): Spec {
  cached ??= JSON.parse(readFileSync(fileURLToPath(new URL('./openapi.json', import.meta.url)), 'utf8')) as Spec;
  return cached;
}

/** Finds the spec path template for a concrete path, e.g. /v3/empty_legs/123/ -> /v3/empty_legs/{id}/. */
export function matchPath(concrete: string): string | null {
  const spec = loadSpec();
  const p = concrete.replace(/\?.*$/, '');
  for (const template of Object.keys(spec.paths)) {
    const re = new RegExp('^' + template.replace(/\{[^}]+\}/g, '[^/]+') + '$');
    if (re.test(p)) return template;
  }
  return null;
}

export function validateResponse(method: string, concretePath: string, status: number, body: unknown): string[] {
  const spec = loadSpec();
  const template = matchPath(concretePath);
  if (!template) return [`no spec path for ${concretePath}`];
  const op = spec.paths[template][method.toLowerCase()];
  if (!op) return [`no ${method} operation for ${template}`];
  const resp = op.responses?.[String(status)];
  if (!resp) return [`status ${status} not documented for ${method} ${template}`];
  const content = resp.content?.['application/json'] ?? Object.values(resp.content ?? {})[0];
  if (!content) return [];
  const errors: string[] = [];
  validate(content.schema, body, '$', errors, spec);
  return errors.slice(0, 50);
}

function resolve(s: Schema, spec: Spec): Schema {
  let cur = s;
  for (let i = 0; i < 20 && typeof cur.$ref === 'string'; i++) {
    cur = spec.components.schemas[(cur.$ref as string).split('/').pop()!];
  }
  return cur;
}

function validate(schemaIn: Schema, value: unknown, path: string, errors: string[], spec: Spec): void {
  if (errors.length > 50) return;
  const schema = resolve(schemaIn, spec);
  if (value === null) {
    if (schema.nullable || schemaIn.nullable) return;
    // A oneOf/anyOf including the NullEnum also allows null.
    const alts = (schema.oneOf ?? schema.anyOf) as Schema[] | undefined;
    if (alts?.some((a) => { const r = resolve(a, spec); return r.nullable || (Array.isArray(r.enum) && r.enum.includes(null)); })) return;
    if (Array.isArray(schema.allOf) && (schema.allOf as Schema[]).some((a) => resolve(a, spec).nullable)) return;
    errors.push(`${path}: null not allowed`);
    return;
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as Schema[]) validate(sub, value, path, errors, spec);
  }
  const alts = (schema.oneOf ?? schema.anyOf) as Schema[] | undefined;
  if (alts) {
    const ok = alts.some((a) => {
      const e: string[] = [];
      validate(a, value, path, e, spec);
      return e.length === 0;
    });
    if (!ok) errors.push(`${path}: matches none of ${alts.length} alternatives`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum).slice(0, 120)}`);
  }
  const type = schema.type as string | undefined;
  if (type) {
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const okType =
      type === 'integer' ? Number.isInteger(value) :
        type === 'number' ? typeof value === 'number' :
          type === 'array' ? Array.isArray(value) :
            type === 'object' ? actual === 'object' :
              actual === type;
    if (!okType) {
      errors.push(`${path}: expected ${type}, got ${actual}`);
      return;
    }
  }
  if ((type === 'object' || schema.properties) && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) {
      if (!(r in obj)) errors.push(`${path}.${r}: required field missing`);
    }
    for (const [k, sub] of Object.entries((schema.properties as Record<string, Schema>) ?? {})) {
      if (k in obj && obj[k] !== undefined) validate(sub, obj[k], `${path}.${k}`, errors, spec);
    }
  }
  if (type === 'array' && Array.isArray(value) && schema.items) {
    value.slice(0, 25).forEach((v, i) => validate(schema.items as Schema, v, `${path}[${i}]`, errors, spec));
  }
}
