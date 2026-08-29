// A configurable source masker for the non-JavaScript languages.
//
// Every adapter needs the same guarantee: "this string literal is real code,
// not a comment or the inside of another string". Rather than writing that
// state machine once per language, the shape of each language's comments and
// string delimiters is data, and the machine is shared.
//
// JavaScript gets its own masker (src/lang/javascript.mjs) because regex
// literals and template interpolation need lookbehind the others do not.

/**
 * @typedef {object} MaskSpec
 * @property {string[]} [lineComment]   e.g. ['#'] or ['//']
 * @property {[string,string][]} [blockComment]  e.g. [['/*','*\/']]
 * @property {string[]} [strings]       delimiters, longest first: ['"""', "'''", '"', "'"]
 * @property {string} [escape]          escape character inside strings, '' for none
 * @property {[string,string][]} [rawStrings]  delimiter pairs with no escaping
 */

/**
 * Blank out comments and string bodies, preserving offsets and newlines.
 *
 * @param {string} src
 * @param {MaskSpec} spec
 * @returns {{ masked: string, strings: Array<{start:number,end:number,value:string}> }}
 */
export function mask(src, spec) {
  const lineComment = spec.lineComment ?? [];
  const blockComment = spec.blockComment ?? [];
  const delims = [...(spec.strings ?? [])].sort((a, b) => b.length - a.length);
  const raws = spec.rawStrings ?? [];
  const escape = spec.escape ?? '\\';

  const out = new Array(src.length);
  const strings = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
  };

  let i = 0;
  outer: while (i < src.length) {
    for (const marker of lineComment) {
      if (src.startsWith(marker, i)) {
        const nl = src.indexOf('\n', i);
        const stop = nl === -1 ? src.length : nl;
        blank(i, stop);
        i = stop;
        continue outer;
      }
    }

    for (const [open, close] of blockComment) {
      if (src.startsWith(open, i)) {
        const end = src.indexOf(close, i + open.length);
        const stop = end === -1 ? src.length : end + close.length;
        blank(i, stop);
        i = stop;
        continue outer;
      }
    }

    for (const [open, close] of raws) {
      if (src.startsWith(open, i)) {
        const end = src.indexOf(close, i + open.length);
        const stop = end === -1 ? src.length : end + close.length;
        const value = src.slice(i + open.length, end === -1 ? src.length : end);
        blank(i, stop);
        strings.push({ start: i, end: stop, value });
        i = stop;
        continue outer;
      }
    }

    for (const d of delims) {
      if (src.startsWith(d, i)) {
        const start = i;
        let j = i + d.length;
        let value = '';
        while (j < src.length) {
          if (escape && src[j] === escape) { value += src[j + 1] ?? ''; j += 2; continue; }
          if (src.startsWith(d, j)) break;
          // A single-character delimiter never spans a newline; a triple-quote does.
          if (d.length === 1 && src[j] === '\n') break;
          value += src[j];
          j++;
        }
        const end = Math.min(j + d.length, src.length);
        blank(start, end);
        strings.push({ start, end, value });
        i = end;
        continue outer;
      }
    }

    out[i] = src[i];
    i++;
  }

  return { masked: out.join(''), strings };
}

/** Precompute line start offsets so positions are one binary search each. */
export function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

export function positionOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}
