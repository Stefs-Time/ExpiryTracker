import { unprocessable } from './errors.js';

/** Parse `data` with a zod schema or throw a 422 with field-level details. */
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => ({ field: i.path.join('.') || null, message: i.message }));
  throw unprocessable(details[0]?.message || 'Invalid request', details);
}
