/**
 * A dependency-free tool-definition helper producing the exact subset
 * `ctx.tools.register` accepts (type/enum/const/properties/required JSON
 * Schema plus `{ schema, render }` output), with argument validation matching
 * the declared parameters.
 *
 * @module
 */

/**
 * @typedef {Object} PropertySpec
 * @property {'string' | 'boolean' | 'number'} type
 * @property {string} [description]
 * @property {readonly string[]} [enum]
 */

/**
 * @typedef {Record<string, PropertySpec & { required?: true }>} ParameterSpec
 */

/**
 * Compile one parameter spec into a plain JSON Schema object.
 * @param {ParameterSpec} spec
 * @returns {{ schema: Record<string, unknown>, required: string[] }}
 */
export function compileParameters(spec) {
  /** @type {Record<string, unknown>} */
  const properties = {}
  /** @type {string[]} */
  const required = []
  for (const [key, entry] of Object.entries(spec ?? {})) {
    /** @type {Record<string, unknown>} */
    const node = { type: entry.type }
    if (entry.description !== undefined) node.description = entry.description
    if (entry.enum !== undefined) node.enum = [...entry.enum]
    properties[key] = node
    if (entry.required === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return { schema, required }
}

/**
 * Validate arguments against a compiled parameter schema; returns violations.
 * @param {{ schema: Record<string, unknown>, required: string[] }} compiled
 * @param {unknown} args
 * @returns {string[]}
 */
export function validateArguments(compiled, args) {
  /** @type {string[]} */
  const violations = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['arguments must be an object']
  }
  const record = /** @type {Record<string, unknown>} */ (args)
  for (const key of compiled.required) {
    if (record[key] === undefined) violations.push(`arguments.${key} is required`)
  }
  const properties = /** @type {Record<string, Record<string, unknown>>} */ (compiled.schema.properties)
  for (const [key, node] of Object.entries(properties)) {
    const value = record[key]
    if (value === undefined) continue
    const type = node.type
    if (type === 'string' && typeof value !== 'string') violations.push(`arguments.${key} must be a string`)
    else if (type === 'boolean' && typeof value !== 'boolean') violations.push(`arguments.${key} must be a boolean`)
    else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`arguments.${key} must be a number`)
    const allowed = node.enum
    if (Array.isArray(allowed) && !allowed.includes(value)) {
      violations.push(`arguments.${key} must be one of ${allowed.map(v => JSON.stringify(v)).join(', ')}`)
    }
  }
  return violations
}

/**
 * Define one tool compatible with `ctx.tools.register`.
 * @param {Object} options
 * @param {string} options.name - unique tool name.
 * @param {string} options.description - model-facing description.
 * @param {ParameterSpec} options.parameters - parameter spec.
 * @param {{ render: (args: unknown, value: unknown) => unknown[] }} options.output - output projection.
 * @param {number} [options.timeoutMs] - cooperative timeout budget.
 * @param {(args: Record<string, unknown>, exec: unknown) => Promise<unknown>} options.execute
 */
export function defineTool(options) {
  const compiled = compileParameters(options.parameters)
  const render = options.output.render
  const tool = {
    name: options.name,
    description: options.description,
    parameters: compiled.schema,
    output: {
      schema: {},
      render(args, value) {
        return render(args, value)
      },
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validateArguments(compiled, args)
      if (violations.length > 0) throw new Error(`${options.name}: invalid arguments: ${violations.join('; ')}`)
      return await options.execute(args, exec)
    },
  }
  return tool
}
