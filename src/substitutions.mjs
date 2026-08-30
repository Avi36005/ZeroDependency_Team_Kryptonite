// "You are installing a package your standard library already ships."
//
// Every row is a package people genuinely install, the standard-library
// feature that replaces it, and the version where that became true. Sources
// are the language release notes; `since` is what makes the advice safe to
// act on rather than aspirational.

/**
 * @typedef {object} Substitution
 * @property {string} pkg      package name as declared in the manifest
 * @property {string} use      the standard-library replacement
 * @property {string} since    first runtime version where `use` is available
 * @property {string} [note]   caveat a reader needs before deleting the package
 */

/** @type {Record<string, Substitution[]>} */
export const SUBSTITUTIONS = {
  javascript: [
    { pkg: 'chalk', use: 'util.styleText()', since: 'node 20.12', note: 'honours NO_COLOR and TTY detection for you' },
    { pkg: 'colors', use: 'util.styleText()', since: 'node 20.12' },
    { pkg: 'kleur', use: 'util.styleText()', since: 'node 20.12' },
    { pkg: 'picocolors', use: 'util.styleText()', since: 'node 20.12' },
    { pkg: 'minimist', use: 'util.parseArgs()', since: 'node 18.3', note: 'strings and booleans only; subcommands are yours' },
    { pkg: 'yargs-parser', use: 'util.parseArgs()', since: 'node 18.3', note: 'no coercion or subcommands' },
    { pkg: 'commander', use: 'util.parseArgs()', since: 'node 18.3', note: 'only for simple CLIs' },
    { pkg: 'node-fetch', use: 'global fetch', since: 'node 18' },
    { pkg: 'axios', use: 'global fetch', since: 'node 18', note: 'no interceptors or automatic retries' },
    { pkg: 'isomorphic-fetch', use: 'global fetch', since: 'node 18' },
    { pkg: 'uuid', use: 'crypto.randomUUID()', since: 'node 14.17', note: 'v4 only' },
    { pkg: 'nanoid', use: 'crypto.randomUUID()', since: 'node 14.17', note: 'different alphabet and length' },
    { pkg: 'glob', use: 'fs.glob() / fs.globSync()', since: 'node 22' },
    { pkg: 'fast-glob', use: 'fs.glob()', since: 'node 22' },
    { pkg: 'globby', use: 'fs.glob()', since: 'node 22' },
    { pkg: 'rimraf', use: 'fs.rm(path, { recursive: true, force: true })', since: 'node 14.14' },
    { pkg: 'mkdirp', use: 'fs.mkdir(path, { recursive: true })', since: 'node 10' },
    { pkg: 'dotenv', use: 'process.loadEnvFile() / node --env-file', since: 'node 20.6' },
    { pkg: 'nodemon', use: 'node --watch', since: 'node 18.11' },
    { pkg: 'strip-ansi', use: 'util.stripVTControlCharacters()', since: 'node 16' },
    { pkg: 'ws', use: 'global WebSocket', since: 'node 22', note: 'client only; server still needs work' },
    { pkg: 'better-sqlite3', use: 'node:sqlite', since: 'node 24.15', note: 'release candidate, stability 1.2' },
    { pkg: 'sqlite3', use: 'node:sqlite', since: 'node 24.15' },
    { pkg: 'jest', use: 'node:test + node:assert', since: 'node 20' },
    { pkg: 'mocha', use: 'node:test', since: 'node 20' },
    { pkg: 'tap', use: 'node:test', since: 'node 20' },
    { pkg: 'ava', use: 'node:test', since: 'node 20' },
    { pkg: 'form-data', use: 'global FormData', since: 'node 18' },
    { pkg: 'readable-stream', use: 'node:stream + stream/promises', since: 'node 16' },
    { pkg: 'node-cron', use: 'setInterval / Temporal', since: 'node 26', note: 'Temporal is enabled by default in Node 26' },
    { pkg: 'debug', use: 'util.debuglog()', since: 'node 0.11', note: 'driven by NODE_DEBUG' },
    { pkg: 'lodash.isequal', use: 'util.isDeepStrictEqual()', since: 'node 9' },
    { pkg: 'deep-equal', use: 'util.isDeepStrictEqual()', since: 'node 9' },
    { pkg: 'cross-env', use: 'node --env-file / process.env', since: 'node 20.6' },
    { pkg: 'concurrently', use: 'child_process + Promise.all', since: 'always' },
    { pkg: 'semver', use: 'hand-rolled compare (~40 lines)', since: 'always', note: 'only if you need compare, not ranges' },
  ],
  python: [
    { pkg: 'requests', use: 'urllib.request', since: 'always', note: 'HTTP/1.1 only, no pooling' },
    { pkg: 'httpx', use: 'urllib.request', since: 'always', note: 'no async client in the stdlib' },
    { pkg: 'click', use: 'argparse', since: 'always', note: 'argparse gained colour in 3.14' },
    { pkg: 'typer', use: 'argparse', since: 'always' },
    { pkg: 'pytest', use: 'unittest', since: 'always' },
    { pkg: 'toml', use: 'tomllib', since: 'python 3.11', note: 'read only; the stdlib has no TOML writer' },
    { pkg: 'tomli', use: 'tomllib', since: 'python 3.11' },
    { pkg: 'zstandard', use: 'compression.zstd', since: 'python 3.14' },
    { pkg: 'python-dotenv', use: 'os.environ + a 10-line parser', since: 'always' },
    { pkg: 'colorama', use: 'raw ANSI escapes', since: 'always' },
    { pkg: 'passlib', use: 'hashlib.scrypt / hashlib.pbkdf2_hmac', since: 'python 3.6' },
    { pkg: 'pyotp', use: 'hmac + struct + base64', since: 'always', note: 'TOTP is about fifteen lines' },
    { pkg: 'sqlalchemy', use: 'sqlite3', since: 'always', note: 'only if you do not need an ORM' },
    { pkg: 'python-dateutil', use: 'datetime + zoneinfo', since: 'python 3.9' },
    { pkg: 'pytz', use: 'zoneinfo', since: 'python 3.9' },
  ],
  go: [
    { pkg: 'github.com/google/uuid', use: 'uuid', since: 'go 1.27', note: 'moved into the standard library' },
    { pkg: 'github.com/json-iterator/go', use: 'encoding/json/v2', since: 'go 1.27' },
    { pkg: 'github.com/gorilla/mux', use: 'net/http ServeMux', since: 'go 1.22', note: 'method and wildcard patterns' },
    { pkg: 'github.com/go-chi/chi', use: 'net/http ServeMux', since: 'go 1.22' },
    { pkg: 'github.com/sirupsen/logrus', use: 'log/slog', since: 'go 1.21' },
    { pkg: 'go.uber.org/zap', use: 'log/slog', since: 'go 1.21' },
    { pkg: 'github.com/stretchr/testify', use: 'testing + testing/synctest', since: 'go 1.25' },
    { pkg: 'github.com/gorilla/csrf', use: 'net/http CrossOriginProtection', since: 'go 1.25' },
    { pkg: 'github.com/spf13/cobra', use: 'flag', since: 'always', note: 'only for simple CLIs' },
    { pkg: 'github.com/gocarina/gocsv', use: 'encoding/csv', since: 'always' },
  ],
  rust: [
    { pkg: 'itoa', use: 'format_into + core::fmt::NumBuffer', since: 'rust 1.98', note: 'benchmarks on par with the crate' },
    { pkg: 'once_cell', use: 'LazyLock / LazyCell', since: 'rust 1.80' },
    { pkg: 'lazy_static', use: 'LazyLock', since: 'rust 1.80' },
    { pkg: 'fs2', use: 'File::lock / try_lock / unlock', since: 'rust 1.89' },
    { pkg: 'crossbeam-channel', use: 'std::sync::mpsc', since: 'always', note: 'basic use only' },
    { pkg: 'clap', use: 'std::env::args + match', since: 'always', note: 'only for simple CLIs' },
  ],
  ruby: [
    { pkg: 'httparty', use: 'net/http', since: 'always' },
    { pkg: 'faraday', use: 'net/http', since: 'always' },
    { pkg: 'json', use: 'json', since: 'always', note: 'already ships with the interpreter' },
  ],
};

