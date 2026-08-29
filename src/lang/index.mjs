// Language registry. Adding a language means adding one module here.

import javascript from './javascript.mjs';
import python from './python.mjs';
import go from './go.mjs';
import rust from './rust.mjs';
import ruby from './ruby.mjs';
import { java, csharp, php, c } from './tier3.mjs';

/** @type {Array<import('./javascript.mjs').default>} */
export const LANGUAGES = [javascript, python, go, rust, ruby, java, csharp, php, c];

const BY_EXTENSION = new Map();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) BY_EXTENSION.set(ext, lang);
}

/** Ghost detection is only sound where import name maps to package name. */
export function ghostCapable(lang) {
  return lang.ghostCapable !== false;
}

export function languageForFile(path) {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  return BY_EXTENSION.get(path.slice(dot).toLowerCase()) ?? null;
}

export function languageById(id) {
  return LANGUAGES.find((l) => l.id === id) ?? null;
}
