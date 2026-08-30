// A minimal TOML reader, sufficient for dependency tables.
//
// Replaces: `@iarna/toml`, `smol-toml`, `toml`.
// Node has no TOML support at any version, and we need to read Cargo.toml
// and pyproject.toml. We deliberately implement a subset - tables, dotted
// keys, strings, numbers, booleans and inline tables - because that is all a
// dependency manifest contains. Arrays of tables and datetimes are out of
// scope and documented as such in STDLIB.md.

/**
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseToml(text) {
  const root = {};
  let table = root;

  for (const logical of logicalLines(text)) {
    const line = logical.trim();
    if (!line) continue;

    // [table] or [nested.table]
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = descend(root, splitKey(header[1]));
      continue;
    }

    const eq = findAssignment(line);
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;

    const path = splitKey(key);
    const leaf = path.pop();
    descend(table, path)[leaf] = parseValue(value);
  }

  return root;
}

/**
 * Join physical lines into logical ones: a value whose brackets or braces are
 * still open at the end of a line continues on the next. This is what makes
 * the multi-line `dependencies = [ ... ]` arrays that every real
 * pyproject.toml uses parse correctly. Comments are stripped per physical
 * line, before joining, so a `# comment` inside an array does not survive.
 */
function logicalLines(text) {
  const out = [];
  let buffer = '';
  let depth = 0;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw);
    depth += bracketDelta(line);
    buffer = buffer ? buffer + '\n' + line : line;
    if (depth <= 0) {
      out.push(buffer);
      buffer = '';
      depth = 0;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

/** Net count of `[`/`{` minus `]`/`}` outside quoted strings. */
function bracketDelta(line) {
  let delta = 0;
  let inString = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) inString = false;
    } else if (c === '"' || c === "'") {
      inString = true;
      quote = c;
    } else if (c === '[' || c === '{') {
      delta++;
    } else if (c === ']' || c === '}') {
      delta--;
    }
  }
  return delta;
}

function stripComment(line) {
  let inString = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === quote) inString = false;
    } else if (c === '"' || c === "'") {
      inString = true;
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Find the `=` that separates key from value, ignoring any inside quotes. */
function findAssignment(line) {
  let inString = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === quote) inString = false;
    } else if (c === '"' || c === "'") {
      inString = true;
      quote = c;
    } else if (c === '=') {
      return i;
    }
  }
  return -1;
}

/** `a.b."c.d"` -> ['a','b','c.d'] */
function splitKey(key) {
  const parts = [];
  let current = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    if (inString) {
      if (c === quote) { inString = false; continue; }
      current += c;
    } else if (c === '"' || c === "'") {
      inString = true;
      quote = c;
    } else if (c === '.') {
      parts.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function descend(obj, path) {
  let node = obj;
  for (const part of path) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  return node;
}

function parseValue(raw) {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    const end = raw.lastIndexOf(quote);
    return end > 0 ? raw.slice(1, end) : raw.slice(1);
  }
  if (raw.startsWith('{')) return parseInlineTable(raw);
  if (raw.startsWith('[')) return parseInlineArray(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw.replace(/_/g, ''));
  return Number.isNaN(num) ? raw : num;
}

function parseInlineTable(raw) {
  const inner = raw.slice(1, raw.lastIndexOf('}'));
  const table = {};
  for (const pair of splitTopLevel(inner)) {
    const eq = findAssignment(pair);
    if (eq === -1) continue;
    table[splitKey(pair.slice(0, eq).trim()).join('.')] = parseValue(pair.slice(eq + 1).trim());
  }
  return table;
}

function parseInlineArray(raw) {
  const inner = raw.slice(1, raw.lastIndexOf(']'));
  return splitTopLevel(inner).map(parseValue);
}

/** Split on commas that are not nested inside braces, brackets or quotes. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      current += c;
      if (c === '\\') { current += text[++i] ?? ''; continue; }
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; quote = c; current += c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