// Packages that are genuinely never imported by your source and are supposed
// not to be: a framework loads them, or a build tool names them in a config
// file as a bare string. Reporting these as dead is technically true and
// practically a false alarm - the reason `depcheck` ships a special-cases
// list too. We keep the finding, because "not imported" is a fact, and
// annotate it so nobody deletes react-dom on our say-so.
const TOOLING = {
  javascript: [
    { re: /^react-dom$/, why: 'the React renderer - loaded by your framework, not imported by your code' },
    { re: /^react-native$|^expo(-|$)|^@expo\//, why: 'loaded by the React Native / Expo runtime' },
    { re: /^(next|nuxt|vite|astro|remix)$/, why: 'the framework itself - it runs your code, your code does not import it' },
    { re: /^(autoprefixer|postcss|cssnano)$/, why: 'named as a string in your PostCSS config, not imported' },
    { re: /^tailwindcss(-|$)|^@tailwindcss\//, why: 'named in your Tailwind or PostCSS config, not imported' },
    { re: /^(eslint|prettier)(-|$)|^@eslint\//, why: 'a linter or formatter, invoked by tooling rather than imported' },
    { re: /^(typescript|ts-node|tsx)$/, why: 'a compiler, invoked by tooling rather than imported' },
    { re: /^@types\//, why: 'types only - erased at build time and never imported at runtime' },
    { re: /^(geist|@fontsource\/)/, why: 'a font package, usually referenced from CSS rather than imported' },
    { re: /^(babel-|@babel\/)/, why: 'a build-time transform, named in config rather than imported' },
  ],
  python: [
    { re: /^(setuptools|wheel|pip|build)$/, why: 'packaging machinery, used by the build rather than imported' },
    { re: /^(ruff|black|flake8|mypy|isort)$/, why: 'a linter or formatter, invoked as a command rather than imported' },
  ],
};

/**
 * Why a declared-but-unimported package is expected to be unimported.
 * @returns {string | null}
 */
export function toolingReason(languageId, packageName) {
  for (const row of TOOLING[languageId] ?? []) {
    if (row.re.test(packageName)) return row.why;
  }
  return null;
}

/** @returns {Substitution | null} */
export function substitutionFor(languageId, packageName) {
  const rows = SUBSTITUTIONS[languageId];
  if (!rows) return null;
  return rows.find((r) => r.pkg === packageName) ?? null;
}

export function countFor(languageId) {
  return SUBSTITUTIONS[languageId]?.length ?? 0;
}
