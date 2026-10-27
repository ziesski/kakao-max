// ----------------------------------------------------------------------------
// Tool-argument validation against each tool's declared inputSchema.
//
// Covers the subset of JSON Schema our tools use: required keys, unknown keys
// (additionalProperties: false), primitive types, arrays with item types, and
// enums. Numeric strings are accepted for `number` (handlers coerce them), since
// some clients serialize numbers as strings. All problems are reported at once.
// ----------------------------------------------------------------------------

import type { JsonSchema } from './mcp-stdio.ts';

type PropSchema = { type?: string; enum?: unknown[]; items?: PropSchema; properties?: Record<string, PropSchema>; required?: string[] };

function typeOk(v: unknown, s: PropSchema): boolean {
  switch (s.type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
    case 'integer':
      return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    default:
      return true; // untyped property
  }
}

function checkValue(path: string, v: unknown, s: PropSchema, problems: string[]): void {
  if (!typeOk(v, s)) {
    problems.push(`${path} must be ${s.type}`);
    return;
  }
  if (s.enum && !s.enum.includes(v)) problems.push(`${path} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (s.type === 'array' && s.items) (v as unknown[]).forEach((item, i) => checkValue(`${path}[${i}]`, item, s.items!, problems));
  if (s.type === 'object' && s.properties) {
    const obj = v as Record<string, unknown>;
    for (const key of s.required ?? []) if (obj[key] === undefined) problems.push(`${path}.${key} is required`);
    for (const [key, val] of Object.entries(obj)) {
      const sub = s.properties[key];
      if (sub && val !== undefined) checkValue(`${path}.${key}`, val, sub, problems);
    }
  }
}

/** Problems with `args` for `schema`; empty when valid. */
export function validateArgs(schema: JsonSchema, args: unknown): string[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return ['arguments must be an object'];
  const obj = args as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, PropSchema>;
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) problems.push(`"${key}" is required`);
  }
  for (const [key, val] of Object.entries(obj)) {
    const s = props[key];
    if (!s) {
      if (schema.additionalProperties === false) problems.push(`unknown argument "${key}"`);
      continue;
    }
    if (val === undefined || val === null) continue; // treated as omitted
    checkValue(`"${key}"`, val, s, problems);
  }
  return problems;
}
