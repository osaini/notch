/**
 * Minimal JSON Schema (draft 2020-12 subset) validator.
 *
 * The MVP deliberately avoids third-party dependencies, so this supports only the
 * keywords used by the schemas in `debug-orchestrator/schemas/`:
 * type, enum, const, required, properties, additionalProperties, items,
 * minItems, maxItems, minLength, minimum, maximum.
 *
 * Unsupported keywords are ignored rather than silently treated as satisfied by
 * an assertion, so any schema change must stay inside this subset. `assertSubset`
 * enforces that at load time.
 */

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$comment',
  'title',
  'description',
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'minimum',
  'maximum'
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function validateNode(schema, value, path, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push(`${path}: value is not allowed`);
    return;
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((candidate) => matchesType(value, candidate))) {
      errors.push(`${path}: expected type ${expected.join('|')} but received ${typeOf(value)}`);
      return;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)} but received ${JSON.stringify(value)}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: ${value} is above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: array shorter than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: array longer than maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors));
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}: missing required property "${key}"`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(properties[key], child, childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNode(schema.additionalProperties, child, childPath, errors);
      }
    }
  }
}

export function validate(schema, data) {
  const errors = [];
  validateNode(schema, data, '$', errors);
  return { valid: errors.length === 0, errors };
}

/** Throws if a schema uses a keyword this validator would silently ignore. */
export function assertSubset(schema, path = '$') {
  if (schema === null || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((child, index) => assertSubset(child, `${path}[${index}]`));
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword "${key}" at ${path}`);
    }
  }
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      assertSubset(child, `${path}.properties.${key}`);
    }
  }
  if (schema.items) assertSubset(schema.items, `${path}.items`);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    assertSubset(schema.additionalProperties, `${path}.additionalProperties`);
  }
}

/**
 * Provider structured-output modes accept a narrower schema dialect than
 * draft 2020-12: value constraints such as minLength/minItems/minimum are
 * rejected, and every declared property must appear in `required`.
 *
 * The canonical schema stays authoritative for our own validation; this
 * projection is only what gets handed to a CLI. Constraints removed here are
 * still enforced locally by `validate` and by normalization.
 */
export function toProviderSchema(schema) {
  if (schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toProviderSchema);

  const output = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'minLength' || key === 'minItems' || key === 'maxItems' || key === 'minimum' || key === 'maximum') {
      continue;
    }
    if (key === 'properties') {
      output.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, toProviderSchema(child)])
      );
      continue;
    }
    if (key === 'items' || key === 'additionalProperties') {
      output[key] = toProviderSchema(value);
      continue;
    }
    output[key] = value;
  }

  if (output.properties) {
    output.required = Object.keys(output.properties);
    if (output.additionalProperties === undefined) output.additionalProperties = false;
  }
  return output;
}
