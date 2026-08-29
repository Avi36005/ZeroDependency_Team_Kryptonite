// Python adapter.  Replaces: `ast` walking via a Python subprocess, `findimports`, `pipreqs`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mask, lineIndex, positionOf } from '../mask.mjs';
import { parseToml } from '../toml.mjs';

// Python's standard library, 3.9 through 3.14. An import of any of these
// resolves without a package, so it can never be a ghost.
const STDLIB = new Set(`abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb
binascii bisect builtins bz2 calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys
compileall compression concurrent configparser contextlib contextvars copy copyreg cProfile crypt csv
ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip
enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass
gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib imghdr imp importlib inspect io
ipaddress itertools json keyword linecache locale logging lzma mailbox mailcap marshal math mimetypes
mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib numbers operator optparse os ossaudiodev
pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix pprint profile pstats pty pwd
py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets
select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3
ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny
tarfile telnetlib tempfile termios test textwrap threading time timeit tkinter token tokenize tomllib
trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uu uuid venv warnings
wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo`
  .split(/\s+/).filter(Boolean));

// Import name differs from the PyPI distribution name. Without this table the
// tool would flag half of every real requirements.txt as a ghost.
const ALIASES = new Map(Object.entries({
  yaml: 'PyYAML', cv2: 'opencv-python', PIL: 'Pillow', sklearn: 'scikit-learn',
  skimage: 'scikit-image', bs4: 'beautifulsoup4', dateutil: 'python-dateutil',
  dotenv: 'python-dotenv', serial: 'pyserial', Crypto: 'pycryptodome',
  jwt: 'PyJWT', attr: 'attrs', OpenSSL: 'pyOpenSSL', magic: 'python-magic',
  docx: 'python-docx', pptx: 'python-pptx', fitz: 'PyMuPDF', usb: 'pyusb',
  zmq: 'pyzmq', psycopg2: 'psycopg2-binary', MySQLdb: 'mysqlclient',
  win32api: 'pywin32', win32com: 'pywin32', pkg_resources: 'setuptools',
  google: 'protobuf', mpl_toolkits: 'matplotlib', IPython: 'ipython',
  slugify: 'python-slugify', lxml: 'lxml', memcache: 'python-memcached',
}));

const SPEC = {
  lineComment: ['#'],
  strings: ['"""', "'''", '"', "'"],
  escape: '\\',
};

export function scanImports(src) {
  const { masked } = mask(src, SPEC);
  const starts = lineIndex(src);
  const found = [];

  // `from X import ...` - the dotted path before `import`
  for (const m of masked.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm)) {
    const { line, column } = positionOf(starts, m.index + m[0].indexOf(m[1]));
    found.push({ specifier: m[1], line, column, kind: 'from' });
  }

  // `import a.b, c as d`
  for (const m of masked.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    const base = m.index + m[0].indexOf(m[1]);
    let offset = 0;
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/)[0].trim();
      if (name) {
        const { line, column } = positionOf(starts, base + offset);
        found.push({ specifier: name, line, column, kind: 'import' });
      }
      offset += piece.length + 1;
    }
  }

  return found;
}

export function normalize(specifier) {
  if (specifier.startsWith('.')) return null;      // relative import
  const top = specifier.split('.')[0];
  if (!top || STDLIB.has(top)) return null;        // standard library
  return ALIASES.get(top) ?? top;
}

export async function readManifest(dir) {
  const declared = new Set();
  const dev = new Set();

  const requirements = await readIfPresent(join(dir, 'requirements.txt'));
  if (requirements !== null) {
    for (const name of parseRequirements(requirements)) declared.add(name);
  }

  const pyproject = await readIfPresent(join(dir, 'pyproject.toml'));
  if (pyproject !== null) {
    const toml = parseToml(pyproject);
    for (const entry of toml.project?.dependencies ?? []) {
      const name = requirementName(String(entry));
      if (name) declared.add(name);
    }
    for (const [name] of Object.entries(toml.tool?.poetry?.dependencies ?? {})) {
      if (name !== 'python') declared.add(name);
    }
    for (const [name] of Object.entries(toml.tool?.poetry?.['dev-dependencies'] ?? {})) dev.add(name);
  }

  if (declared.size === 0 && dev.size === 0 && requirements === null && pyproject === null) return null;
  return { declared, dev, optional: new Set(), peer: new Set() };
}

function parseRequirements(text) {
  const names = [];
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith('-')) continue;   // -r other.txt, -e ., --flags
    const name = requirementName(line);
    if (name) names.push(name);
  }
  return names;
}

/** `requests[security]>=2.0,<3 ; python_version<"3.10"` -> `requests` */
function requirementName(spec) {
  const m = /^([A-Za-z0-9._-]+)/.exec(spec.split(';')[0].trim());
  return m ? m[1] : null;
}

async function readIfPresent(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

export default {
  id: 'python',
  name: 'Python',
  tier: 1,
  extensions: ['.py', '.pyi'],
  manifestFiles: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
  installDirs: ['site-packages', '.venv', 'venv'],
  caseInsensitiveNames: true,   // PyPI treats Foo_Bar and foo-bar as the same name
  scanImports,
  normalize,
  readManifest,
};
