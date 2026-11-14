import process from 'node:process'
// FIX #2: pathToFileURL is required to turn Windows absolute paths
// ("D:\...") into file: URLs before passing them to dynamic import().
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import * as zlib from 'node:zlib'
import * as fsSync from 'node:fs'
// Import worker thread APIs dynamically.
// If the APIs are not available, we disable functionality that depends on them.
let isWorkerApiSupported = false
/** @type {typeof import('node:worker_threads').Worker} */
let Worker = /** @type {any} */ (null)
/** @type {typeof import('node:worker_threads').isMainThread} */
let isMainThread = true
/** @type {typeof import('node:worker_threads').workerData} */
let workerData = {}
/** @type {typeof import('node:worker_threads').parentPort} */
let parentPortImpl = null
try {
	const api = await import('node:worker_threads')
	Worker = api.Worker
	isMainThread = api.isMainThread
	workerData = api.workerData
	parentPortImpl = api.parentPort
	isWorkerApiSupported = true
} catch (err) {
	console.warn(
		'Worker thread APIs not available; hot reloading will not work. Import error:',
		err,
	)
}
// Hacky cast to stop TS from yelling about it possibly being null.
const parentPort = /** @type {MessagePort} */ (
	/** @type {unknown} */ (parentPortImpl)
)
// REFACTOR: All seven SSG_* contract names and values are intentionally
// unchanged; only their documentation notes the reason.
/**
 * The name of the environment variable that specifies the root path.
 * Kept with the SSG_ prefix for backward compatibility; WUNPHILE_ prefixed aliases may be introduced in a future major release.
 * @type {string}
 */
export const ROOT_PATH_ENV_VAR = 'SSG_ROOT_PATH'
/**
 * The name of the environment variable that specifies the output path.
 * Kept with the SSG_ prefix for backward compatibility; WUNPHILE_ prefixed aliases may be introduced in a future major release.
 * @type {string}
 */
export const OUTPUT_PATH_ENV_VAR = 'SSG_OUTPUT_PATH'
/**
 * The name of the environment variable that specifies the path to use for the not found page.
 * Kept with the SSG_ prefix for backward compatibility; WUNPHILE_ prefixed aliases may be introduced in a future major release.
 * @type {string}
 */
export const NOT_FOUND_PATH_ENV_VAR = 'SSG_NOT_FOUND_PATH'
/**
 * The name of the environment variable that specifies the development server port.
 * Kept with the SSG_ prefix for backward compatibility; WUNPHILE_ prefixed aliases may be introduced in a future major release.
 * @type {string}
 */
export const DEV_PORT_ENV_VAR = 'SSG_DEV_PORT'
/**
 * The name of the environment variable that specifies the development server host.
 * Kept with the SSG_ prefix for backward compatibility; WUNPHILE_ prefixed aliases may be introduced in a future major release.
 * @type {string}
 */
export const DEV_HOST_ENV_VAR = 'SSG_DEV_HOST'
/**
 * The name of the environment variable that specifies whether hot reloading is enabled in development mode.
 * Kept with the SSG_ prefix for backward compatibility; WUNPHILE_ prefixed aliases may be introduced in a future major release.
 * @type {string}
 */
export const DEV_NO_HOT_RELOAD_ENV_VAR = 'SSG_DEV_NO_HOT_RELOAD'
/**
 * The name of the environment variable that specifies whether hot reloading is enabled in development mode.
 * Kept with the SSG_ prefix for backward compatibility; WUNPHILE_ prefixed aliases may be introduced in a future major release.
 * @type {string}
 */
export const DEV_NO_INJECT_ENV_VAR = 'SSG_DEV_NO_INJECT'
/**
 * The prefix for client mount paths.
 * @type {string}
 */
const CLIENT_MOUNT_PREFIX = '/_wfclient/'
/**
 * The prefix for client behavior hydration comments.
 * Used by the loader to find components.
 * @type {string}
 */
const CLIENT_BEHAVIOR_HYDRATE_PREFIX = 'wf-behavior:'
/**
 * Prefix used for generated development endpoints.
 * @type {string}
 */
const DEV_ENDPOINT_PREFIX = '/__hotreload'
/**
 * Filesystems paths of Wunphile's own bookkeeping (never deleted).
 * @type {string}
 */
const CACHE_DIR = '.wunphile'
/* ======================================================================
 * Public types
 *
 * These module-scope JSDoc typedefs are what make `tsc --checkJs` resolve
 * the names used throughout the file, and they are emitted into the
 * generated `dist/index.d.mts` so TypeScript consumers can import them.
 * A hand-written `types.d.ts` mirrors them for `wunphile/types`.
 * ==================================================================== */
/** @typedef {0 | 1 | 2 | 3 | 4} RenderFragmentEnum */
/** @typedef {RenderFragment[]} RenderFragments */
/** @typedef {'eager' | 'visible' | 'idle' | 'interaction'} LoadStrategy */
/**
 * @typedef {object} BehaviorModule
 * @property {string} behaviorModuleUrl
 * @property {((elem: Element, ctx?: any) => void) | undefined} [behavior]
 * @property {Record<string, (...args: any[]) => any> | undefined} [functions]
 * @property {string | undefined} [styles] CSS shipped alongside this module.
 * @property {LoadStrategy | undefined} [load] Default hydration strategy.
 */
/**
 * @typedef {object} PageContext
 * @property {string} path
 * @property {Record<string, string>} params
 * @property {any} [entry]
 * @property {Record<string, ContentEntry[]>} collections
 * @property {Wunphile} wunphile
 * @property {string | null} locale
 * @property {string[]} locales
 * @property {{ locale: string, href: string }[]} localeLinks
 */
/**
 * A page component. `Component<void, void>` remains valid for legacy code.
 * @template [P=void] Props type
 * @template [C=void] Children type
 * @typedef {(ctx?: PageContext & { props?: P, children?: C }) => RenderFragments | Promise<RenderFragments>} Component
 */
/**
 * @typedef {object} ContentEntry
 * @property {string} slug
 * @property {string} path
 * @property {Record<string, any>} data
 * @property {string} body
 * @property {string} html
 * @property {string} title
 * @property {string} description
 * @property {string} date
 * @property {number} mtime
 * @property {Record<string, string>} params
 */
/**
 * @typedef {object} StaticOptions
 * @property {boolean} [hash] Emit a content-hashed filename and a manifest entry.
 * @property {boolean} [transform] Allow asset transforms (optional deps / hooks).
 * @property {Record<string, string>} [headers] Extra headers for adapter configs.
 */
/**
 * @typedef {object} Plugin
 * @property {string} [name]
 * @property {(html: string, path: string) => string | void | Promise<string | void>} [onPageRender]
 * @property {(asset: any) => void | Promise<void>} [onAsset]
 * @property {(manifest: any) => void | Promise<void>} [onBuildEnd]
 * @property {(req: any, res: any) => boolean | void | Promise<boolean | void>} [onDevRequest]
 */
/**
 * @typedef {object} BuildOptions
 * @property {('gzip' | 'br')[]} [precompress]
 * @property {boolean} [incremental]
 * @property {boolean} [stats]
 * @property {number} [concurrency]
 * @property {boolean} [quiet]
 */
/**
 * @typedef {object} WunphileConfig
 * @property {string} [root]
 * @property {string} [outDir]
 * @property {string} [base]
 * @property {string} [clientDir]
 * @property {string} [notFoundPath]
 * @property {string | { baseUrl: string, path?: string }} [sitemap]
 * @property {string} [baseUrl]
 * @property {boolean} [minify]
 * @property {Plugin[]} [plugins]
 * @property {any} [markdown]
 * @property {any} [image]
 * @property {any} [adapter]
 * @property {any} [i18n]
 * @property {any} [feed]
 * @property {any} [robots]
 * @property {any} [ogImage]
 * @property {any} [content]
 * @property {string} [loader]
 * @property {boolean} [absoluteImports]
 * @property {boolean} [csp]
 * @property {BuildOptions} [build]
 */
/**
 * @typedef {object} SitemapEntry
 * @property {string} [path]
 * @property {string} [loc]
 * @property {string | number | Date} [lastmod]
 * @property {string} [changefreq]
 * @property {number | string} [priority]
 * @property {{ hreflang: string, href: string }[]} [alternates]
 */
/**
 * @typedef {object} DevHandle
 * @property {import('node:http').Server} server
 * @property {() => Promise<void>} close
 */
/* ======================================================================
 * NEW: Path utilities (BUG 1 / BUG 3 fix infrastructure)
 * ==================================================================== */
/**
 * Converts a path to POSIX-style (forward slashes) so it can be safely used
 * in URLs, ES module specifiers, and JS string literals.
 *
 * BUG 3 FIX: On Windows, `path.relative()` / `path.join()` return backslash-
 * separated paths. When these are interpolated into a URL like
 * `/_wfclient/behavior\CopyCode-T54oh2yf.js`, the `\b` and `\C` sequences
 * are interpreted as JS escape sequences, breaking the generated import.
 *
 * @param {string} path The path to convert
 * @returns {string} The path with forward slashes
 */
function toPosixPath(path) {
	return path.split('\\').join('/')
}
import * as fs from 'node:fs/promises'
import * as pathUtil from 'node:path'
import { pipeline } from 'node:stream/promises'
// FIX #9: Only one ESM-safe relPosix() helper remains (see JSDoc below).
/**
 * Computes a relative path between two filesystem paths and normalizes it
 * to POSIX-style separators, suitable for use as a URL segment or as a
 * stable Map key across platforms.
 * POSIX-normalizing wrapper around `pathUtil.relative`.
 *
 * FIX #9: Removed the dead `relativePosix()` (it depended on the CommonJS
 * `require` helper, which is undefined in ESM) and the duplicate
 * `relativePosix2()` + `relPosix` alias.
 * This is the single ESM-safe helper used by #loadModule,
 * #renderToHtmlAsync and the rewrittenPath calculation.
 * #getPathRelativeToClientDir uses the same primitives directly because it
 * needs the raw (non-POSIX) result for its boundary checks.
 *
 * @param {string} from The base path
 * @param {string} to The target path
 * @returns {string} The POSIX-normalized relative path
 */
function relPosix(from, to) {
	return toPosixPath(pathUtil.relative(from, to))
}
/**
 * Iterator that splits a string by a separator.
 * @param {string} str The string to split
 * @param {string} separator The separator to split by
 * @returns {Generator<string>} The split string iterator
 */
function* splitIter(str, separator) {
	let start = 0
	let index = 0
	while ((index = str.indexOf(separator, start)) !== -1) {
		yield str.slice(start, index)
		start = index + separator.length
	}
	yield str.slice(start)
}
/**
 * Regex that matches an import statement line.
 * The path (including quotes) is captured in the named group "path".
 * The imports (if any) are captured in the named group "imports".
 * @type {RegExp}
 */
const importStmtRegex =
	/^\s*import\s+(?<imports>.* from)?\s*(?<path>["'].+["'])/
/**
 * Regex that matches an export statement line.
 * @type {RegExp}
 */
const exportStmtRegex = /^\s*export\s+/
/**
 * Parses a quoted string literal (from an import statement) without using `eval`.
 * Supports single, double, and backtick quotes, and handles common escapes.
 *
 * IMPROVEMENT: Replaces `eval()` (issue #7) with a safer parser that doesn't
 * execute arbitrary code, provides clearer errors, and is faster.
 *
 * @param {string} raw The raw string including surrounding quotes
 * @returns {string} The unescaped string contents
 * @throws {Error} If the string is not a valid quoted literal
 */
function parseQuotedString(raw) {
	if (raw.length < 2) {
		throw new Error(`Invalid string literal: ${JSON.stringify(raw)}`)
	}
	const quote = raw[0]
	if (
		(quote !== '"' && quote !== "'" && quote !== '`') ||
		raw[raw.length - 1] !== quote
	) {
		throw new Error(
			`String literal ${JSON.stringify(raw)} is not properly quoted.`,
		)
	}
	const inner = raw.slice(1, -1)
	let out = ''
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i]
		if (c !== '\\') {
			out += c
			continue
		}
		// Escape sequence.
		i++
		if (i >= inner.length) {
			throw new Error(`Unterminated escape sequence in ${JSON.stringify(raw)}`)
		}
		const esc = inner[i]
		switch (esc) {
			case 'n': out += '\n'; break
			case 't': out += '\t'; break
			case 'r': out += '\r'; break
			case 'b': out += '\b'; break
			case 'f': out += '\f'; break
			case 'v': out += '\v'; break
			case '0': out += '\0'; break
			case '\\': out += '\\'; break
			case '"': out += '"'; break
			case "'": out += "'"; break
			case '`': out += '`'; break
			case '\n': break // line continuation
			case 'x': {
				if (i + 2 >= inner.length) {
					throw new Error(`Invalid \\x escape in ${JSON.stringify(raw)}`)
				}
				out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 3), 16))
				i += 2
				break
			}
			case 'u': {
				if (inner[i + 1] === '{') {
					// \u{...}
					const closeIdx = inner.indexOf('}', i + 2)
					if (closeIdx === -1) {
						throw new Error(`Invalid \\u{...} escape in ${JSON.stringify(raw)}`)
					}
					const hex = inner.slice(i + 2, closeIdx)
					out += String.fromCodePoint(parseInt(hex, 16))
					i = closeIdx
				} else {
					if (i + 4 >= inner.length) {
						throw new Error(`Invalid \\u escape in ${JSON.stringify(raw)}`)
					}
					out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16))
					i += 4
				}
				break
			}
			default:
				// Unknown escape - keep the character as-is (lenient, like JS does for many).
				out += esc
		}
	}
	return out
}
/* ======================================================================
 * Pure helpers. Everything in this section is exported (or used by an
 * exported function) and is deliberately free of instance state so that it
 * can be unit tested and reused by plugins. See feature #39.
 * ==================================================================== */
/**
 * Reads a legacy `SSG_*` environment variable, preferring its `WUNPHILE_*`
 * alias. The legacy names are kept as the contract (#26).
 * @param {string} legacyName
 * @returns {string}
 */
export function readEnv(legacyName) {
	const alias = 'WUNPHILE_' + legacyName.replace(/^SSG_/, '')
	return process.env[alias] || process.env[legacyName] || ''
}
/**
 * Computes a hex SHA-256 digest of a string or Buffer.
 * @param {string | Buffer | Uint8Array} content
 * @returns {string}
 */
export function sha256(content) {
	return createHash('sha256').update(content).digest('hex')
}
/**
 * Computes the short (8 char) content hash used in fingerprinted filenames.
 * @param {string | Buffer | Uint8Array} content
 * @returns {string}
 */
export function contentHash(content) {
	return sha256(content).slice(0, 8)
}
/**
 * Inserts a hash (or any infix) before the final file extension.
 * `/assets/app.js` + `a1b2c3d4` -> `/assets/app.a1b2c3d4.js`
 * @param {string} path
 * @param {string} infix
 * @returns {string}
 */
export function hashPath(path, infix) {
	const slash = path.lastIndexOf('/')
	const dot = path.lastIndexOf('.')
	if (dot <= slash + 1) {
		return `${path}.${infix}`
	}
	return `${path.slice(0, dot)}.${infix}${path.slice(dot)}`
}
/**
 * Escapes a value for use inside a double-quoted HTML attribute.
 *
 * NOTE: this is an *entity escaper*, exactly like {@link sanitizeHtml}. It
 * does not make arbitrary HTML safe and does not implement an HTML sanitizer.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAttribute(value) {
	return sanitizeHtml(String(value ?? ''))
}
/**
 * Converts an HTML string to plain text (used for RSS/Atom descriptions).
 * Tags are removed, entities decoded and runs of whitespace collapsed.
 * @param {string} htmlStr
 * @returns {string}
 */
export function stripHtml(htmlStr) {
	return String(htmlStr ?? '')
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/gi, '&')
		.replace(/\s+/g, ' ')
		.trim()
}
/**
 * True when a URL path represents an HTML document (as opposed to e.g. a
 * generated `.js` client module or an XML feed).
 * @param {string} path
 * @returns {boolean}
 */
export function isHtmlPath(path) {
	const clean = path.split('?')[0].split('#')[0]
	return (
		clean.endsWith('.html') ||
		clean.endsWith('/') ||
		clean.lastIndexOf('.') <= clean.lastIndexOf('/')
	)
}
/**
 * Validates a redirect target.
 *
 * SECURITY (#34): only absolute-path and http(s) URLs are allowed. Without
 * this check, `javascript:alert(1)` ends up in both `href` and
 * `location.assign()` and executes in the browser.
 *
 * @param {string} url
 * @returns {string} The validated URL
 * @throws {Error} When the URL is not safe
 */
export function safeRedirectUrl(url) {
	const value = String(url ?? '')
	if (value === '' || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error(`Unsafe redirect URL: ${JSON.stringify(value)}`)
	}
	const lower = value.toLowerCase()
	const isRelative = value.startsWith('/')
	const isHttp = lower.startsWith('http://') || lower.startsWith('https://')
	if (!isRelative && !isHttp) {
		throw new Error(
			`Unsafe redirect URL "${value}": only paths starting with "/" and http(s) URLs are allowed.`,
		)
	}
	return value
}
/**
 * Produces a JavaScript string literal that is also safe inside an inline
 * `<script>` element (i.e. `</script>` cannot terminate it).
 * @param {string} value
 * @returns {string}
 */
export function jsStringLiteral(value) {
	return JSON.stringify(String(value))
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029')
}
/**
 * Minifies an HTML string (conservatively).
 *
 * Protects `<pre>`, `<textarea>`, `<script>` and `<style>` contents, removes
 * HTML comments except conditional comments, `wf-behavior:` hydration
 * markers and any user-requested prefixes, collapses whitespace *between
 * tags only*, and trims.
 *
 * Exported as a pure function so plugins can reuse it (#39).
 * @param {string} htmlStr
 * @param {{ preserveCommentPrefixes?: string[] }} [opts]
 * @returns {string}
 */
export function minifyHtml(htmlStr, opts = {}) {
	const extra = opts.preserveCommentPrefixes ?? []
	const protectedRe =
		/(<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\2>)/gi
	/** @type {string[]} */
	const placeholders = []
	const masked = htmlStr.replace(protectedRe, (match) => {
		placeholders.push(match)
		return `\u0000${placeholders.length - 1}\u0000`
	})
	const preserve = ['\\[if', 'wf-behavior:', ...extra.map(escapeRegex)]
	const commentRe = new RegExp(
		`<!--(?!${preserve.join('|')})[\\s\\S]*?-->`,
		'g',
	)
	let out = masked
		.replace(commentRe, '')
		.replace(/>\s+</g, '><')
		.trim()
	out = out.replace(/\u0000(\d+)\u0000/g, (_, idx) =>
		placeholders[Number(idx)],
	)
	return out
}
/**
 * Escapes a string for use inside a regular expression.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
/**
 * Coerces a sitemap `lastmod` value to an ISO date (YYYY-MM-DD supported).
 * @param {string | number | Date | undefined | null} value
 * @returns {string | null}
 */
function sitemapLastmod(value) {
	if (value == null) {
		return null
	}
	if (value instanceof Date) {
		return value.toISOString().slice(0, 10)
	}
	if (typeof value === 'number') {
		return new Date(value).toISOString().slice(0, 10)
	}
	const str = String(value).trim()
	return str === '' ? null : str
}
/**
 * Builds a `sitemap.xml` document from entries.
 *
 * Pure function (#39) - plugins and tests can call it directly.
 * @param {SitemapEntry[] | string[]} entries
 * @param {string} baseUrl
 * @returns {string}
 */
export function buildSitemap(entries, baseUrl) {
	const base = baseUrl.replace(/\/+$/, '')
	const normalized = entries.map((entry) =>
		typeof entry === 'string' ? { loc: entry } : entry,
	)
	const hasAlternates = normalized.some((e) => e.alternates?.length)
	const xmlns = hasAlternates
		? ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"'
		: ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'
	const urls = normalized.map((entry) => {
		const loc =
			entry.loc != null
				? entry.loc.startsWith('http')
					? entry.loc
					: base + entry.loc
				: base + (entry.path ?? '')
		const lines = [`    <loc>${sanitizeHtml(loc)}</loc>`]
		const lastmod = sitemapLastmod(entry.lastmod)
		if (lastmod != null) {
			lines.push(`    <lastmod>${sanitizeHtml(lastmod)}</lastmod>`)
		}
		if (entry.changefreq) {
			lines.push(
				`    <changefreq>${sanitizeHtml(String(entry.changefreq))}</changefreq>`,
			)
		}
		if (entry.priority != null) {
			lines.push(
				`    <priority>${sanitizeHtml(String(entry.priority))}</priority>`,
			)
		}
		for (const alt of entry.alternates ?? []) {
			lines.push(
				`    <xhtml:link rel="alternate" hreflang="${escapeAttribute(alt.hreflang)}" href="${escapeAttribute(alt.href)}" />`,
			)
		}
		return `  <url>\n${lines.join('\n')}\n  </url>`
	})
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset${xmlns}>\n${urls.join('\n')}\n</urlset>\n`
}
/**
 * Builds a sitemap index for split sitemaps (#31).
 * @param {string[]} sitemapUrls Absolute URLs of the sitemap parts
 * @returns {string}
 */
export function buildSitemapIndex(sitemapUrls) {
	const parts = sitemapUrls.map(
		(url) =>
			`  <sitemap>\n    <loc>${sanitizeHtml(url)}</loc>\n    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>\n  </sitemap>`,
	)
	return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts.join('\n')}\n</sitemapindex>\n`
}
/**
 * @typedef {{ p: string, l: LoadStrategy, s?: string }} LoaderDescriptor
 */
/**
 * Normalizes loader input (legacy string paths or full descriptors).
 * @param {(string | LoaderDescriptor | { path: string, load?: LoadStrategy, styles?: string })[]} input
 * @returns {LoaderDescriptor[]}
 */
function normalizeLoaderDescriptors(input) {
	/** @type {Map<string, LoaderDescriptor>} */
	const out = new Map()
	for (const raw of input) {
		const desc =
			typeof raw === 'string'
				? { p: toPosixPath(raw), l: /** @type {LoadStrategy} */ ('eager') }
				: 'p' in raw
					? {
							p: toPosixPath(raw.p),
							l: /** @type {LoadStrategy} */ (raw.l || 'eager'),
							s: raw.s,
						}
					: {
							p: toPosixPath(raw.path),
							l: /** @type {LoadStrategy} */ (raw.load || 'eager'),
							s: raw.styles,
						}
		out.set(JSON.stringify(desc), desc)
	}
	return [...out.values()]
}
/**
 * Returns the hydration comment text for a behavior descriptor.
 * @param {LoaderDescriptor} desc
 * @returns {string}
 */
export function behaviorComment(desc) {
	if (desc.l === 'eager' && !desc.s) {
		return CLIENT_BEHAVIOR_HYDRATE_PREFIX + desc.p
	}
	return CLIENT_BEHAVIOR_HYDRATE_PREFIX + JSON.stringify(desc)
}
/**
 * The client-side hydration runtime shared by all loader strategies.
 * @type {string}
 */
const HYDRATE_RUNTIME = `
const WF_PREFIX = ${JSON.stringify(CLIENT_BEHAVIOR_HYDRATE_PREFIX)};
function wfReport(err, path) {
    console.error('[wunphile] behavior failed:', path, err);
    try {
        fetch('/_wfclient/error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, error: String(err && err.stack || err) }), keepalive: true });
    } catch {}
}
function wfComment(desc) {
    return desc.l === 'eager' && !desc.s ? WF_PREFIX + desc.p : WF_PREFIX + JSON.stringify(desc);
}
function wfStyles(desc) {
    if (!desc.s) return;
    try {
        if ('adoptedStyleSheets' in document && 'CSSStyleSheet' in window) {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(desc.s);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        } else {
            const style = document.createElement('style');
            style.textContent = desc.s;
            document.head.appendChild(style);
        }
    } catch (err) { wfReport(err, desc.p); }
}
function wfRun(mod, elem, desc) {
    try {
        if (typeof mod.behavior === 'function') mod.behavior(elem, desc);
    } catch (err) { wfReport(err, desc.p); }
}
function wfSchedule(mod, elem, desc) {
    const load = desc.l || 'eager';
    if (load === 'idle') {
        (window.requestIdleCallback || ((fn) => setTimeout(fn, 1)))(() => wfRun(mod, elem, desc));
    } else if (load === 'visible' && 'IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) { io.disconnect(); wfRun(mod, elem, desc); }
        });
        io.observe(elem);
    } else if (load === 'interaction') {
        const events = ['click', 'pointerdown', 'touchstart', 'focusin'];
        const handler = () => { for (const ev of events) elem.removeEventListener(ev, handler); wfRun(mod, elem, desc); };
        for (const ev of events) elem.addEventListener(ev, handler, { passive: true });
    } else {
        wfRun(mod, elem, desc);
    }
}
function hydrate(mod, rawDesc) {
    const desc = typeof rawDesc === 'string' ? { p: rawDesc, l: 'eager' } : rawDesc;
    if (!mod) return;
    wfStyles(desc);
    const comment = wfComment(desc);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
    let node;
    while ((node = walker.nextNode())) {
        if (node.nodeType !== Node.COMMENT_NODE || node.textContent !== comment) continue;
        let elem = null;
        let nextNode;
        while ((nextNode = walker.nextNode())) {
            if (nextNode.nodeType === Node.ELEMENT_NODE) { elem = nextNode; break; }
        }
        if (elem) wfSchedule(mod, elem, desc);
    }
}
`.trim()
/**
 * Generates the client loader JavaScript.
 *
 * `strategy: 'dynamic'` (default) keeps the historical `import()` form.
 * `strategy: 'static'` emits hoisted static `import` declarations so the
 * browser's module preloader can fetch every behavior in parallel (#18).
 *
 * Pure function (#39). `ClientManager.generateLoaderScript` delegates here.
 *
 * @param {(string | LoaderDescriptor | { path: string, load?: LoadStrategy, styles?: string })[]} paths
 * @param {{ strategy?: 'dynamic' | 'static', base?: string }} [opts]
 * @returns {string}
 */
export function generateLoaderScript(paths, opts = {}) {
	const descs = normalizeLoaderDescriptors(paths)
	if (descs.length === 0) {
		return ''
	}
	const mount = opts.base ?? CLIENT_MOUNT_PREFIX
	const strategy = opts.strategy ?? 'dynamic'
	if (strategy === 'static') {
		/** @type {string[]} */
		const stmts = []
		descs.forEach((desc, i) => {
			stmts.push(
				`import * as wfMod${i} from ${JSON.stringify(mount + desc.p)};`,
			)
		})
		descs.forEach((desc, i) => {
			stmts.push(
				`try { hydrate(wfMod${i}.default, ${JSON.stringify(desc)}); } catch (err) { wfReport(err, ${JSON.stringify(desc.p)}); }`,
			)
		})
		return HYDRATE_RUNTIME + '\n' + stmts.join('\n')
	}
	const stmts = descs.map(
		(desc) =>
			`import(${JSON.stringify(mount + desc.p)}).then(mod => hydrate(mod.default, ${JSON.stringify(desc)}), err => wfReport(err, ${JSON.stringify(desc.p)}))`,
	)
	return HYDRATE_RUNTIME + '\n' + stmts.join(';\n')
}
/**
 * Generates `<link rel="modulepreload">` tags for behavior modules (#18).
 * @param {(string | LoaderDescriptor | { path: string })[]} paths
 * @param {string} [base]
 * @returns {string}
 */
export function modulePreloadLinks(paths, base = CLIENT_MOUNT_PREFIX) {
	const seen = new Set()
	const out = []
	for (const desc of normalizeLoaderDescriptors(paths)) {
		if (seen.has(desc.p)) {
			continue
		}
		seen.add(desc.p)
		out.push(
			`<link rel="modulepreload" href="${escapeAttribute(base + desc.p)}" />`,
		)
	}
	return out.join('\n')
}

/* ----------------------------------------------------------------------
 * Optional dependency resolution (zero mandatory dependencies, #2/#5/#9/#10)
 * -------------------------------------------------------------------- */
/** @type {Map<string, any>} */
const optionalDepCache = new Map()
/**
 * Resolves an optional dependency synchronously, preferring the user's
 * project over Wunphile's own location. Returns null when absent.
 * @param {string} name
 * @param {string} [rootPath]
 * @returns {any}
 */
export function resolveOptional(name, rootPath = process.cwd()) {
	const key = `${name}|${rootPath}`
	if (optionalDepCache.has(key)) {
		return optionalDepCache.get(key)
	}
	/** @type {any} */
	let found = null
	const requirers = [
		createRequire(
			pathToFileURL(pathUtil.join(rootPath, 'package.json')).href,
		),
		createRequire(import.meta.url),
	]
	for (const req of requirers) {
		try {
			found = req(name)
			if (found) {
				break
			}
		} catch {}
	}
	optionalDepCache.set(key, found)
	return found
}
/* ----------------------------------------------------------------------
 * Frontmatter + Markdown (#5)
 * -------------------------------------------------------------------- */
/**
 * Parses a single scalar frontmatter value.
 * @param {string} raw
 * @returns {any}
 */
function frontmatterValue(raw) {
	const value = raw.trim()
	if (value === '') {
		return ''
	}
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1)
	}
	if (value.startsWith('[') && value.endsWith(']')) {
		return value
			.slice(1, -1)
			.split(',')
			.map((s) => frontmatterValue(s))
			.filter((s) => s !== '')
	}
	if (/^(true|false)$/i.test(value)) {
		return value.toLowerCase() === 'true'
	}
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		return Number(value)
	}
	return value
}
/**
 * Parses YAML-like frontmatter from a Markdown document.
 * Supports scalars, quoted strings, numbers, booleans and inline arrays,
 * which covers the common blog/documentation frontmatter subset.
 * @param {string} raw
 * @returns {{ data: Record<string, any>, body: string }}
 */
export function parseFrontmatter(raw) {
	const src = String(raw ?? '').replace(/^\uFEFF/, '')
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
		src,
	)
	if (match == null) {
		return { data: {}, body: src }
	}
	/** @type {Record<string, any>} */
	const data = {}
	for (const line of match[1].split(/\r?\n/)) {
		if (line.trimStart().startsWith('#') || line.trim() === '') {
			continue
		}
		const colon = line.indexOf(':')
		if (colon === -1) {
			continue
		}
		const key = line.slice(0, colon).trim()
		if (key !== '') {
			data[key] = frontmatterValue(line.slice(colon + 1))
		}
	}
	return { data, body: src.slice(match[0].length) }
}
/**
 * Escapes a Markdown link target, rejecting dangerous schemes.
 * @param {string} href
 * @returns {string}
 */
function markdownHref(href) {
	const value = href.trim()
	if (
		!/^(https?:\/\/|\/|#|mailto:|\.\/|\.\.\/)/i.test(value) &&
		!/^[\w.-]+\/[\w./-]+$/.test(value)
	) {
		return '#'
	}
	return escapeAttribute(value)
}
/**
 * Minimal inline Markdown renderer (operates on already-escaped text).
 * @param {string} raw
 * @returns {string}
 */
function renderInline(raw) {
	/** @type {string[]} */
	const codes = []
	let out = sanitizeHtml(raw).replace(/`([^`]+)`/g, (_, code) => {
		codes.push(`<code>${code}</code>`)
		return `\u0001${codes.length - 1}\u0001`
	})
	out = out
		.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, src, title) =>
			`<img src="${markdownHref(src)}" alt="${alt}"${title ? ` title="${title}"` : ''} />`,
		)
		.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, href, title) =>
			`<a href="${markdownHref(href)}"${title ? ` title="${title}"` : ''}>${label}</a>`,
		)
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/__([^_]+)__/g, '<strong>$1</strong>')
		.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
		.replace(/~~([^~]+)~~/g, '<del>$1</del>')
	return out.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[Number(i)])
}
/**
 * Zero-dependency Markdown renderer used when `marked`/`markdown-it` are not
 * installed. Covers headings, paragraphs, lists, blockquotes, fenced code,
 * inline code, links, images, emphasis and horizontal rules.
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdownBuiltin(md) {
	const lines = String(md ?? '')
		.replace(/\r\n/g, '\n')
		.split('\n')
	/** @type {string[]} */
	const out = []
	/** @type {string[]} */
	let paragraph = []
	const flush = () => {
		if (paragraph.length > 0) {
			out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`)
			paragraph = []
		}
	}
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (line.trim() === '') {
			flush()
			continue
		}
		const fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line)
		if (fence) {
			flush()
			/** @type {string[]} */
			const code = []
			for (i++; i < lines.length && !/^\s*```+\s*$/.test(lines[i]); i++) {
				code.push(lines[i])
			}
			const lang = fence[1]
			out.push(
				`<pre><code${lang ? ` class="language-${escapeAttribute(lang)}"` : ''}>${sanitizeHtml(code.join('\n'))}</code></pre>`,
			)
			continue
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line)
		if (heading) {
			flush()
			const level = heading[1].length
			out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
			continue
		}
		if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
			flush()
			out.push('<hr />')
			continue
		}
		if (/^\s*>\s?/.test(line)) {
			flush()
			/** @type {string[]} */
			const quoted = []
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
				quoted.push(lines[i].replace(/^\s*>\s?/, ''))
				i++
			}
			i--
			out.push(`<blockquote>${renderInline(quoted.join('\n'))}</blockquote>`)
			continue
		}
		if (/^\s*[-*+]\s+/.test(line)) {
			flush()
			/** @type {string[]} */
			const items = []
			while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
				items.push(
					`<li>${renderInline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`,
				)
				i++
			}
			i--
			out.push(`<ul>\n${items.join('\n')}\n</ul>`)
			continue
		}
		if (/^\s*\d+\.\s+/.test(line)) {
			flush()
			/** @type {string[]} */
			const items = []
			while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
				items.push(
					`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`,
				)
				i++
			}
			i--
			out.push(`<ol>\n${items.join('\n')}\n</ol>`)
			continue
		}
		paragraph.push(line)
	}
	flush()
	return out.join('\n')
}
/**
 * Renders Markdown using `marked`, `markdown-it`, or the builtin fallback.
 * @param {string} md
 * @param {{ renderer?: string, rootPath?: string, markedOptions?: any, markdownItOptions?: any }} [opts]
 * @returns {string}
 */
export function renderMarkdown(md, opts = {}) {
	const renderer = opts.renderer ?? 'auto'
	if (renderer === 'auto' || renderer === 'marked') {
		const mod = resolveOptional('marked', opts.rootPath)
		const marked = mod?.marked ?? mod
		if (marked && typeof marked.parse === 'function') {
			const rendered = marked.parse(md, opts.markedOptions ?? {})
			if (typeof rendered === 'string') {
				return rendered
			}
		}
	}
	if (renderer === 'auto' || renderer === 'markdown-it') {
		const mod = resolveOptional('markdown-it', opts.rootPath)
		const MarkdownIt = mod?.default ?? mod
		if (typeof MarkdownIt === 'function') {
			return new MarkdownIt(opts.markdownItOptions ?? {}).render(md)
		}
	}
	return renderMarkdownBuiltin(md)
}
/**
 * Converts a glob to a RegExp (`**`, `*`, `?` are supported).
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
	let re = '^'
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				i++
				if (pattern[i + 1] === '/') {
					i++
					re += '(?:.*/)?'
				} else {
					re += '.*'
				}
			} else {
				re += '[^/]*'
			}
		} else if (c === '?') {
			re += '[^/]'
		} else {
			re += escapeRegex(c)
		}
	}
	return new RegExp(re + '$')
}
/**
 * Reads width/height from common image file headers (#9), avoiding a sharp
 * dependency when only dimension inference is needed.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
export function readImageSize(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 8) {
		return null
	}
	try {
		if (
			buf.length >= 24 &&
			buf.subarray(1, 4).toString('latin1') === 'PNG' &&
			buf.subarray(12, 16).toString('latin1') === 'IHDR'
		) {
			return {
				width: buf.readUInt32BE(16),
				height: buf.readUInt32BE(20),
			}
		}
		if (buf[0] === 0xff && buf[1] === 0xd8) {
			let i = 2
			while (i + 9 < buf.length) {
				if (buf[i] !== 0xff) {
					i++
					continue
				}
				const marker = buf[i + 1]
				if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
					return {
						height: buf.readUInt16BE(i + 5),
						width: buf.readUInt16BE(i + 7),
					}
				}
				const len = buf.readUInt16BE(i + 2)
				if (len < 2) {
					break
				}
				i += 2 + len
			}
			return null
		}
		if (buf.subarray(0, 3).toString('latin1') === 'GIF') {
			return {
				width: buf.readUInt16LE(6),
				height: buf.readUInt16LE(8),
			}
		}
		if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
			const chunk = buf.subarray(12, 16).toString('latin1')
			if (chunk === 'VP8X') {
				return {
					width: 1 + buf.readUIntLE(24, 3),
					height: 1 + buf.readUIntLE(27, 3),
				}
			}
			if (chunk === 'VP8 ') {
				return {
					width: buf.readUInt16LE(26) & 0x3fff,
					height: buf.readUInt16LE(28) & 0x3fff,
				}
			}
			if (chunk === 'VP8L') {
				const bits = buf.readUInt32LE(21)
				return {
					width: (bits & 0x3fff) + 1,
					height: ((bits >> 14) & 0x3fff) + 1,
				}
			}
		}
		if (buf.subarray(4, 8).toString('latin1') === 'ftyp' && /ispe/.test(buf.subarray(0, Math.min(buf.length, 512)).toString('latin1'))) {
			const idx = buf.indexOf(Buffer.from('ispe'))
			if (idx !== -1) {
				return {
					width: buf.readUInt32BE(idx + 8),
					height: buf.readUInt32BE(idx + 12),
				}
			}
		}
		if (buf.subarray(0, 200).toString('utf8').includes('<svg')) {
			const str = buf.subarray(0, 2048).toString('utf8')
			const viewBox = /\bviewBox\s*=\s*["'][^"']*?\s([\d.]+)\s+([\d.]+)["']/.exec(str)
			if (viewBox) {
				return {
					width: Math.round(Number(viewBox[1])),
					height: Math.round(Number(viewBox[2])),
				}
			}
			const w = /\bwidth\s*=\s*["']([\d.]+)/.exec(str)
			const h = /\bheight\s*=\s*["']([\d.]+)/.exec(str)
			if (w && h) {
				return {
					width: Math.round(Number(w[1])),
					height: Math.round(Number(h[1])),
				}
			}
		}
	} catch {}
	return null
}
/**
 * Runs `fn` over every item with a bounded concurrency (#22).
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapConcurrent(items, limit, fn) {
	/** @type {R[]} */
	const results = new Array(items.length)
	let next = 0
	const worker = async () => {
		while (true) {
			const index = next++
			if (index >= items.length) {
				return
			}
			results[index] = await fn(items[index], index)
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
	)
	return results
}
/**
 * Formats a byte count for build reports.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
	if (bytes < 1024) {
		return `${bytes}B`
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`
	}
	return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}
/**
 * Maps common file extensions to MIME types without a mandatory dependency.
 * @param {string} ext Extension without a leading dot
 * @returns {string}
 */
export function mimeForExt(ext) {
	/** @type {Record<string, string>} */
	const map = {
		html: 'text/html; charset=utf-8',
		htm: 'text/html; charset=utf-8',
		css: 'text/css; charset=utf-8',
		js: 'text/javascript; charset=utf-8',
		mjs: 'text/javascript; charset=utf-8',
		cjs: 'text/javascript; charset=utf-8',
		json: 'application/json; charset=utf-8',
		xml: 'application/xml; charset=utf-8',
		txt: 'text/plain; charset=utf-8',
		svg: 'image/svg+xml',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		webp: 'image/webp',
		avif: 'image/avif',
		ico: 'image/x-icon',
		woff: 'font/woff',
		woff2: 'font/woff2',
		ttf: 'font/ttf',
		pdf: 'application/pdf',
		mp4: 'video/mp4',
		webm: 'video/webm',
		wasm: 'application/wasm',
		map: 'application/json; charset=utf-8',
	}
	return map[String(ext).toLowerCase()] ?? 'application/octet-stream'
}
/**
 * Recursively lists files under a directory as POSIX-relative paths.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listFilesRecursive(dir) {
	/** @type {string[]} */
	const files = []
	/** @type {string[]} */
	const stack = ['']
	while (stack.length > 0) {
		const relDir = /** @type {string} */ (stack.pop())
		let dirents = []
		try {
			dirents = await fs.readdir(pathUtil.join(dir, relDir), {
				withFileTypes: true,
			})
		} catch {
			continue
		}
		for (const dirent of dirents) {
			const rel = toPosixPath(pathUtil.join(relDir, dirent.name))
			if (dirent.isDirectory()) {
				stack.push(rel)
			} else if (dirent.isFile()) {
				files.push(rel)
			}
		}
	}
	return files
}
/**
 * True when a MIME type benefits from HTTP compression (#14).
 * @param {string} mime
 * @returns {boolean}
 */
export function shouldCompress(mime) {
	return /^(text\/|application\/(json|javascript|xml|rdf\+xml|xhtml\+xml)|image\/svg\+xml)/i.test(
		mime,
	)
}
/**
 * Normalizes a URL-style path: POSIX separators, exactly one leading slash.
 * @param {string} path
 * @returns {string}
 */
export function normalizeUrlPath(path) {
	return '/' + toPosixPath(String(path)).replace(/^\/+/, '')
}
/**
 * Sends a Buffer or file with ETag/304, Range and content-encoding support
 * (#13/#14). Shared by the dev server and `preview()`.
 *
 * @param {any} res
 * @param {any} req
 * @param {{ body?: Buffer | string, filePath?: string, stat?: import('node:fs').Stats, mime?: string, headers?: Record<string, string>, etag?: string, cacheControl?: string, status?: number }} opts
 * @returns {Promise<void>}
 */
export async function sendContent(res, req, opts) {
	const mime = opts.mime ?? 'application/octet-stream'
	const status = opts.status ?? 200
	/** @type {Buffer | null} */
	let body = null
	/** @type {string | null} */
	let filePath = opts.filePath ?? null
	let size = 0
	let etag = opts.etag ?? ''
	if (opts.body != null) {
		body = Buffer.isBuffer(opts.body)
			? opts.body
			: Buffer.from(String(opts.body))
		size = body.length
		etag = etag || `"${contentHash(body)}-${size.toString(36)}"`
	} else {
		const stat = opts.stat ?? (await fs.stat(/** @type {string} */ (filePath)))
		size = stat.size
		etag = etag || `"${Math.floor(stat.mtimeMs).toString(36)}-${size.toString(36)}"`
	}
	/** @type {Record<string, string>} */
	const headers = {
		...(opts.headers ?? {}),
		'Content-Type': mime,
		'Accept-Ranges': 'bytes',
		ETag: etag,
	}
	if (opts.cacheControl) {
		headers['Cache-Control'] = opts.cacheControl
	}
	const inm = req.headers?.['if-none-match']
	if (
		typeof inm === 'string' &&
		inm.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))
	) {
		res.writeHead(304, headers)
		res.end()
		return
	}
	// Range requests (#13): bytes=start-end, bytes=start-, bytes=-suffix.
	const rangeHeader = req.headers?.range
	/** @type {{ start: number, end: number } | null} */
	let range = null
	if (typeof rangeHeader === 'string' && /^bytes=/.test(rangeHeader)) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
		if (match) {
			let start = match[1] === '' ? 0 : Number(match[1])
			let end = match[2] === '' ? size - 1 : Number(match[2])
			if (match[1] === '' && match[2] !== '') {
				start = Math.max(0, size - Number(match[2]))
				end = size - 1
			}
			if (size > 0 && start <= end && start < size) {
				range = { start, end: Math.min(end, size - 1) }
			}
		}
		if (range == null) {
			res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
			res.end()
			return
		}
		headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
	}
	if (range != null) {
		headers['Content-Length'] = String(range.end - range.start + 1)
		res.writeHead(206, headers)
		if (req.method === 'HEAD') {
			res.end()
			return
		}
		if (body != null) {
			res.end(body.subarray(range.start, range.end + 1))
		} else {
			await pipeline(
				fsSync.createReadStream(/** @type {string} */ (filePath), {
					start: range.start,
					end: range.end,
				}),
				res,
			)
		}
		return
	}
	// Compression (#14). Range responses are never compressed.
	const acceptEncoding = String(req.headers?.['accept-encoding'] ?? '')
	let encoding = null
	if (shouldCompress(mime) && size > 0 && size < 16 * 1024 * 1024) {
		if (/\bbr\b/.test(acceptEncoding) && typeof zlib.brotliCompressSync === 'function') {
			encoding = 'br'
		} else if (/\bgzip\b/.test(acceptEncoding)) {
			encoding = 'gzip'
		}
	}
	if (encoding != null) {
		if (body == null && filePath != null) {
			body = await fs.readFile(filePath)
		}
		const compressed =
			encoding === 'br'
				? zlib.brotliCompressSync(/** @type {Buffer} */ (body))
				: zlib.gzipSync(/** @type {Buffer} */ (body))
		headers['Content-Encoding'] = encoding
		headers['Vary'] = 'Accept-Encoding'
		headers['Content-Length'] = String(compressed.length)
		res.writeHead(status, headers)
		if (req.method !== 'HEAD') {
			res.end(compressed)
		} else {
			res.end()
		}
		return
	}
	headers['Content-Length'] = String(size)
	res.writeHead(status, headers)
	if (req.method === 'HEAD') {
		res.end()
		return
	}
	if (body != null) {
		res.end(body)
	} else {
		await pipeline(
			fsSync.createReadStream(/** @type {string} */ (filePath)),
			res,
		)
	}
}
/* ----------------------------------------------------------------------
 * Feeds, robots, head and accessibility (#7/#8/#30/#33)
 * -------------------------------------------------------------------- */
/**
 * Escapes a value for XML text content.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXml(value) {
	return sanitizeHtml(String(value ?? ''))
}
/**
 * Builds an RSS 2.0, Atom 1.0 or JSON Feed 1.1 document (#8).
 * @param {{ format?: 'rss' | 'atom' | 'json', title?: string, description?: string, baseUrl?: string, path?: string, language?: string, author?: string, entries?: any[], url?: (entry: any) => string }} options
 * @returns {string}
 */
export function buildFeed(options = {}) {
	const format = options.format ?? 'rss'
	const base = (options.baseUrl ?? '').replace(/\/+$/, '')
	const feedPath = options.path ?? '/feed.xml'
	const title = options.title ?? 'Feed'
	const description = options.description ?? ''
	const entries = options.entries ?? []
	const selfUrl = base + feedPath
	/** @type {{ url: string, title: string, html: string, summary: string, date: string, id: string }[]} */
	const items = entries.map((entry) => {
		const url =
			typeof options.url === 'function'
				? options.url(entry)
				: entry.url ?? `${base}/${String(entry.slug ?? '').replace(/^\/+/, '')}`
		return {
			url: url.startsWith('http') ? url : base + normalizeUrlPath(url),
			title: String(entry.title ?? entry.data?.title ?? entry.slug ?? ''),
			html: String(entry.html ?? ''),
			summary: stripHtml(String(entry.description ?? entry.data?.description ?? entry.html ?? '')),
			date: String(entry.date ?? entry.data?.date ?? ''),
			id: String(entry.slug ?? url),
		}
	})
	if (format === 'json') {
		return JSON.stringify(
			{
				version: 'https://jsonfeed.org/version/1.1',
				title,
				description,
				home_page_url: base || undefined,
				feed_url: selfUrl || undefined,
				language: options.language,
				items: items.map((item) => ({
					id: item.id,
					url: item.url,
					title: item.title,
					summary: item.summary,
					content_html: item.html,
					date_published: /^\d{4}-\d{2}-\d{2}/.test(item.date)
						? new Date(item.date).toISOString()
						: undefined,
				})),
			},
			null,
			2,
		) + '\n'
	}
	if (format === 'atom') {
		const xmlEntries = items
			.map(
				(item) =>
					`  <entry>\n    <title>${escapeXml(item.title)}</title>\n    <id>${escapeXml(item.id)}</id>\n    <link href="${escapeAttribute(item.url)}" />\n${item.date ? `    <updated>${escapeXml(item.date)}</updated>\n` : ''}    <summary>${escapeXml(item.summary)}</summary>\n    <content type="html">${escapeXml(item.html)}</content>\n  </entry>`,
			)
			.join('\n')
		return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <title>${escapeXml(title)}</title>\n  <subtitle>${escapeXml(description)}</subtitle>\n  <link href="${escapeAttribute(selfUrl)}" rel="self" />\n  <id>${escapeXml(base || title)}</id>\n  <updated>${new Date().toISOString()}</updated>\n${options.author ? `  <author><name>${escapeXml(options.author)}</name></author>\n` : ''}${xmlEntries}\n</feed>\n`
	}
	const xmlEntries = items
		.map(
			(item) =>
				`    <item>\n      <title>${escapeXml(item.title)}</title>\n      <link>${escapeXml(item.url)}</link>\n      <guid>${escapeXml(item.url)}</guid>\n${item.date ? `      <pubDate>${escapeXml(item.date)}</pubDate>\n` : ''}      <description>${escapeXml(item.summary)}</description>\n      <content:encoded><![CDATA[${item.html}]]></content:encoded>\n    </item>`,
		)
		.join('\n')
	return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>${escapeXml(title)}</title>\n    <link>${escapeXml(base)}</link>\n    <description>${escapeXml(description)}</description>\n${options.language ? `    <language>${escapeXml(options.language)}</language>\n` : ''}    <atom:link href="${escapeAttribute(selfUrl)}" rel="self" type="application/rss+xml" />\n${xmlEntries}\n  </channel>\n</rss>\n`
}
/**
 * Builds a `robots.txt` document (#8).
 * @param {{ sitemap?: boolean | string, disallow?: string[], allow?: string[], userAgent?: string, host?: string, extra?: string[] }} [options]
 * @returns {string}
 */
export function buildRobots(options = {}) {
	const lines = [`User-agent: ${options.userAgent ?? '*'}`]
	for (const path of options.allow ?? []) {
		lines.push(`Allow: ${path}`)
	}
	for (const path of options.disallow ?? []) {
		lines.push(`Disallow: ${path}`)
	}
	if (options.sitemap) {
		const url =
			typeof options.sitemap === 'string'
				? options.sitemap
				: options.host
					? `${options.host.replace(/\/+$/, '')}/sitemap.xml`
					: '/sitemap.xml'
		lines.push(`Sitemap: ${url}`)
	}
	if (options.host) {
		lines.push(`Host: ${options.host}`)
	}
	for (const line of options.extra ?? []) {
		lines.push(line)
	}
	return lines.join('\n') + '\n'
}
/**
 * Renders collected `<Head>` fragments into head tags (#7/#30).
 * @param {Record<string, any>} head
 * @param {{ baseUrl?: string, path?: string, locales?: string[], defaultLocale?: string, locale?: string | null, ogImage?: string | null, urlForLocale?: (locale: string, path: string) => string }} [opts]
 * @returns {string}
 */
export function renderHeadTags(head, opts = {}) {
	/** @type {string[]} */
	const tags = []
	const base = (opts.baseUrl ?? '').replace(/\/+$/, '')
	const path = opts.path ?? '/'
	if (head.title != null) {
		tags.push(`<title>${sanitizeHtml(String(head.title))}</title>`)
	}
	if (head.description != null) {
		tags.push(
			`<meta name="description" content="${escapeAttribute(head.description)}" />`,
		)
	}
	if (head.robots != null) {
		tags.push(
			`<meta name="robots" content="${escapeAttribute(head.robots)}" />`,
		)
	}
	/** @type {{ name?: string, property?: string, 'http-equiv'?: string, charset?: string, content?: string }[]} */
	const meta = head.meta ?? []
	for (const entry of Array.isArray(meta) ? meta : []) {
		if (entry.charset) {
			tags.push(`<meta charset="${escapeAttribute(entry.charset)}" />`)
		} else if (entry['http-equiv']) {
			tags.push(
				`<meta http-equiv="${escapeAttribute(entry['http-equiv'])}" content="${escapeAttribute(entry.content)}" />`,
			)
		} else if (entry.name || entry.property) {
			tags.push(
				`<meta ${entry.property ? 'property' : 'name'}="${escapeAttribute(entry.property ?? entry.name)}" content="${escapeAttribute(entry.content)}" />`,
			)
		}
	}
	const og = head.og ?? {}
	const ogValues = {
		'og:title': og.title ?? head.title,
		'og:type': og.type ?? (path === '/' ? 'website' : 'article'),
		'og:url': og.url ?? (base ? base + path : ''),
		'og:image': og.image ?? opts.ogImage ?? head.image,
		'og:description': og.description ?? head.description,
		'og:site_name': og.siteName,
		'og:locale': og.locale ?? opts.locale,
		'twitter:card': og.twitterCard ?? 'summary_large_image',
		'twitter:title': og.twitterTitle ?? og.title ?? head.title,
		'twitter:image': og.twitterImage ?? og.image ?? opts.ogImage ?? head.image,
	}
	const hasOgIntent =
		head.title != null ||
		head.description != null ||
		head.image != null ||
		opts.ogImage != null ||
		Object.keys(og).length > 0
	const emitOg =
		hasOgIntent && Object.values(ogValues).some((v) => v != null && v !== '')
	if (emitOg) {
		for (const [key, value] of Object.entries(ogValues)) {
			if (value != null && value !== '') {
				tags.push(
					`<meta property="${escapeAttribute(key)}" content="${escapeAttribute(value)}" />`,
				)
			}
		}
	}
	const canonical = head.canonical ?? (base ? base + path : null)
	if (head.canonical !== false && canonical) {
		tags.push(
			`<link rel="canonical" href="${escapeAttribute(canonical)}" />`,
		)
	}
	if ((opts.locales?.length ?? 0) > 1) {
		for (const locale of /** @type {string[]} */ (opts.locales)) {
			const href =
				typeof opts.urlForLocale === 'function'
					? opts.urlForLocale(locale, path)
					: base +
						(locale === opts.defaultLocale ? '' : `/${locale}`) +
						path
			tags.push(
				`<link rel="alternate" hreflang="${escapeAttribute(locale)}" href="${escapeAttribute(href)}" />`,
			)
		}
		tags.push(
			`<link rel="alternate" hreflang="x-default" href="${escapeAttribute(base + path)}" />`,
		)
	}
	for (const link of head.links ?? []) {
		const attrs = Object.entries(link)
			.map(([k, v]) => `${k}="${escapeAttribute(v)}"`)
			.join(' ')
		tags.push(`<link ${attrs} />`)
	}
	if (head.jsonLd != null) {
		tags.push(
			`<script type="application/ld+json">${JSON.stringify(head.jsonLd).replace(/</g, '\\u003c')}</script>`,
		)
	}
	return tags.join('\n')
}
/**
 * Lightweight development-mode accessibility checks (#33).
 * @param {string} htmlStr
 * @returns {string[]}
 */
export function checkAccessibility(htmlStr) {
	/** @type {string[]} */
	const warnings = []
	const htmlTag = /<html\b[^>]*>/i.exec(htmlStr)
	if (htmlTag && !/\blang\s*=/i.test(htmlTag[0])) {
		warnings.push('<html> is missing a lang attribute')
	}
	for (const match of htmlStr.matchAll(/<img\b[^>]*>/gi)) {
		if (!/\balt\s*=/i.test(match[0])) {
			warnings.push(`<img> without alt: ${match[0].slice(0, 80)}`)
		}
	}
	/** @type {Set<string>} */
	const ids = new Set()
	for (const match of htmlStr.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) {
		if (ids.has(match[1])) {
			warnings.push(`duplicate id="${match[1]}"`)
		}
		ids.add(match[1])
	}
	if (/<html\b/i.test(htmlStr) && !/<title\b/i.test(htmlStr)) {
		warnings.push('document has no <title>')
	}
	return warnings
}
/**
 * Injects head tags into an HTML document.
 * @param {string} htmlStr
 * @param {string} headTags
 * @returns {string}
 */
export function injectHead(htmlStr, headTags) {
	if (headTags.trim() === '') {
		return htmlStr
	}
	const openHead = /<head\b[^>]*>/i.exec(htmlStr)
	if (openHead) {
		const at = openHead.index + openHead[0].length
		return (
			htmlStr.slice(0, at) + '\n' + headTags + '\n' + htmlStr.slice(at)
		)
	}
	const openHtml = /<html\b[^>]*>/i.exec(htmlStr)
	if (openHtml) {
		const at = openHtml.index + openHtml[0].length
		return (
			htmlStr.slice(0, at) +
			`\n<head>\n${headTags}\n</head>\n` +
			htmlStr.slice(at)
		)
	}
	return `<head>\n${headTags}\n</head>\n` + htmlStr
}

/**
 * Manager for client-side behaviors and modules.
 *
 * Serves as a crude bundler for JS modules.
 * It works by resolving top-level imports and building a dependency graph.
 *
 * TypeScript modules can be used and imported, but imports to them will be converted to plain JS beforehand.
 * The manager does not include any TypeScript support; instead, it relies on the runtime to do type stripping and simply uses the `.toString()` method to get the sources for functions.
 */
class ClientManager {
	/**
     * @typedef {{ type: 'plain' } | { type: 'behavior', rewrittenContent: string, rewrittenPath: string, styles?: string, load?: string }} LoadedModule
      A loaded module object either contains a plain JS module that can be copied/served verbatim, or a behavior module's rewritten source and path.
     */
	/**
	 * @type {Wunphile}
	 */
	// REFACTOR: Legacy `SSG`-based naming replaced with the canonical Wunphile name.
	#wunphile
	/**
	 * Resolves the current project root path.
	 * @type {() => string}
	 */
	// FIX #10: A getter rather than a snapshot, so overrideRootPath() and
	// worker-mode root paths are honored when modules are actually loaded.
	#getProjectRootPath
	/**
	 * The path to the client directory.
	 * Absolute path.
	 * @type {string}
	 */
	rootPath
	/**
	 * All currently loaded modules.
	 * The key is the path relative to the client directory (POSIX-style).
	 * @type {Map<string, LoadedModule>}
	 * @internal For internal use only, may be removed or renamed between patch releases.
	 */
	loadedModules = new Map()
	/**
	 * Promises for modules currently being processed.
	 * The keys are the same as {@link loadedModules}' keys.
	 * @type {Map<string, Promise<void>>}
	 */
	#processingModules = new Map()
	/**
	 * All currently loading modules.
	 * A set of promises from `import()` calls.
	 * @type {Set<Promise<any>>}
	 */
	#loadingModules = /** @type {Set<Promise<any>>} */ (new Set())
	/**
	 * Modules already emitted as pages/static files. Shared dependencies are
	 * registered exactly once per generation (#19/#24).
	 * @type {Set<string>}
	 */
	#emittedModules = new Set()
	/**
	 * When enabled, imports inside rewritten behavior modules point at one
	 * canonical absolute URL instead of a per-module relative path (#19).
	 * @type {boolean}
	 */
	#absoluteImports = false
	/**
	 * Creates a new client manager.
	 * @param {Wunphile} wunphile The Wunphile instance
	 * @param {string} rootPath The path to the client directory
	 * @param {() => string} getProjectRootPath Resolves the Wunphile project root path
	 */
	// REFACTOR: Constructor parameter renamed to `wunphile` (name only, no behavior change).
	// FIX #10: The manager needs the project root (not the CWD) to express
	// static file sources as project-relative paths.
	constructor(wunphile, rootPath, getProjectRootPath) {
		this.#wunphile = wunphile
		this.rootPath = pathUtil.resolve(rootPath)
		this.#getProjectRootPath = getProjectRootPath
	}
	/**
	 * Returns the path relative to the client directory in POSIX style, or null if it is outside the client directory.
	 *
	 * BUG 3 FIX: The result is normalized to forward slashes so it can be used
	 * as a URL segment or a Map key that is consistent across platforms.
	 *
	 * FIX #6: The old `res.startsWith('..')` check both accepted Windows
	 * cross-drive paths (pathUtil.relative returns an absolute path there)
	 * and rejected legitimate filenames such as `..foo.js`.
	 *
	 * @param {string} path The path to check
	 * @returns {string | null} The POSIX-relative path or null if outside the client dir
	 */
	#getPathRelativeToClientDir(path) {
		// FIX #6: Use the raw (non-POSIX) relative result so the boundary
		// checks see the platform separator, then normalize for URLs.
		const raw = pathUtil.relative(this.rootPath, path)
		// FIX #6: Assumption - raw === '' means the path is the client
		// directory itself, which is not a valid module path, so it is
		// rejected just like a path outside the client directory.
		if (
			raw === '' ||
			raw === '..' ||
			raw.startsWith('..' + pathUtil.sep) ||
			pathUtil.isAbsolute(raw)
		) {
			return null
		}
		return './' + toPosixPath(raw)
	}
	/**
	 * Loads a module.
	 * Processes behavior modules and makes note of non-behavior modules.
	 * @param {any} mod The imported module.
	 * @param {string | null} modPath The module's path, or null if this is supposed to be a behavior module.
	 */
	async #loadModule(mod, modPath) {
		// Is this a behavior module?
		if (typeof mod?.default?.behaviorModuleUrl !== 'string') {
			if (modPath == null) {
				throw new Error(
					'Module did not export a default behavior module. Behavior modules must have a default export that adheres to the BehaviorModule type.',
				)
			}
			// Check if path is within the client directory.
			if (this.#getPathRelativeToClientDir(modPath) == null) {
				throw new Error(
					`Module path "${modPath}" is outside the client directory.`,
				)
			}
			const relativePath = relPosix(this.rootPath, modPath)
			this.loadedModules.set(relativePath, { type: 'plain' })
			// FIX #10: staticFile() resolves its source via toProjectPath()
			// (relative to the Wunphile root). pathUtil.relative('./', ...)
			// was relative to the CWD and produced a wrong path whenever
			// CWD !== project root.
			// #19: shared dependencies are emitted once per generation.
			if (!this.#emittedModules.has(relativePath)) {
				this.#emittedModules.add(relativePath)
				this.#wunphile.staticFile(
					CLIENT_MOUNT_PREFIX + relativePath,
					pathUtil.relative(this.#getProjectRootPath(), modPath),
				)
			}
			const noteDep = /** @type {any} */ (this.#wunphile).noteModuleDependency
			if (typeof noteDep === 'function') {
				noteDep.call(this.#wunphile, relativePath)
			}
			return
		}
		// This is a behavior module.
		const behaviorMod = /** @type {BehaviorModule} */ (mod.default)
		const modUrl = behaviorMod.behaviorModuleUrl
		const behaviorModPath = pathUtil.resolve(fileURLToPath(modUrl))
		const loadedModKey = relPosix(this.rootPath, behaviorModPath)
		// Is it already loading?
		let loaderProm = this.#processingModules.get(loadedModKey)
		if (loaderProm != null) {
			// Wait until it's loaded.
			await loaderProm
			return
		}
		// Not already loading, load it and let other concurrent calls wait on it.
		loaderProm = (async () => {
			const isTypeScript =
				modUrl.endsWith('.ts') || modUrl.endsWith('.mts')
			const behaviorModDir = pathUtil.resolve(
				pathUtil.dirname(behaviorModPath),
			)
			// Load the behavior module's source from the filesystem.
			const source = (
				await fs.readFile(behaviorModPath, 'utf8')
			).toString()
			/** @type {{ fullImportPath: string, relativePath: string, importsStr: string | null }[]} */
			const imports = []
			// The first thing we need to do is find all imports and resolve them.
			for (const importStmt of splitIter(source, '\n')) {
				const match = importStmt.match(importStmtRegex)
				if (match == null || match.groups == null) {
					if (exportStmtRegex.test(importStmt)) {
						// Reached export statement, stop looking for imports.
						break
					} else {
						continue
					}
				}
				const importsRaw = match.groups.imports
				let importsStr = null
				if (isTypeScript && importsRaw?.startsWith('type ')) {
					// Skip type imports.
					continue
				}
				// IMPROVEMENT (issue #7): Replaced eval() with a safe parser.
				const specifiedPath = parseQuotedString(match.groups.path)
				const relativeToRoot = this.#getPathRelativeToClientDir(
					pathUtil.join(behaviorModDir, specifiedPath),
				)
				if (relativeToRoot == null) {
					throw new Error(
						`Imported path "${specifiedPath}" specified in behavior module "${behaviorModPath}" is outside the client directory.`,
					)
				}
				const fullImportPath = pathUtil.join(
					this.rootPath,
					relativeToRoot,
				)
				// BUG 3 FIX: Normalize to POSIX so URL/JS generation is safe.
				let relativeToModDir = relPosix(
					behaviorModDir,
					fullImportPath,
				)
				if (!relativeToModDir.startsWith('.')) {
					relativeToModDir = './' + relativeToModDir
				}
				// #19: optionally route every dependency through one canonical
				// absolute URL so the browser deduplicates shared modules.
				if (this.#absoluteImports) {
					relativeToModDir =
						CLIENT_MOUNT_PREFIX +
						relPosix(this.rootPath, fullImportPath)
				}
				// Resolve the imports string.
				if (importsRaw != null) {
					if (isTypeScript) {
						if (importsRaw.startsWith('{')) {
							importsStr = '{ '
							const importStrs = importsRaw
								.slice(1, -1)
								.split(',')
							if (importStrs.length !== 0) {
								for (let importStr of importStrs) {
									importStr = importStr.trim()
									if (importStr.startsWith('type ')) {
										// Skip type imports.
										continue
									}
									importsStr += importStr + ', '
								}
								importsStr = importsStr.slice(0, -2) + ' }'
							}
						} else {
							importsStr = importsRaw
						}
					} else {
						importsStr = importsRaw
					}
				}
				imports.push({
					fullImportPath,
					relativePath: relativeToModDir,
					importsStr,
				})
			}
			// Load all imports asynchronously.
			for (const { fullImportPath } of imports) {
				// FIX #2: fullImportPath is an absolute filesystem path; on
				// Windows dynamic import() would parse "D:" as a URL scheme
				// and throw ERR_UNSUPPORTED_ESM_URL_SCHEME.
				const promise = import(pathToFileURL(fullImportPath).href)
				this.#loadingModules.add(promise)
				promise
					.then((mod) => this.#loadModule(mod, fullImportPath))
					.catch((err) => {
						if (err instanceof ReferenceError) {
							console.error(
								`Caught ReferenceError while loading module "${fullImportPath}". This is likely due to a module with side effects (such as using browser APIs). Please remove side effects from behavior modules.`,
							)
						}
						throw err
					})
					.finally(() => this.#loadingModules.delete(promise))
			}
			// Rewrite the source.
			let out = ''
			for (const { relativePath, importsStr } of imports) {
				if (importsStr == null) {
					out += `import ${JSON.stringify(relativePath)}\n`
				} else {
					out += `import ${importsStr} from ${JSON.stringify(relativePath)}\n`
				}
			}
			out +=
				'\nexport default {\n    behaviorModuleUrl: import.meta.url,\n    behavior: '
			if (behaviorMod.behavior == null) {
				out += 'undefined,\n'
			} else {
				out += behaviorMod.behavior.toString() + ',\n'
			}
			out += '    functions: '
			if (behaviorMod.functions == null) {
				out += 'undefined,\n'
			} else {
				out += '{\n'
				for (const [key, val] of Object.entries(
					behaviorMod.functions,
				)) {
					out += `        ${JSON.stringify(key)}: ${val.toString()},\n`
				}
				out += '    },\n'
			}
			// #21: ship CSS with the module so the loader can adopt it without
			// an extra request. #20: modules may declare a default load strategy.
			out +=
				'    styles: ' +
				(behaviorMod.styles == null
					? 'undefined'
					: JSON.stringify(behaviorMod.styles)) +
				',\n'
			out +=
				'    load: ' +
				(behaviorMod.load == null
					? 'undefined'
					: JSON.stringify(behaviorMod.load)) +
				',\n'
			out += '}\n'
			let modOutPath = behaviorModPath
			if (isTypeScript) {
				// BUG 4 FIX: The original used `.slice(0, -3)` which is only
				// correct for 3-char extensions like `.ts`. For `.mts` (4 chars),
				// this produced "X.m.js". Use pathUtil.parse() instead.
				const parsed = pathUtil.parse(modOutPath)
				modOutPath = pathUtil.join(parsed.dir, parsed.name + '.js')
			}
			// Calculate hash to use in the module's rewritten path.
			const hash = createHash('sha256')
				.update(source)
				.digest('base64url')
				.slice(0, 8)
			// Set the loaded module and mount it.
			const ext = pathUtil.extname(modOutPath)
			// BUG 3 FIX: The rewritten path is used as a URL, normalize it.
			const rewrittenPath = relPosix(
				this.rootPath,
				modOutPath.substring(0, modOutPath.length - ext.length) + '-' + hash + ext
			)
			this.loadedModules.set(loadedModKey, {
				type: 'behavior',
				rewrittenContent: out,
				rewrittenPath,
				styles: behaviorMod.styles,
				load: behaviorMod.load,
			})
			if (!this.#emittedModules.has(rewrittenPath)) {
				this.#emittedModules.add(rewrittenPath)
				this.#wunphile.pageRaw(CLIENT_MOUNT_PREFIX + rewrittenPath, out)
			}
			const noteDep = /** @type {any} */ (this.#wunphile).noteModuleDependency
			if (typeof noteDep === 'function') {
				noteDep.call(this.#wunphile, rewrittenPath)
			}
			})()
		this.#processingModules.set(loadedModKey, loaderProm)
		await loaderProm
	}
	/**
	 * Loads a behavior module asynchronously.
	 * Expects that the module exports a default {@link BehaviorModule} object.
	 *
	 * Call {@link waitForModules} to wait for all modules to load.
	 *
	 * @param {Promise<any>} promise The promise from the `import()` call for the behavior module
	 */
	loadBehaviorModule(promise) {
		// FIX #5: Track the whole chain (import + #loadModule processing),
		// not just the raw import promise, so waitForModules() observes both
		// import failures and processing failures instead of leaving a
		// derived promise as an unhandled rejection.
		const loaded = promise.then((mod) => this.#loadModule(mod, null))
		this.#loadingModules.add(loaded)
		loaded.then(
			() => this.#loadingModules.delete(loaded),
			() => this.#loadingModules.delete(loaded),
		)
	}
	/**
	 * Waits for all modules to load.
	 * Rejects with the first module load error instead of silently swallowing it.
	 * @returns {Promise<void>}
	 */
	async waitForModules() {
		// FIX #5: Promise.allSettled() prevents an unhandled rejection, but
		// discarding its results hid every load failure. Re-throw the first
		// reason. The while loop still handles imports spawned while loading.
		while (this.#loadingModules.size > 0) {
			const pending = [...this.#loadingModules]
			const results = await Promise.allSettled(pending)
			for (const r of results) {
				if (r.status === 'rejected') {
					throw r.reason
				}
			}
		}
	}
	/**
	 * Generates a loader script for the specified rewritten relative paths to behavior modules.
	 * Delegates to the pure {@link generateLoaderScript} export (#39).
	 *
	 * The historical `break break` syntax error and the misplaced closing
	 * brace in `hydrate()` (#18) are gone: the runtime is now a single tested
	 * string shared by both loader strategies.
	 *
	 * @param {(string | LoaderDescriptor | { path: string, load?: LoadStrategy, styles?: string })[]} rewrittenRelativePaths
	 * @param {{ strategy?: 'dynamic' | 'static', base?: string }} [opts]
	 * @returns {string} The loader script
	 */
	generateLoaderScript(rewrittenRelativePaths, opts = {}) {
		return generateLoaderScript(rewrittenRelativePaths, opts)
	}
	/**
	 * Enables canonical absolute import URLs for shared dependencies (#19).
	 * @param {boolean} enabled
	 */
	setAbsoluteImports(enabled) {
		this.#absoluteImports = enabled
	}
	/**
	 * Drops all per-generation caches (#24). Called on every hot reload so a
	 * long-running dev server does not accumulate rewritten modules.
	 */
	newGeneration() {
		this.loadedModules.clear()
		this.#processingModules.clear()
		this.#loadingModules.clear()
		this.#emittedModules.clear()
	}
	/**
	 * Content fingerprints of every loaded module, used by incremental
	 * builds to hash a page's dependency graph (#23).
	 * @returns {string[]}
	 */
	moduleFingerprints() {
		/** @type {string[]} */
		const out = []
		for (const [key, info] of this.loadedModules) {
			out.push(
				info.type === 'behavior'
					? `${key}:${contentHash(info.rewrittenContent)}`
					: key,
			)
		}
		return out.sort()
	}
}
// REFACTOR: Class documentation and examples use the canonical
// `wunphile` name. `SSG` is only a legacy alias exported further down.
/**
 * The main class for the Wunphile library.
 *
 * @example
 * ```js
 * import { Wunphile } from 'wunphile'
 * import { IndexPage } from './components/Greeting.js'
 *
 * const wunphile = new Wunphile(import.meta.url)
 *
 * wunphile.page('/index.html', IndexPage)
 *
 * await wunphile.cli()
 * ```
 */
export class Wunphile {
	/**
	 * @type {string}
	 */
	#mainModulePath
	/**
	 * @type {string}
	 */
	#rootPath
	/**
	 * @type {string}
	 */
	#outputPath
	/**
	 * URL-style path (always starts with `/`) for the not found page.
	 * Stored in POSIX form; not a filesystem path.
	 * @type {string}
	 */
	#notFoundPath
	/**
	 * Whether HTML output should be minified.
	 * @type {boolean}
	 */
	#minifyHtml = false
	/**
	 * The base URL to use when generating sitemap.xml. If null, no sitemap is generated.
	 * @type {string | null}
	 */
	#sitemapBaseUrl = null
	/**
	 * The URL-style path (starts with `/`) at which to write sitemap.xml. Defaults to `/sitemap.xml`.
	 * @type {string | null}
	 */
	#sitemapPath = null
	/**
	 * URL-style paths registered through redirect(); excluded from the sitemap.
	 * @type {Set<string>}
	 */
	// FIX #8: redirect() registers through page(), so the sitemap needs an
	// explicit record to tell redirect pages apart from real pages.
	#redirectPaths = new Set()
	/**
	 * @type {Map<string, Component<void, void>>}
	 */
	#pageMapping = new Map()
	/**
	 * @type {Map<string, string>}
	 */
	#staticDirMappings = new Map()
	/**
	 * @type {Map<string, string>}
	 */
	#staticFileMappings = new Map()
	/**
	 * @type {ClientManager}
	 */
	#clientManager
	/**
	 * The timestamp when the site was last reloaded.
	 * @type {number}
	 */
	#lastReload = -1
	/* ---- New feature state ------------------------------------------- */
	/** @type {string} URL prefix for subdirectory deployments (#26). */
	#base = ''
	/** @type {string | null} Absolute origin for canonical/feeds (#30). */
	#baseUrl = null
	/** @type {Map<string, any>} Per-page sitemap/SEO metadata (#31). */
	#pageMeta = new Map()
	/** @type {Map<string, any>} Dynamic page registrations (#6). */
	#dynamicPages = new Map()
	/** @type {Array<() => any[] | Promise<any[]>>} getStaticPaths providers (#6). */
	#staticPathsProviders = []
	/** @type {Map<string, ContentEntry[]>} Named content collections (#5). */
	#collections = new Map()
	/** @type {any} Markdown renderer configuration. */
	#markdownOptions = {}
	/** @type {any} Shared content collection options. */
	#contentOptions = {}
	/** @type {any} Image pipeline options (#9). */
	#imageOptions = null
	/** @type {Map<string, Array<(content: string, ctx: any) => any>>} Asset transforms (#2). */
	#transformHooks = new Map()
	/** @type {Map<string, StaticOptions>} */
	#staticFileOptions = new Map()
	/** @type {Map<string, StaticOptions>} */
	#staticDirOptions = new Map()
	/** @type {Map<string, string>} original URL -> fingerprinted URL (#1). */
	#assetManifest = new Map()
	/** @type {Map<string, any>} Final URL -> asset record (#1/#2). */
	#assets = new Map()
	/** @type {any[]} Responsive image variants to generate (#9). */
	#imageVariants = []
	/** @type {any | null} OG image options (#10). */
	#ogImageOptions = null
	/** @type {Map<string, Buffer>} og URL -> generated SVG/PNG content. */
	#ogImages = new Map()
	/** @type {any[]} Feed registrations (#8). */
	#feeds = []
	/** @type {any | null} robots.txt options (#8). */
	#robotsOptions = null
	/** @type {any | null} Deploy adapter config (#11). */
	#adapter = null
	/** @type {Map<string, { to: string, status: number }>} Redirect records (#12). */
	#redirects = new Map()
	/** @type {Set<string>} Generated (non-page) paths excluded from sitemaps. */
	#generatedPaths = new Set()
	/** @type {any | null} i18n configuration (#32). */
	#i18nOptions = null
	/** @type {'dynamic' | 'static'} Client loader strategy (#18). */
	#loaderStrategy = 'dynamic'
	/** @type {boolean} Canonical absolute module imports (#19). */
	#absoluteImports = false
	/** @type {boolean} Whether CSP nonces are enabled (#36). */
	#cspEnabled = false
	/** @type {string} Nonce for the page currently being rendered (#36). */
	#currentNonce = ''
	/** @type {Plugin[]} Registered plugins (#25). */
	#plugins = []
	/** @type {BuildOptions} Default build options (#3/#23/#38). */
	#buildOptions = {}
	/** @type {Map<string, Set<string>>} Page -> module fingerprints (#23). */
	#pageDeps = new Map()
	/** @type {string | null} Page currently being rendered. */
	#currentPagePath = null
	/** @type {string | null} Last dev worker error (#15). */
	#devError = null
	/** @type {string[]} Dev accessibility warnings (#33). */
	#devWarnings = []
	/** @type {Set<any>} SSE clients (#15). */
	#sseClients = new Set()
	/** @type {Map<string, { key: string, html: string }>} Dev render cache (#17). */
	#devRenderCache = new Map()
	/** @type {Map<string, string>} Fully rendered pages received from a worker. */
	#preRenderedContent = new Map()
	/** @type {any | null} Last build statistics (#38). */
	#lastStats = null
	/** @type {any | null} Persistent incremental build cache (#23). */
	#buildCache = null
	/** @type {any | null} The config object passed to the constructor. */
	#config = null
	/** @type {Array<{ close: () => void }>} Active file watchers (#16/#28). */
	#watchers = []
	/** @type {((children: RenderFragments, ctx: PageContext) => RenderFragments) | null} Global layout (#7). */
	#layoutFn = null
	// REFACTOR: Example below uses the canonical `wunphile` name.
	/**
	 * Preloads a behavior module.
	 * The loading is done asynchronously, similarly to using an HTML `<link rel="modulepreload">` tag.
	 * Calling this function will cause a behavior module to be included in the generated site, regardless of whether it is used in any pages.
	 *
	 * @example
	 * ```js
	 * wunphile.preloadBehaviorModule(import('./client/behavior/Greeting.js'))
	 * ```
	 * @param {Promise<{ default: BehaviorModule }>} promise The promise from the `import()` call for the behavior module
	 */
	preloadBehaviorModule(promise) {
		this.#clientManager.loadBehaviorModule(promise)
	}
	// REFACTOR: Constructor example uses the canonical `wunphile` name.
	/**
	 * Creates a new Wunphile instance.
	 *
	 * @example
	 * ```js
	 * import { Wunphile } from 'wunphile'
	 * import { IndexPage } from './components/Greeting.js'
	 *
	 * const wunphile = new Wunphile(import.meta.url)
	 *
	 * wunphile.page('/index.html', IndexPage)
	 *
	 * await wunphile.cli()
	 * ```
	 *
	 * @param {string} importMetaUrl The `import.meta.url` of the program main module.
	 * @param {string | WunphileConfig} [clientDir='./src/client'] The client directory, or a config object from {@link defineConfig} (#26).
	 *
	 * Used to resolve the root path and for identifying the main module for hot reloading.
	 */
	constructor(importMetaUrl, clientDir = './src/client') {
		const config =
			typeof clientDir === 'object' && clientDir !== null ? clientDir : null
		const clientDirPath =
			config == null ? /** @type {string} */ (clientDir) : config.clientDir ?? './src/client'
		const mainModulePath = fileURLToPath(importMetaUrl)
		// FIX #10: Supply the project root resolver; #rootPath is assigned
		// just below, so a lazy getter is used instead of a snapshot.
		this.#clientManager = new ClientManager(
			this,
			pathUtil.join(pathUtil.dirname(mainModulePath), clientDirPath),
			() => this.#rootPath,
		)
		if (isMainThread) {
			// Resolve paths. WUNPHILE_* env aliases take precedence (#26).
			this.#mainModulePath = mainModulePath
			this.#rootPath = pathUtil.resolve(
				readEnv(ROOT_PATH_ENV_VAR) ||
					pathUtil.dirname(fileURLToPath(importMetaUrl)),
			)
			this.#outputPath = pathUtil.resolve(
				readEnv(OUTPUT_PATH_ENV_VAR) ||
					pathUtil.join(this.#rootPath, './dist'),
			)
			// ==================================================================
			// BUG 1 FIX
			// ==================================================================
			// The not-found path is a URL path (e.g. `/404.html`), not a
			// filesystem path. Previously it was passed through
			// `pathUtil.resolve()`, which on Windows (path.win32) prepends a
			// drive letter (`D:\404.html`), causing the `startsWith('/')`
			// guard to fail and making the entire library unusable on Windows.
			//
			// We now validate the raw input BEFORE any path manipulation, and
			// store it in POSIX-normalized form. No filesystem resolution.
			const nfRaw = readEnv(NOT_FOUND_PATH_ENV_VAR) || '/404.html'
			if (!nfRaw.startsWith('/')) {
				throw new Error(
					'The not found page must start with a forward slash.',
				)
			}
			this.#notFoundPath = toPosixPath(nfRaw)
		} else {
			// Use paths in worker data.
			this.#mainModulePath = ''
			this.#rootPath = workerData.rootPath
			this.#outputPath = workerData.outputPath
			this.#notFoundPath = workerData.notFoundPath
		}
		if (config != null) {
			this.#config = config
			this.applyConfig(config)
		}
	}
	/**
	 * Applies a single config object to this instance. Called by the
	 * constructor and usable directly for `defineConfig()` (#26).
	 * @param {WunphileConfig} config
	 * @returns {Wunphile} This
	 */
	applyConfig(config) {
		if (config == null) {
			return this
		}
		if (isMainThread) {
			if (config.root) {
				this.#rootPath = pathUtil.resolve(config.root)
			}
			if (config.outDir) {
				this.#outputPath = pathUtil.resolve(
					this.#rootPath,
					config.outDir,
				)
			}
			if (config.notFoundPath) {
				this.overrideNotFoundPath(config.notFoundPath)
			}
		}
		if (config.clientDir) {
			this.#clientManager.rootPath = pathUtil.resolve(
				this.#rootPath,
				config.clientDir,
			)
		}
		if (config.base != null) {
			this.#base = config.base.replace(/\/+$/, '')
		}
		if (config.baseUrl != null) {
			this.#baseUrl = config.baseUrl.replace(/\/+$/, '')
		}
		if (config.minify != null) {
			this.#minifyHtml = Boolean(config.minify)
		}
		if (config.sitemap != null) {
			if (typeof config.sitemap === 'string') {
				this.sitemap(config.sitemap)
			} else {
				this.sitemap(config.sitemap.baseUrl, config.sitemap.path)
			}
		}
		if (config.markdown != null) {
			this.#markdownOptions = config.markdown
		}
		if (config.content != null) {
			this.#contentOptions = config.content
		}
		if (config.image != null) {
			this.#imageOptions = config.image
		}
		if (config.i18n != null) {
			this.i18n(config.i18n)
		}
		if (config.adapter != null) {
			this.adapter(config.adapter)
		}
		if (config.feed != null) {
			for (const feed of Array.isArray(config.feed) ? config.feed : [config.feed]) {
				this.feed(feed)
			}
		}
		if (config.robots != null) {
			this.robotsTxt(config.robots)
		}
		if (config.ogImage != null) {
			this.ogImage(config.ogImage)
		}
		if (config.loader != null) {
			this.#loaderStrategy = /** @type {'dynamic' | 'static'} */ (
				config.loader
			)
		}
		if (config.csp != null) {
			this.#cspEnabled = Boolean(config.csp)
		}
		if (config.absoluteImports != null) {
			this.absoluteImports(config.absoluteImports)
		}
		if (config.build != null) {
			this.#buildOptions = { ...this.#buildOptions, ...config.build }
		}
		if (config.plugins != null) {
			this.use(...config.plugins)
		}
		// Content collections declared in config (#5).
		if (this.#contentOptions.collections != null) {
			for (const [name, opts] of Object.entries(this.#contentOptions.collections)) {
				this.collection(name, /** @type {any} */ (opts))
			}
		}
		return this
	}
	/* ==================================================================
	 * Asset pipeline internals (#1, #2, #3)
	 * ================================================================ */
	/** @returns {Promise<any[]>} All source assets, deduplicated by URL. */
	async #collectAssetRecords() {
		/** @type {Map<string, any>} */
		const records = new Map()
		for (const [mount, dir] of this.#staticDirMappings) {
			const dirPath = this.toProjectPath(dir)
			const prefix = mount.replace(/\/+$/, '')
			for (const rel of await listFilesRecursive(dirPath)) {
				const url = normalizeUrlPath(prefix + '/' + rel)
				records.set(url, {
					url,
					sourcePath: pathUtil.join(dirPath, rel),
					options: this.#staticDirOptions.get(mount) ?? {},
				})
			}
		}
		for (const [url, file] of this.#staticFileMappings) {
			records.set(normalizeUrlPath(url), {
				url: normalizeUrlPath(url),
				sourcePath: this.toProjectPath(file),
				options: this.#staticFileOptions.get(url) ?? {},
			})
		}
		for (const variant of this.#imageVariants) {
			// Variant URLs are already content-hashed by image(), so they must
			// not be hashed a second time here.
			records.set(normalizeUrlPath('/' + variant.outUrl), {
				url: normalizeUrlPath('/' + variant.outUrl),
				sourcePath: variant.sourcePath,
				mime: variant.mime,
				options: {
					headers: {
						'Cache-Control': 'public, max-age=31536000, immutable',
					},
				},
				variant,
			})
		}
		return [...records.values()]
	}
	/**
	 * Whether an optional minifier is installed for this extension (#2).
	 * @param {string} ext
	 * @returns {boolean}
	 */
	#hasOptionalTransform(ext) {
		if (ext === 'css') {
			return Boolean(resolveOptional('lightningcss', this.#rootPath)?.transform)
		}
		if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) {
			return Boolean(resolveOptional('esbuild', this.#rootPath)?.transformSync)
		}
		return false
	}
	/**
	 * Applies an optional esbuild / lightningcss transform. Absent optional
	 * dependencies are simply skipped - Wunphile stays zero-dependency.
	 * @param {string} text
	 * @param {string} ext
	 * @param {string} url
	 * @returns {string | null}
	 */
	#applyOptionalTransform(text, ext, url) {
		try {
			if (ext === 'css') {
				const lightning = resolveOptional('lightningcss', this.#rootPath)
				if (lightning?.transform) {
					return String(
						lightning.transform({
							filename: url,
							code: Buffer.from(text),
							minify: true,
							sourceMap: false,
						}).code,
					)
				}
			}
			if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) {
				const esbuild = resolveOptional('esbuild', this.#rootPath)
				if (esbuild?.transformSync) {
					const loader = ext === 'ts' || ext === 'tsx' ? 'ts' : ext === 'jsx' ? 'jsx' : 'js'
					return String(
						esbuild.transformSync(text, {
							loader,
							minify: true,
							format: 'esm',
							target: 'es2022',
						}).code,
					)
				}
			}
		} catch (err) {
			console.warn(
				`[wunphile] optional asset transform failed for ${url}:`,
				err,
			)
		}
		return null
	}
	/**
	 * Applies registered `transformAsset` hooks, then optional transforms.
	 * @param {string} text
	 * @param {any} rec
	 * @returns {Promise<string>}
	 */
	async #transformAssetContent(text, rec) {
		let out = text
		for (const fn of this.#transformHooks.get(rec.ext) ?? []) {
			const result = await fn(out, { path: rec.url, ext: rec.ext })
			if (result != null) {
				out = Buffer.isBuffer(result) ? result.toString('utf8') : String(result)
			}
		}
		if (rec.options.transform !== false) {
			const transformed = this.#applyOptionalTransform(out, rec.ext, rec.url)
			if (transformed != null) {
				out = transformed
			}
		}
		return out
	}
	/**
	 * Rewrites `url(...)` references in CSS to fingerprinted paths (#2).
	 * @param {string} css
	 * @param {string} cssUrl
	 * @param {Map<string, string>} manifest
	 * @returns {string}
	 */
	#rewriteCssUrls(css, cssUrl, manifest) {
		return css.replace(
			/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
			(full, quote, target) => {
				if (/^(data:|https?:|\/\/|#|blob:)/i.test(target)) {
					return full
				}
				const clean = target.split('?')[0].split('#')[0]
				const resolved = clean.startsWith('/')
					? normalizeUrlPath(clean)
					: normalizeUrlPath(
							pathUtil.posix.join(pathUtil.posix.dirname(cssUrl), clean),
						)
				const hashed = manifest.get(resolved)
				if (hashed == null) {
					return full
				}
				return `url(${quote}${hashed}${quote})`
			},
		)
	}
	/**
	 * Generates an image variant with sharp, or falls back to the source.
	 * @param {any} variant
	 * @returns {Promise<Buffer>}
	 */
	async #generateImageVariant(variant) {
		const sharp = resolveOptional('sharp', this.#rootPath)
		if (sharp && variant.type === 'variant') {
			let pipeline = sharp(variant.sourcePath)
			if (variant.width) {
				pipeline = pipeline.resize({
					width: variant.width,
					withoutEnlargement: true,
				})
			}
			if (variant.format === 'webp' || variant.format === 'avif') {
				pipeline = pipeline[variant.format]({
					quality: variant.quality ?? 75,
				})
			} else if (variant.format === 'png' || variant.format === 'jpeg') {
				pipeline = pipeline[variant.format]()
			}
			return Buffer.from(await pipeline.toBuffer())
		}
		return fsSync.readFileSync(variant.sourcePath)
	}
	/**
	 * Reads, transforms and fingerprints every registered asset.
	 * Also rewrites CSS `url()` references, then recomputes CSS hashes until
	 * the manifest converges (#1/#2/#9).
	 * @returns {Promise<void>}
	 */
	async #prepareAssets() {
		const records = await this.#collectAssetRecords()
		for (const rec of records) {
			rec.ext = pathUtil.extname(rec.url).slice(1).toLowerCase()
			rec.mime = rec.mime ?? mimeForExt(rec.ext)
			rec.stat = await statOrNull(rec.sourcePath)
			rec.hashed = rec.options.hash === true
			const hooks = this.#transformHooks.get(rec.ext)?.length ?? 0
			const isCss = rec.ext === 'css'
			const needsRead =
				rec.variant != null ||
				rec.hashed ||
				isCss ||
				hooks > 0 ||
				rec.options.transform === true ||
				(rec.options.transform !== false && this.#hasOptionalTransform(rec.ext))
			/** @type {Buffer | null} */
			let content = null
			if (rec.variant != null) {
				content = await this.#generateImageVariant(rec.variant)
			} else if (needsRead && rec.stat?.isFile()) {
				const source = await fs.readFile(rec.sourcePath)
				rec.rawSize = source.length
				content = Buffer.from(
					await this.#transformAssetContent(source.toString('utf8'), rec),
				)
			} else {
				rec.rawSize = rec.stat?.size ?? 0
			}
			rec.content = content
			rec.baseContent = content == null ? null : content.toString('utf8')
			rec.size = content?.length ?? rec.stat?.size ?? 0
			rec.hash = content != null ? contentHash(content) : contentHash(rec.url + String(rec.stat?.mtimeMs ?? 0))
		}
		/** @type {Map<string, string>} */
		const manifest = new Map()
		for (const rec of records) {
			if (rec.hashed) {
				manifest.set(rec.url, hashPath(rec.url, rec.hash))
			}
		}
		const cssRecords = records.filter(
			(rec) => rec.ext === 'css' && rec.baseContent != null,
		)
		for (let pass = 0; pass < 3; pass++) {
			let changed = false
			for (const rec of cssRecords) {
				const rewritten = this.#rewriteCssUrls(
					rec.baseContent,
					rec.url,
					manifest,
				)
				const buf = Buffer.from(rewritten)
				const nextHash = contentHash(buf)
				rec.content = buf
				rec.size = buf.length
				if (nextHash !== rec.hash) {
					changed = true
					rec.hash = nextHash
				}
				if (rec.hashed) {
					manifest.set(rec.url, hashPath(rec.url, nextHash))
				}
			}
			if (!changed) {
				break
			}
		}
		/** @type {Map<string, any>} */
		const assets = new Map()
		for (const rec of records) {
			const finalUrl = rec.hashed
				? /** @type {string} */ (manifest.get(rec.url))
				: rec.url
			assets.set(finalUrl, {
				url: rec.url,
				finalUrl,
				sourcePath: rec.sourcePath,
				content: rec.content,
				stat: rec.stat,
				mime: rec.mime,
				rawSize: rec.rawSize ?? 0,
				size: rec.size ?? 0,
				hashed: rec.hashed,
				headers: rec.options.headers ?? {},
			})
			for (const plugin of this.#plugins) {
				if (typeof plugin.onAsset === 'function') {
					await plugin.onAsset(assets.get(finalUrl))
				}
			}
		}
		this.#assetManifest = manifest
		this.#assets = assets
	}
	/**
	 * Validates that a URL path stays inside the output directory (#35).
	 * @param {string} url
	 * @returns {string} Absolute filesystem path
	 */
	#safeOutputPath(url) {
		const dest = this.toOutputPath(url)
		const rel = pathUtil.relative(this.#outputPath, dest)
		if (
			rel === '..' ||
			rel.startsWith('..' + pathUtil.sep) ||
			pathUtil.isAbsolute(rel)
		) {
			throw new Error(`Refusing to write outside the output directory: ${url}`)
		}
		return dest
	}
	/** @returns {Promise<void>} Writes all prepared assets. */
	async #writeAssets() {
		for (const rec of this.#assets.values()) {
			if (rec.content == null && !rec.stat?.isFile()) {
				console.warn(
					`[wunphile] skipping missing static asset "${rec.url}" (${rec.sourcePath})`,
				)
				continue
			}
			const dest = this.#safeOutputPath(rec.finalUrl)
			await fs.mkdir(pathUtil.dirname(dest), { recursive: true })
			if (rec.content != null) {
				await fs.writeFile(dest, rec.content)
			} else if (rec.sourcePath != null) {
				await fs.copyFile(rec.sourcePath, dest)
			}
		}
	}
	/* ==================================================================
	 * Dynamic routes / i18n expansion (#6, #32)
	 * ================================================================ */
	/**
	 * Replaces `[param]` and `[...rest]` segments in a path pattern.
	 * @param {string} pattern
	 * @param {Record<string, any>} params
	 * @returns {string}
	 */
	#fillPathParams(pattern, params) {
		return pattern.replace(/\[([^\]]+)\]/g, (_, key) => {
			const name = key.startsWith('...') ? key.slice(3) : key
			const value = params[name] ?? params.slug ?? ''
			return encodeURIComponent(
				String(Array.isArray(value) ? value.join('/') : value),
			)
		})
	}
	/**
	 * Resolves getStaticPaths values for a dynamic route.
	 * @param {any} options
	 * @returns {Promise<Record<string, any>[]>}
	 */
	async #resolveParamSets(options) {
		let source = options.paths ?? options.getStaticPaths
		if (typeof source === 'string') {
			source = this.#collections.get(source) ?? []
		}
		/** @type {any[]} */
		let raw = []
		if (typeof source === 'function') {
			raw = await source({
				collections: this.collections(),
				wunphile: this,
			})
		} else if (Array.isArray(source)) {
			raw = source
		} else {
			for (const provider of this.#staticPathsProviders) {
				raw.push(...(await provider()))
			}
			if (raw.length === 0) {
				for (const entries of this.#collections.values()) {
					raw.push(...entries)
				}
			}
		}
		return (raw ?? []).map((item) => {
			if (typeof item === 'string') {
				return { slug: item }
			}
			if (item?.params && typeof item.params === 'object') {
				return { ...item.params, __entry: item }
			}
			return { ...item, __entry: item }
		})
	}
	/**
	 * Locale prefixes applied to expanded routes.
	 * @returns {{ locale: string | null, prefix: string }[]}
	 */
	#localeVariants() {
		const i18n = this.#i18nOptions
		if (i18n == null) {
			return [{ locale: null, prefix: '' }]
		}
		const locales = /** @type {string[]} */ (i18n.locales)
		return locales.map((locale) => ({
			locale,
			prefix:
				locale === i18n.defaultLocale && !i18n.prefixDefault
					? ''
					: `/${locale}`,
		}))
	}
	/**
	 * Expands all registered dynamic pages into concrete page mappings (#6).
	 * @returns {Promise<void>}
	 */
	async #expandDynamicPages() {
		for (const [pattern, reg] of this.#dynamicPages) {
			const paramSets = await this.#resolveParamSets(reg.options)
			if (paramSets.length === 0) {
				console.warn(
					`[wunphile] dynamic route "${pattern}" produced no paths. Register getStaticPaths() or a content collection.`,
				)
				continue
			}
			for (const params of paramSets) {
				const filled = this.#fillPathParams(pattern, params)
				for (const variant of this.#localeVariants()) {
					const dest = normalizeUrlPath(variant.prefix + filled)
					const ctx = this.#makeContext(
						dest,
						params,
						variant.locale,
						params.__entry ?? null,
					)
					this.#pageMapping.set(dest, () => reg.component(ctx))
					this.#pageMeta.set(dest, {
						...reg.options.meta,
						cacheKey: JSON.stringify({ pattern, params, locale: variant.locale }),
						lastmod:
							reg.options.meta?.lastmod ??
							(params.__entry?.mtime != null
								? new Date(params.__entry.mtime).toISOString().slice(0, 10)
								: undefined),
					})
				}
			}
		}
	}
	/**
	 * Synchronous expansion used by the hot-reload worker.
	 * @param {string} path
	 * @param {any} options
	 * @returns {{ dest: string, ctx: PageContext }[]}
	 */
	#expandPagePathsSync(path, options) {
		if (!/\[[^\]]+\]/.test(path) && this.#i18nOptions == null) {
			return [{ dest: path, ctx: this.#makeContext(path, {}, null, null) }]
		}
		/** @type {any[]} */
		let raw = []
		const isDynamic = /\[[^\]]+\]/.test(path)
		if (Array.isArray(options.paths)) {
			raw = options.paths
		} else if (typeof options.paths === 'string') {
			raw = this.#collections.get(options.paths) ?? []
		} else if (isDynamic) {
			for (const provider of this.#staticPathsProviders) {
				const result = provider()
				if (Array.isArray(result)) {
					raw.push(...result)
				}
			}
			if (raw.length === 0) {
				for (const entries of this.#collections.values()) {
					raw.push(...entries)
				}
			}
		} else {
			// Non-dynamic pages still need one expansion per locale.
			raw = [{}]
		}
		const paramSets = raw.map((item) =>
			typeof item === 'string' ? { slug: item } : { ...item, __entry: item },
		)
		/** @type {{ dest: string, ctx: PageContext }[]} */
		const out = []
		for (const params of paramSets) {
			const filled = this.#fillPathParams(path, params)
			for (const variant of this.#localeVariants()) {
				const dest = normalizeUrlPath(variant.prefix + filled)
				out.push({
					dest,
					ctx: this.#makeContext(dest, params, variant.locale, params.__entry ?? null),
				})
			}
		}
		return out.length > 0
			? out
			: [{ dest: path, ctx: this.#makeContext(path, {}, null, null) }]
	}
	/* ==================================================================
	 * Rendering (#7, #18, #20, #21, #30, #36)
	 * ================================================================ */
	/**
	 * Renders one page component into its final string.
	 * @param {string} dest
	 * @param {Component<any, any>} component
	 * @param {PageContext} ctx
	 * @returns {Promise<string>}
	 */
	async #renderPage(dest, component, ctx) {
		this.#currentPagePath = dest
		let fragments = await component(ctx)
		if (fragments == null) {
			fragments = []
		}
		if (!Array.isArray(fragments)) {
			fragments = RenderFragment.from(fragments)
		}
		if (this.#layoutFn != null && isHtmlPath(dest)) {
			fragments = this.#layoutFn(fragments, ctx) ?? fragments
		}
		return this.#renderToHtmlAsync(fragments, { path: dest, ctx })
	}
	/**
	 * Writes one page, with a boundary check (#35).
	 * @param {string} dest
	 * @param {string} content
	 * @returns {Promise<void>}
	 */
	async #writePage(dest, content) {
		const outPath = this.#safeOutputPath(dest)
		await fs.mkdir(pathUtil.dirname(outPath), { recursive: true })
		await fs.writeFile(outPath, content)
	}
	/* ==================================================================
	 * Plugins / config (#25, #26)
	 * ================================================================ */
	/**
	 * Registers plugins. A plugin may implement `onPageRender(html, path)`,
	 * `onAsset(asset)`, `onBuildEnd(manifest)` and `onDevRequest(req, res)`.
	 * @param {...(Plugin | Plugin[] | null | undefined)} plugins
	 * @returns {Wunphile} This
	 */
	use(...plugins) {
		for (const group of plugins) {
			if (group == null) {
				continue
			}
			for (const plugin of Array.isArray(group) ? group : [group]) {
				if (plugin) {
					this.#plugins.push(plugin)
				}
			}
		}
		return this
	}
	/** Alias for {@link use}. @param {...Plugin} plugins @returns {Wunphile} */
	plugin(...plugins) {
		return this.use(...plugins)
	}
	/**
	 * Registers a transform for an asset extension (#2).
	 * `fn` may be sync or async and receives `(content, { path, ext })`.
	 * It runs before optional esbuild/lightningcss transforms.
	 * @param {string} ext Extension, with or without leading `.`
	 * @param {(content: string, ctx: { path: string, ext: string }) => string | Buffer | Promise<string | Buffer>} fn
	 * @returns {Wunphile} This
	 */
	transformAsset(ext, fn) {
		const key = ext.replace(/^\./, '').toLowerCase()
		if (!this.#transformHooks.has(key)) {
			this.#transformHooks.set(key, [])
		}
		/** @type {any[]} */ (this.#transformHooks.get(key)).push(fn)
		return this
	}
	/* ==================================================================
	 * Content layer (#5, #6, #7)
	 * ================================================================ */
	/**
	 * Sorts content entries by `field:asc|desc`.
	 * @param {ContentEntry[]} entries
	 * @param {string | ((a: ContentEntry, b: ContentEntry) => number) | undefined} sort
	 * @returns {ContentEntry[]}
	 */
	#sortEntries(entries, sort) {
		if (typeof sort === 'function') {
			return [...entries].sort(sort)
		}
		if (!sort) {
			return entries
		}
		const [field, direction] = String(sort).split(':')
		const sign = direction === 'desc' ? -1 : 1
		return [...entries].sort((a, b) => {
			const av = a.data[field] ?? /** @type {any} */ (a)[field]
			const bv = b.data[field] ?? /** @type {any} */ (b)[field]
			const an = typeof av === 'number' ? av : Date.parse(String(av ?? ''))
			const bn = typeof bv === 'number' ? bv : Date.parse(String(bv ?? ''))
			if (!Number.isNaN(an) && !Number.isNaN(bn)) {
				return (an - bn) * sign
			}
			return String(av ?? '').localeCompare(String(bv ?? '')) * sign
		})
	}
	/**
	 * Recursively scans a directory, parses frontmatter and renders Markdown.
	 * `marked` / `markdown-it` are used when installed; otherwise a builtin
	 * renderer is used. Always synchronous so collections can be iterated
	 * directly while defining pages (#5).
	 *
	 * @param {string} dir Directory relative to the project root (or absolute)
	 * @param {{ pattern?: string, name?: string, sort?: string | Function, slug?: (entry: any) => string, renderer?: string, limit?: number }} [options]
	 * @returns {ContentEntry[]}
	 */
	contentDir(dir, options = {}) {
		const dirPath = pathUtil.isAbsolute(dir)
			? dir
			: this.toProjectPath(dir)
		const pattern = options.pattern ?? '**/*.md'
		const re = globToRegExp(pattern)
		/** @type {ContentEntry[]} */
		const entries = []
		/** @type {string[]} */
		const stack = ['']
		while (stack.length > 0) {
			const relDir = /** @type {string} */ (stack.pop())
			let dirents = []
			try {
				dirents = fsSync.readdirSync(pathUtil.join(dirPath, relDir), {
					withFileTypes: true,
				})
			} catch {
				continue
			}
			for (const dirent of dirents) {
				const rel = toPosixPath(pathUtil.join(relDir, dirent.name))
				if (dirent.isDirectory()) {
					stack.push(rel)
					continue
				}
				if (!dirent.isFile() || !re.test(rel)) {
					continue
				}
				const full = pathUtil.join(dirPath, rel)
				const raw = fsSync.readFileSync(full, 'utf8')
				const { data, body } = parseFrontmatter(raw)
				const stat = fsSync.statSync(full)
				const slug =
					typeof options.slug === 'function'
						? options.slug({ data, path: rel })
						: String(
								data.slug ??
									rel.replace(/\.[^./]+$/, '').replace(/^.*\//, ''),
							)
				const heading = /^#\s+(.+)$/m.exec(body)
				const html = renderMarkdown(body, {
					...this.#markdownOptions,
					renderer: options.renderer ?? this.#markdownOptions.renderer,
					rootPath: this.#rootPath,
				})
				/** @type {ContentEntry} */
				const entry = {
					slug,
					path: rel,
					data,
					body,
					html,
					title: String(data.title ?? (heading ? heading[1].trim() : slug)),
					description: String(data.description ?? data.summary ?? stripHtml(html).slice(0, 160)),
					date: String(data.date ?? data.published ?? stat.mtime.toISOString()),
					mtime: stat.mtimeMs,
					params: { slug },
				}
				if (data.params && typeof data.params === 'object') {
					for (const [key, value] of Object.entries(data.params)) {
						entry.params[key] = String(value)
					}
				}
				entries.push(entry)
			}
		}
		const sorted = this.#sortEntries(entries, /** @type {any} */ (options.sort))
		const limited = options.limit ? sorted.slice(0, options.limit) : sorted
		if (options.name) {
			this.#collections.set(options.name, limited)
		}
		return limited
	}
	/**
	 * Defines (or retrieves) a named content collection (#5).
	 *
	 * @example
	 * const posts = wunphile.collection('posts', { from: './content/posts', sort: 'date:desc' })
	 * wunphile.page('/index.html', () => html`<ul>${posts.map(p => html`<li>${p.title}</li>`)}</ul>`)
	 *
	 * @param {string} name
	 * @param {{ from?: string, dir?: string, pattern?: string, sort?: string | Function, slug?: Function, limit?: number }} [options]
	 * @returns {ContentEntry[]}
	 */
	collection(name, options = {}) {
		const fromConfig = this.#contentOptions.collections?.[name]
		const opts = { ...(fromConfig ?? {}), ...options }
		const dir = opts.from ?? opts.dir ?? `./content/${name}`
		const entries = this.contentDir(dir, { ...opts, name })
		if (!isMainThread && typeof parentPort?.postMessage === 'function') {
			parentPort.postMessage({
				type: 'collection',
				name,
				entries: entries.map((entry) => ({ ...entry })),
			})
		}
		return entries
	}
	/**
	 * Returns all registered collections keyed by name.
	 * @returns {Record<string, ContentEntry[]>}
	 */
	collections() {
		return Object.fromEntries(this.#collections)
	}
	/**
	 * Registers a `getStaticPaths()` provider for dynamic routes (#6).
	 * Providers may return an array (or a promise of one) of param objects.
	 * @param {() => any[] | Promise<any[]>} fn
	 * @returns {Wunphile} This
	 */
	getStaticPaths(fn) {
		this.#staticPathsProviders.push(fn)
		return this
	}
	/**
	 * Sets a global layout wrapper. The function receives the page's render
	 * fragments and the page context and returns new render fragments (#7).
	 * `<Head>` fragments are collected from both the page and the layout and
	 * injected into `<head>` after rendering.
	 *
	 * @param {(children: RenderFragments, ctx: PageContext) => RenderFragments} fn
	 * @returns {Wunphile} This
	 */
	layout(fn) {
		this.#layoutFn = fn
		return this
	}
	/**
	 * Enables i18n route expansion (#32). `page('/about', ...)` then emits
	 * `/about` (default locale) plus `/<locale>/about`.
	 * @param {{ locales: string[], defaultLocale?: string, prefixDefault?: boolean, urlForLocale?: (locale: string, path: string) => string }} options
	 * @returns {Wunphile} This
	 */
	i18n(options) {
		const locales = options.locales ?? ['en']
		this.#i18nOptions = {
			locales,
			defaultLocale: options.defaultLocale ?? locales[0],
			prefixDefault: Boolean(options.prefixDefault),
			urlForLocale: options.urlForLocale,
		}
		return this
	}
	/**
	 * Returns language-switch links for a URL path (#32).
	 * @param {string} path
	 * @returns {{ locale: string, href: string }[]}
	 */
	localeLinks(path) {
		const i18n = this.#i18nOptions
		if (i18n == null) {
			return []
		}
		const cleanPath = normalizeUrlPath(path)
		const locales = /** @type {string[]} */ (i18n.locales)
		return locales.map((locale) => ({
			locale,
			href:
				this.#base +
				(locale === i18n.defaultLocale && !i18n.prefixDefault
					? cleanPath
					: `/${locale}${cleanPath === '/' ? '/' : cleanPath}`),
		}))
	}
	/**
	 * Builds the page context handed to every component.
	 * @param {string} path
	 * @param {Record<string, string>} [params]
	 * @param {string | null} [locale]
	 * @param {any} [entry]
	 * @returns {PageContext}
	 */
	#makeContext(path, params = {}, locale = null, entry = null) {
		return {
			path,
			params,
			entry,
			collections: this.collections(),
			wunphile: this,
			locale,
			locales: this.#i18nOptions?.locales ?? [],
			localeLinks: this.localeLinks(path),
		}
	}
	/* ==================================================================
	 * Asset pipeline (#1, #2, #3, #9, #10)
	 * ================================================================ */
	/**
	 * Returns the fingerprinted URL for a registered asset (#1).
	 * Falls back to the original URL when the asset is not hashed.
	 * @param {string} path
	 * @returns {string}
	 */
	asset(path) {
		const clean = normalizeUrlPath(path)
		return this.#base + (this.#assetManifest.get(clean) ?? clean)
	}
	/**
	 * Returns the URL-style path prefixed with `base`.
	 * @param {string} path
	 * @returns {string}
	 */
	url(path) {
		return this.#base + normalizeUrlPath(path)
	}
	/**
	 * Returns a copy of the generated asset manifest (#1).
	 * @returns {Record<string, string>}
	 */
	manifest() {
		return Object.fromEntries(this.#assetManifest)
	}
	/**
	 * Returns asset records for the current build (used by plugins).
	 * @returns {any[]}
	 */
	assets() {
		return [...this.#assets.values()]
	}
	/**
	 * The absolute origin used for canonical/feed URLs.
	 * @returns {string}
	 */
	#effectiveBaseUrl() {
		return this.#baseUrl ?? this.#sitemapBaseUrl ?? ''
	}
	/**
	 * Returns a stable CSP nonce for injected scripts (#36).
	 * Enable with `defineConfig({ csp: true })` or `enableCsp()`.
	 * @returns {string}
	 */
	cspNonce() {
		if (this.#currentNonce === '') {
			this.#currentNonce = randomUUID()
		}
		return this.#currentNonce
	}
	/**
	 * Enables CSP nonce generation (#36).
	 * @param {boolean} [enabled=true]
	 * @returns {Wunphile} This
	 */
	enableCsp(enabled = true) {
		this.#cspEnabled = enabled
		return this
	}
	/**
	 * Routes all shared behavior-module dependencies through one canonical
	 * absolute `/_wfclient/...` URL (#19).
	 * @param {boolean} [enabled=true]
	 * @returns {Wunphile} This
	 */
	absoluteImports(enabled = true) {
		this.#absoluteImports = enabled
		this.#clientManager.setAbsoluteImports(enabled)
		return this
	}
	/** @returns {string} The `<script>` nonce attribute, or an empty string. */
	#nonceAttr() {
		return this.#cspEnabled
			? ` nonce="${escapeAttribute(this.cspNonce())}"`
			: ''
	}
	/**
	 * Internal hook used by ClientManager to record module dependencies (#23).
	 * @param {string} path
	 */
	noteModuleDependency(path) {
		const current = this.#currentPagePath
		if (current == null) {
			return
		}
		if (!this.#pageDeps.has(current)) {
			this.#pageDeps.set(current, new Set())
		}
		/** @type {Set<string>} */ (this.#pageDeps.get(current)).add(path)
	}
	/**
	 * Resolves a source file for the image pipeline.
	 * @param {string} src
	 * @returns {string}
	 */
	#resolveImageSource(src) {
		if (src.startsWith('/')) {
			for (const [mount, dir] of this.#staticDirMappings) {
				const prefix = mount.replace(/\/+$/, '')
				if (src === prefix || src.startsWith(prefix + '/')) {
					return pathUtil.join(
						this.toProjectPath(dir),
						src.slice(prefix.length).replace(/^\/+/, ''),
					)
				}
			}
			return this.toProjectPath(src)
		}
		return pathUtil.resolve(this.#rootPath, src)
	}
	/**
	 * Generates a `<picture>`/`<img>` fragment with responsive variants,
	 * content-hashed filenames and width/height to avoid CLS (#9).
	 *
	 * Uses `sharp` when installed; otherwise it fingerprints the original
	 * file and infers dimensions from its header. Returns `RenderFragments`.
	 *
	 * @param {string} src
	 * @param {{ widths?: number[], formats?: string[], alt?: string, sizes?: string, loading?: string, quality?: number, hash?: boolean }} [options]
	 * @returns {RenderFragments}
	 */
	image(src, options = {}) {
		const opts = { ...(this.#imageOptions ?? {}), ...options }
		const widths = opts.widths ?? [400, 800, 1600]
		const formats = opts.formats ?? ['avif', 'webp']
		const sourcePath = this.#resolveImageSource(src)
		let buffer
		try {
			buffer = fsSync.readFileSync(sourcePath)
		} catch (err) {
			throw new Error(
				`Unable to read image "${src}" (resolved to "${sourcePath}"): ${err}`,
			)
		}
		const sourceHash = contentHash(buffer)
		const dims = readImageSize(buffer) ?? { width: 0, height: 0 }
		const ext = pathUtil.extname(src).slice(1).toLowerCase()
		const baseName = src.replace(/^\/+/, '')
		const sharp = resolveOptional('sharp', this.#rootPath)
		const alt = escapeAttribute(opts.alt ?? '')
		const sizes = opts.sizes ? ` sizes="${escapeAttribute(opts.sizes)}"` : ''
		const dimAttr =
			dims.width && dims.height
				? ` width="${dims.width}" height="${dims.height}"`
				: ''
		const loading = ` loading="${escapeAttribute(opts.loading ?? 'lazy')}" decoding="async"`
		if (!sharp) {
			const outUrl = hashPath(baseName, sourceHash)
			this.#imageVariants.push({
				type: 'original',
				outUrl,
				sourcePath,
				mime: mimeForExt(ext),
			})
			return html(
				`<img src="${escapeAttribute('/' + outUrl)}"${dimAttr} alt="${alt}"${loading} />`,
			)
		}
		/** @type {{ format: string, candidates: { url: string, width: number }[] }[]} */
		const groups = []
		for (const format of formats) {
			/** @type {{ url: string, width: number }[]} */
			const candidates = []
			for (const width of widths) {
				const variantHash = contentHash(
					`${sourceHash}|${width}|${format}|${opts.quality ?? ''}`,
				)
				const outUrl = hashPath(
					`${baseName.replace(/\.[^./]+$/, '')}.${width}w.${format}`,
					variantHash,
				) + `.${format}`
				this.#imageVariants.push({
					type: 'variant',
					outUrl,
					sourcePath,
					width,
					format,
					quality: opts.quality,
					mime: mimeForExt(format),
				})
				candidates.push({ url: '/' + outUrl, width })
			}
			groups.push({ format, candidates })
		}
		const sources = groups
			.map(
				(group) =>
					`<source type="${escapeAttribute(mimeForExt(group.format))}" srcset="${escapeAttribute(group.candidates.map((c) => `${c.url} ${c.width}w`).join(', '))}"${sizes} />`,
			)
			.join('\n')
		const fallback = groups[groups.length - 1]?.candidates[0]?.url ?? '/' + hashPath(baseName, sourceHash)
		const lastGroup = groups[groups.length - 1]
		const srcset = lastGroup
			? escapeAttribute(
					lastGroup.candidates.map((c) => `${c.url} ${c.width}w`).join(', '),
				)
			: ''
		return html(
			`<picture>\n${sources}\n<img src="${escapeAttribute(fallback)}"${srcset ? ` srcset="${srcset}"` : ''}${sizes}${dimAttr} alt="${alt}"${loading} />\n</picture>`,
		)
	}
	/**
	 * Enables automatic OG image generation (#10).
	 * Uses `@resvg/resvg-js` for PNG output when available; otherwise a pure
	 * SVG card (no native dependency) is written and linked.
	 * @param {{ template?: string | ((ctx: { title: string, path: string }) => string), width?: number, height?: number, background?: string, color?: string, prefix?: string }} [options]
	 * @returns {Wunphile} This
	 */
	ogImage(options = {}) {
		const resvg = resolveOptional('@resvg/resvg-js', this.#rootPath)
		this.#ogImageOptions = {
			width: 1200,
			height: 630,
			background: '#0f172a',
			color: '#f8fafc',
			prefix: '/og',
			...options,
			resvg: resvg ?? null,
			format: resvg ? 'png' : 'svg',
		}
		return this
	}
	/**
	 * Generates the OG image SVG for a page title.
	 * @param {string} title
	 * @param {any} opts
	 * @returns {string}
	 */
	#ogSvg(title, opts) {
		if (typeof opts.template === 'function') {
			return opts.template({ title, path: this.#currentPagePath ?? '' })
		}
		const escaped = sanitizeHtml(stripHtml(title).slice(0, 120))
		const lines = escaped.length > 42
			? [
					escaped.slice(0, 42),
					escaped.slice(42, 84),
				]
			: [escaped]
		if (typeof opts.template === 'string') {
			return opts.template.replaceAll('{title}', escaped)
		}
		const text = lines
			.map(
				(line, i) =>
					`<text x="72" y="${260 + i * 84}" font-family="sans-serif" font-size="64" font-weight="700" fill="${escapeAttribute(opts.color)}">${line}</text>`,
			)
			.join('\n')
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}" viewBox="0 0 ${opts.width} ${opts.height}"><rect width="100%" height="100%" fill="${escapeAttribute(opts.background)}"/>${text}<text x="72" y="${opts.height - 72}" font-family="sans-serif" font-size="28" fill="${escapeAttribute(opts.color)}" opacity="0.65">${escapeAttribute(this.#effectiveBaseUrl())}</text></svg>`
	}
	/**
	 * Registers (and returns) the OG image URL for a page.
	 * @param {string} path
	 * @param {Record<string, any>} head
	 * @returns {string | null}
	 */
	#computeOgImage(path, head) {
		const opts = this.#ogImageOptions
		if (opts == null) {
			return null
		}
		const slug =
			path
				.replace(/^\/+/, '')
				.replace(/\.[^./]+$/, '')
				.replace(/[^a-zA-Z0-9_-]+/g, '-')
				.replace(/^-+|-+$/g, '') || 'index'
		const ext = opts.format
		const url = `${opts.prefix}/${slug}.${ext}`
		const svg = this.#ogSvg(String(head.title ?? head.og?.title ?? slug), opts)
		if (ext === 'png' && opts.resvg) {
			try {
				const Resvg = opts.resvg.Resvg ?? opts.resvg
				const png = new Resvg(svg, { fitTo: { mode: 'width', value: opts.width } })
					.render()
					.asPng()
				this.#ogImages.set(url, Buffer.from(png))
			} catch {
				// Fall back to pure SVG if resvg fails at runtime.
				this.#ogImageOptions = { ...opts, format: 'svg', resvg: null }
				return this.#computeOgImage(path, head)
			}
		} else {
			this.#ogImages.set(url, Buffer.from(svg, 'utf8'))
		}
		this.#generatedPaths.add(url)
		return this.#effectiveBaseUrl() + this.url(url)
	}
	/* ==================================================================
	 * Feeds, robots, adapters (#8, #11)
	 * ================================================================ */
	/**
	 * Registers an RSS, Atom or JSON Feed generator (#8).
	 * @param {{ collection?: string, path?: string, format?: 'rss' | 'atom' | 'json', baseUrl?: string, title?: string, description?: string, language?: string, author?: string, entries?: any[], url?: Function, limit?: number }} options
	 * @returns {Wunphile} This
	 */
	feed(options = {}) {
		/** @type {any} */
		const opts = {
			collection: 'posts',
			path: '/feed.xml',
			format: 'rss',
			...options,
		}
		this.#feeds.push(opts)
		this.#generatedPaths.add(opts.path)
		this.page(opts.path, () =>
			html(
				buildFeed({
					...opts,
					baseUrl: opts.baseUrl ?? this.#effectiveBaseUrl(),
					entries: this.#feedEntries(opts),
				}),
			),
		)
		return this
	}
	/**
	 * Resolves the entries for a feed.
	 * @param {any} opts
	 * @returns {any[]}
	 */
	#feedEntries(opts) {
		const entries =
			opts.entries ?? this.#collections.get(opts.collection ?? 'posts') ?? []
		return opts.limit ? entries.slice(0, opts.limit) : entries
	}
	/**
	 * Registers a `robots.txt` generator (#8).
	 * @param {{ sitemap?: boolean | string, disallow?: string[], allow?: string[], userAgent?: string, host?: string, extra?: string[], path?: string }} [options]
	 * @returns {Wunphile} This
	 */
	robotsTxt(options = {}) {
		const opts = { sitemap: true, disallow: [], ...options }
		const path = opts.path ?? '/robots.txt'
		this.#robotsOptions = opts
		this.#generatedPaths.add(path)
		this.page(path, () =>
			html(
				buildRobots({
					...opts,
					sitemap:
						opts.sitemap === true
							? this.#effectiveBaseUrl() + this.url(this.#sitemapPath ?? '/sitemap.xml')
							: opts.sitemap,
					host: opts.host ?? this.#effectiveBaseUrl(),
				}),
			),
		)
		return this
	}
	/**
	 * Selects a deployment adapter (#11). At build time Wunphile emits
	 * `_redirects`/`_headers`, `vercel.json`, `_routes.json` or `.nojekyll`.
	 * @param {'netlify' | 'vercel' | 'cloudflare-pages' | 'github-pages' | { name: string, [key: string]: any }} name
	 * @returns {Wunphile} This
	 */
	adapter(name) {
		this.#adapter =
			typeof name === 'string' ? { name } : { ...name }
		return this
	}
	/**
	 * Returns the last build statistics object (#38).
	 * @returns {any | null}
	 */
	stats() {
		return this.#lastStats
	}
	/**
	 * Enables or disables HTML minification for the build output.
	 * When enabled, HTML is minified by collapsing whitespace between tags
	 * and removing HTML comments (excluding conditional comments and
	 * `wf-behavior:` hydration comments), then trimming the result.
	 *
	 * FIX #13: This is a conservative minifier. Text nodes, including runs of
	 * repeated spaces, are left untouched; <pre>, <textarea>, <script> and
	 * <style> contents are preserved verbatim.
	 *
	 * NEW FEATURE.
	 *
	 * @param {boolean} [enabled=true] Whether to enable HTML minification
	 * @returns {Wunphile} This
	 */
	minifyHtml(enabled = true) {
		if (!isMainThread) {
			return this
		}
		this.#minifyHtml = enabled
		return this
	}
	/**
	 * Enables generation of a `sitemap.xml` file at the specified path during build.
	 * The sitemap lists all registered pages (excluding client mounts, redirects, and the not-found page).
	 *
	 * NEW FEATURE.
	 *
	 * @param {string} baseUrl The base URL of the deployed site, e.g. `https://example.com`. Trailing slash is optional.
	 * @param {string} [path='/sitemap.xml'] The URL path at which to write the sitemap
	 * @returns {Wunphile} This
	 */
	sitemap(baseUrl, path = '/sitemap.xml') {
		if (!isMainThread) {
			return this
		}
		if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
			throw new Error(
				`Sitemap base URL must start with "http://" or "https://", but got "${baseUrl}"`,
			)
		}
		if (!path.startsWith('/')) {
			throw new Error(
				`Sitemap path must start with a forward slash, but got "${path}"`,
			)
		}
		this.#sitemapBaseUrl = baseUrl.replace(/\/+$/, '')
		this.#sitemapPath = toPosixPath(path)
		return this
	}
	/**
	 * Renders the provided render fragments to HTML.
	 *
	 * Collects `<Head>` fragments (#7), loads behavior modules, injects the
	 * loader with modulepreload links (#18), handles island load strategies
	 * and per-module styles (#20/#21), then injects canonical/hreflang/OG
	 * tags (#30/#10) and finally runs `onPageRender` plugin hooks (#25).
	 *
	 * @param {RenderFragments} fragments The render fragments to render
	 * @param {{ path?: string, ctx?: PageContext }} [info] Page information
	 * @returns {Promise<string>} The rendered HTML
	 */
	async #renderToHtmlAsync(fragments, info = {}) {
		const path = info.path ?? this.#currentPagePath ?? ''
		const ctx =
			info.ctx ?? this.#makeContext(path, {}, null, null)
		// Collect HEAD fragments from the page and (optionally) the layout.
		/** @type {Record<string, any>} */
		const head = {}
		/** @type {RenderFragments} */
		const bodyFragments = []
		for (const fragment of fragments) {
			if (fragment.type === RenderFragmentType.HEAD) {
				let props = fragment.meta
				if (props == null) {
					try {
						props = JSON.parse(fragment.value || '{}')
					} catch {
						props = {}
					}
				}
				Object.assign(head, props)
			} else {
				bodyFragments.push(fragment)
			}
		}
		/**
		 * Mapping of fragment indexes to their behavior module promises.
		 * @type {Map<number, Promise<{ default: BehaviorModule }>>}
		 */
		const fragProms = new Map()
		for (let i = 0; i < bodyFragments.length; i++) {
			const fragment = bodyFragments[i]
			if (fragment.type === RenderFragmentType.BEHAVIOR_MODULE) {
				const prom =
					/** @type {Promise<{ default: BehaviorModule }>} */ (
						fragment.behaviorModulePromise
					)
				this.#clientManager.loadBehaviorModule(prom)
				fragProms.set(i, prom)
			}
		}
		// Wait for all behavior modules to load before we start injecting loaders.
		await this.#clientManager.waitForModules()
		/** @type {Map<number, LoaderDescriptor>} */
		const fragMods = new Map()
		for (const [i, prom] of fragProms.entries()) {
			const mod = /** @type {BehaviorModule} */ ((await prom).default)
			// BUG 3 FIX: Normalize to POSIX so the key matches what was stored
			// by #loadModule (which now also stores POSIX-normalized keys).
			const relativePath = relPosix(
				this.#clientManager.rootPath,
				fileURLToPath(mod.behaviorModuleUrl),
			)
			const loaded = this.#clientManager.loadedModules.get(relativePath)
			if (loaded?.type !== 'behavior') {
				throw new Error(
					`Supposed behavior module "${relativePath}" is not a behavior module.`,
				)
			}
			/** @type {any} */
			const fragmentMeta = bodyFragments[i].meta ?? {}
			/** @type {LoaderDescriptor} */
			const desc = {
				p: loaded.rewrittenPath,
				l:
					/** @type {LoadStrategy} */ (
						fragmentMeta.load ?? loaded.load ?? 'eager'
					),
				s: loaded.styles,
			}
			fragMods.set(i, desc)
			// #23: track the page's module dependencies for incremental builds.
			this.#currentPagePath = path
			this.noteModuleDependency(loaded.rewrittenPath)
		}
		/** @type {string[]} */
		const res = []
		for (let i = 0; i < bodyFragments.length; i++) {
			const fragment = bodyFragments[i]
			if (fragment.type === RenderFragmentType.BEHAVIOR_MODULE) {
				const desc = /** @type {LoaderDescriptor} */ (fragMods.get(i))
				res.push(`<!--${behaviorComment(desc)}-->`)
			} else if (
				fragment.type === RenderFragmentType.BEHAVIOR_MODULE_LOADER
			) {
				if (fragMods.size !== 0) {
					const descs = [...fragMods.values()]
					res.push(
						modulePreloadLinks(descs, this.url('/_wfclient/').replace(/\/$/, '') + '/'),
					)
					res.push(
						`<script type="module"${this.#nonceAttr()}>\n${generateLoaderScript(descs, {
							strategy: this.#loaderStrategy,
							base: this.url('/_wfclient/').replace(/\/$/, '') + '/',
						})}\n</script>`,
					)
				}
			} else {
				res.push(fragment.toHtml())
			}
		}
		let content = res.join('')
		if (isHtmlPath(path)) {
			const ogImage = this.#computeOgImage(path, head)
			const siteBase = this.#effectiveBaseUrl() + this.#base
			const i18n = this.#i18nOptions
			const headTags = renderHeadTags(head, {
				baseUrl: siteBase,
				path,
				locales: i18n?.locales ?? [],
				defaultLocale: i18n?.defaultLocale,
				locale: ctx.locale,
				ogImage,
				urlForLocale: i18n?.urlForLocale
					? (locale, p) =>
							siteBase +
							i18n.urlForLocale(locale, p)
					: undefined,
			})
			content = injectHead(content, headTags)
		}
		for (const plugin of this.#plugins) {
			if (typeof plugin.onPageRender === 'function') {
				const result = await plugin.onPageRender(content, path)
				if (typeof result === 'string') {
					content = result
				}
			}
		}
		return content
	}
	/**
	 * Loads a mapping of lowercase file extensions (without the leading `.`) to their file extension.
	 * If no mappings can be resolved, returns null.
	 * @returns {Promise<Map<string, string> | null>}
	 */
	async #loadExtToMime() {
		/** @typedef {Record<string, { extensions?: readonly string[] }>} MimeDatabase */
		// First, let's try and load something `mime-db`-like.
		/** @type {MimeDatabase | undefined} */
		let mimeDb
		try {
			// Try to use NPM copy.
			mimeDb = (await import('mime-db')).default
			console.log('Using MIME type mappings from NPM mime-db')
		} catch {
			// Try to use a vendored copy.
			try {
				const filename = 'mime-db.json'
				const vendorPath = pathUtil.join(import.meta.dirname, filename)
				// FIX #2: vendorPath is also an absolute filesystem path, so it
				// needs the same file: URL wrapping as #loadModule's imports.
				mimeDb = (
					await import(pathToFileURL(vendorPath).href, {
						with: { type: 'json' },
					})
				).default
				console.log('Using MIME type mappings from ' + filename)
			} catch {}
		}
		if (mimeDb) {
			// We found a mime-db.
			/** @type {Map<string, string>} */
			const extToMime = new Map()
			for (const mime in mimeDb) {
				const info = mimeDb[mime]
				if (info.extensions) {
					for (const ext of info.extensions) {
						extToMime.set(ext, mime)
					}
				}
			}
			return extToMime
		}
		// If we're on a UNIX-like operating system, we have some options to resolve it from the system.
		if (process.platform !== 'win32') {
			const globPaths = [
				'/usr/share/mime/globs2',
				'/usr/local/share/mime/globs2',
				'/usr/pkg/share/mime/globs2',
				'/usr/share/mime/globs',
				'/usr/local/share/mime/globs',
				'/usr/pkg/share/mime/globs',
			]
			for (const globPath of globPaths) {
				try {
					const str = (await fs.readFile(globPath, 'utf8')).toString()
					console.log('Using MIME type mappings from ' + globPath)
					let lns = str
						.split('\n')
						.filter(
							(ln) => !ln.startsWith('# ') && ln.includes(':'),
						)
					if (globPath.endsWith('2')) {
						/** @type {[number, string][]} */
						const weighted = lns.map((raw) => {
							const colonIdx = raw.indexOf(':')
							const weight = parseFloat(
								raw.substring(0, colonIdx),
							)
							const ln = raw.substring(colonIdx + 1)
							return [weight, ln]
						})
						weighted.sort(([a], [b]) => b - a)
						lns = weighted.map(([, ln]) => ln)
					}
					/** @type {Map<string, string>} */
					const extToMime = new Map()
					for (const ln of lns) {
						const [mime, glob] = ln.split(':')
						const extIdx = glob.lastIndexOf('*.')
						if (extIdx === -1) {
							continue
						}
						const ext = glob.substring(extIdx + 2)
						if (!extToMime.has(ext)) {
							extToMime.set(ext, mime)
						}
					}
					return extToMime
				} catch {}
			}
		}
		return null
	}
	/**
	 * Overrides the root path.
	 * @param {string} path The root path
	 * @returns {Wunphile} This
	 */
	overrideRootPath(path) {
		if (!isMainThread) {
			return this
		}
		this.#rootPath = pathUtil.resolve(path)
		return this
	}
	/**
	 * Overrides the output path.
	 *
	 * BUG 5 FIX: Previously this method validated `path.startsWith('/')` and
	 * threw "The not found page must start with a forward slash." — a clear
	 * copy-paste error from `overrideNotFoundPath`. The output path is a
	 * *filesystem* path, not a URL path, so relative paths are legitimate
	 * (they are resolved against the CWD by `pathUtil.resolve()`).
	 * The bogus check is removed; only the copy-paste message is corrected.
	 *
	 * @param {string} path The output path (absolute or relative to CWD)
	 * @returns {Wunphile} This
	 */
	overrideOutputPath(path) {
		if (!isMainThread) {
			return this
		}
		if (path.trim() === '') {
			throw new Error('The output path must not be empty.')
		}
		this.#outputPath = pathUtil.resolve(path)
		return this
	}
	/**
	 * Overrides the not found path.
	 * The not found path is normally specified by the `SSG_NOT_FOUND_PATH` environment variable, and defaults to `/404.html` if not specified.
	 *
	 * BUG 1 FIX: This is a URL path, not a filesystem path. Previously it was
	 * routed through `pathUtil.resolve()` which on Windows prepends a drive
	 * letter, failing the `startsWith('/')` guard. We now validate and
	 * POSIX-normalize without filesystem resolution.
	 *
	 * @param {string} path The not found path (URL-style, starts with `/`)
	 * @returns {Wunphile} This
	 */
	overrideNotFoundPath(path) {
		if (!isMainThread) {
			return this
		}
		if (!path.startsWith('/')) {
			throw new Error(
				'The not found page must start with a forward slash.',
			)
		}
		this.#notFoundPath = toPosixPath(path)
		return this
	}
	/**
	 * Registers a component to a page path.
	 *
	 * Paths containing `[param]` / `[...rest]` are dynamic (#6): they are
	 * expanded at build time from `getStaticPaths()` or content collections.
	 * With i18n enabled, every page is also registered for each locale (#32).
	 *
	 * @param {string} path The page's path
	 * @param {Component<any, any>} component The page's component
	 * @param {{ paths?: any, getStaticPaths?: Function, meta?: SitemapEntry, dynamic?: boolean }} [options]
	 */
	page(path, component, options = {}) {
		if (!path.startsWith('/')) {
			throw new Error(
				`Page path must start with a forward slash, but got "${path}"`,
			)
		}
		const clean = toPosixPath(path)
		if (options.meta != null) {
			this.#pageMeta.set(clean, options.meta)
		}
		const isDynamic =
			options.dynamic === true || /\[[^\]]+\]/.test(clean)
		if (isMainThread) {
			if (isDynamic) {
				this.#dynamicPages.set(clean, { component, options })
				return
			}
			for (const variant of this.#localeVariants()) {
				const dest = normalizeUrlPath(variant.prefix + clean)
				const ctx = this.#makeContext(dest, {}, variant.locale, null)
				this.#pageMapping.set(
					dest,
					variant.locale == null
						? component
						: () => component(ctx),
				)
				if (variant.locale != null) {
					this.#pageMeta.set(dest, {
						...this.#pageMeta.get(clean),
						cacheKey: JSON.stringify({ path: clean, locale: variant.locale }),
					})
				}
			}
		} else {
			// FIX #12: a failed render must be reported to the main thread,
			// otherwise the reload is incorrectly treated as successful.
			for (const { dest, ctx } of this.#expandPagePathsSync(clean, options)) {
				this.#renderPage(dest, component, ctx)
					.then((content) => {
						parentPort.postMessage({
							type: 'pageRaw',
							path: dest,
							content,
						})
					})
					.catch((err) => {
						parentPort.postMessage({
							type: 'pageError',
							path: dest,
							error:
								err instanceof Error
									? err.stack || err.message
									: String(err),
						})
					})
			}
		}
	}
	/**
	 * Registers raw content to a page path.
	 * @param {string} path The page's path
	 * @param {string} content The page's content
	 * @param {any} [options]
	 */
	pageRaw(path, content, options) {
		this.page(path, () => html(content), options)
	}
	/**
	 * Registers a redirect from one path to another (#12/#34).
	 *
	 * The target is validated: only `/`-relative paths and http(s) URLs are
	 * accepted, so `javascript:` payloads can never reach `href` or
	 * `location.assign()`. With an adapter configured, `status` is emitted
	 * as a real 301/302 in `_redirects` / `vercel.json`; the dev server
	 * responds with the same status directly. An HTML fallback page is still
	 * generated for plain static hosts.
	 *
	 * @param {string} path The path to redirect from
	 * @param {string} url The URL/path to redirect to
	 * @param {{ status?: 301 | 302 | 303 | 307 | 308 }} [options]
	 */
	redirect(path, url, options = {}) {
		const target = safeRedirectUrl(url)
		const status = options.status ?? 301
		if (![301, 302, 303, 307, 308].includes(status)) {
			throw new Error(`Invalid redirect status: ${status}`)
		}
		// FIX #8: Remember redirect paths so #buildSitemap() can omit them.
		this.#redirectPaths.add(path)
		if (isMainThread) {
			this.#redirects.set(path, { to: target, status })
		} else if (typeof parentPort?.postMessage === 'function') {
			parentPort.postMessage({ type: 'redirect', path, to: target, status })
		}
		// FIX #3: JSON.stringify() output is already a valid JS literal.
		// jsStringLiteral() additionally prevents `</script>` from escaping
		// the inline script element (#34).
		// prettier-ignore
		this.page(path, () => html`
<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
        />
        <title>Redirecting to ${target}...</title>
    </head>
    <body>
        Redirecting to <a href="${target}">${target}</a>... (click link if nothing happens)
        <meta http-equiv="refresh" content="0; url=${target}" />
        <script${new RenderFragment(RenderFragmentType.HTML, this.#nonceAttr())}>location.assign(${new RenderFragment(RenderFragmentType.HTML, jsStringLiteral(target))})</script>
    </body>
</html>
        `)
	}
	/**
	 * Registers a component to be used as the not found page.
	 * @param {Component<void, void>} component The component to use for the not found page
	 */
	notFoundPage(component) {
		this.page(this.#notFoundPath, component)
	}
	/**
	 * Registers a static directory to a path.
	 * @param {string} path The path to the static directory
	 * @param {string} dir The directory to copy
	 * @param {StaticOptions} [options] `{ hash: true }` fingerprints every file (#1)
	 */
	staticDir(path, dir, options = {}) {
		if (!path.startsWith('/')) {
			throw new Error(
				`Static directory path must start with a forward slash, but got "${path}"`,
			)
		}
		if (isMainThread) {
			this.#staticDirMappings.set(toPosixPath(path), dir)
			this.#staticDirOptions.set(toPosixPath(path), options)
		} else {
			parentPort.postMessage({
				type: 'staticDir',
				path,
				dir,
				options,
			})
		}
	}
	/**
	 * Registers a static file to a path.
	 * @param {string} path The path to the static file
	 * @param {string} file The file to copy
	 * @param {StaticOptions} [options] `{ hash: true }` fingerprints the file (#1)
	 */
	staticFile(path, file, options = {}) {
		if (!path.startsWith('/')) {
			throw new Error(
				`Static file path must start with a forward slash, but got "${path}"`,
			)
		}
		if (isMainThread) {
			this.#staticFileMappings.set(toPosixPath(path), file)
			this.#staticFileOptions.set(toPosixPath(path), options)
		} else {
			parentPort.postMessage({
				type: 'staticFile',
				path,
				file,
				options,
			})
		}
	}
	/**
	 * Returns the resolved path of the specified path relative to the project root path.
	 * @param {string} path The path to resolve
	 * @returns {string} The resolved project path
	 */
	toProjectPath(path) {
		return pathUtil.join(this.#rootPath, path)
	}
	/**
	 * Returns the resolved path of the specified path relative to the output path.
	 * @param {string} path The path to resolve
	 * @returns {string} The resolved output path
	 */
	toOutputPath(path) {
		return pathUtil.join(this.#outputPath, path)
	}
	/**
	 * Minifies an HTML string.
	 * Collapses whitespace between tags, removes HTML comments (except
	 * conditional comments and `wf-behavior:` hydration comments), and trims
	 * leading/trailing whitespace.
	 *
	 * NEW FEATURE. Conservative - does not touch <pre>, <textarea>, <script>, or <style> contents.
	 *
	 * FIX #13: Whitespace *inside text nodes* is never collapsed, so inline
	 * content that depends on repeated spaces is preserved.
	 *
	 * @param {string} htmlStr The HTML to minify
	 * @returns {string} The minified HTML
	 */
	#minifyHtmlString(htmlStr) {
		return minifyHtml(htmlStr)
	}
	/**
	 * Builds the sitemap entries for registered pages (#31).
	 * Excludes client mounts, redirects, generated feeds/robots and 404.
	 * @returns {SitemapEntry[]}
	 */
	#sitemapEntries() {
		if (this.#sitemapBaseUrl == null) {
			return []
		}
		const base = this.#effectiveBaseUrl() + this.#base
		const excludePaths = new Set([
			this.#notFoundPath,
			...this.#redirectPaths,
			...this.#generatedPaths,
		])
		// i18n generates localized variants of 404 and redirect pages too.
		for (const variant of this.#localeVariants()) {
			if (variant.prefix === '') {
				continue
			}
			excludePaths.add(variant.prefix + this.#notFoundPath)
			for (const path of this.#redirectPaths) {
				excludePaths.add(variant.prefix + path)
			}
		}
		/** @type {SitemapEntry[]} */
		const entries = []
		for (const path of this.#pageMapping.keys()) {
			if (path.startsWith(CLIENT_MOUNT_PREFIX) || excludePaths.has(path)) {
				continue
			}
			if (!isHtmlPath(path)) {
				continue
			}
			const meta = this.#pageMeta.get(path) ?? {}
			/** @type {SitemapEntry} */
			const entry = {
				path,
				lastmod: meta.lastmod,
				changefreq: meta.changefreq,
				priority: meta.priority,
			}
			const i18n = this.#i18nOptions
			if ((i18n?.locales?.length ?? 0) > 1) {
				const locales = /** @type {string[]} */ (i18n.locales)
				entry.alternates = locales.map((locale) => ({
					hreflang: locale,
					href:
						base +
						(locale === i18n.defaultLocale && !i18n.prefixDefault
							? path
							: `/${locale}${path}`),
				}))
			}
			entries.push(entry)
		}
		entries.sort((a, b) => String(a.path).localeCompare(String(b.path)))
		return entries
	}
	/**
	 * Builds sitemap.xml content via the pure {@link buildSitemap} export (#39).
	 * @returns {string}
	 */
	#buildSitemap() {
		if (this.#sitemapBaseUrl == null) {
			return ''
		}
		return buildSitemap(
			this.#sitemapEntries(),
			this.#effectiveBaseUrl() + this.#base,
		)
	}
	/** @returns {Promise<void>} Clears the output directory. */
	async #clearOutput() {
		if ((await statOrNull(this.#outputPath)) === null) {
			await fs.mkdir(this.#outputPath, { recursive: true })
			return
		}
		/** @type {Promise<void>[]} */
		const proms = []
		for (const file of await fs.readdir(this.#outputPath)) {
			proms.push(
				fs.rm(this.toOutputPath(file), {
					recursive: true,
					force: true,
				}),
			)
		}
		await Promise.all(proms)
	}
	/** @returns {string} Path of the persistent incremental cache (#23). */
	#buildCachePath() {
		return pathUtil.join(this.#rootPath, CACHE_DIR, 'cache.json')
	}
	/** @returns {Promise<any>} */
	async #loadBuildCache() {
		try {
			return JSON.parse(await fs.readFile(this.#buildCachePath(), 'utf8'))
		} catch {
			return { version: 1, pages: {}, assets: {} }
		}
	}
	/**
	 * @param {Record<string, string>} pages
	 * @returns {Promise<void>}
	 */
	async #saveBuildCache(pages) {
		const file = this.#buildCachePath()
		await fs.mkdir(pathUtil.dirname(file), { recursive: true })
		await fs.writeFile(
			file,
			JSON.stringify(
				{ version: 1, pages, assets: this.manifest() },
				null,
				2,
			) + '\n',
		)
	}
	/**
	 * Hash of a page's component source + dependencies (#23).
	 * @param {string} dest
	 * @param {any} component
	 * @returns {string}
	 */
	#pageHash(dest, component) {
		return sha256(
			[
				String(component?.toString?.() ?? ''),
				String(this.#pageMeta.get(dest)?.cacheKey ?? ''),
				JSON.stringify([...(this.#pageDeps.get(dest) ?? [])]),
				this.#clientManager.moduleFingerprints().join('|'),
				JSON.stringify(this.manifest()),
				JSON.stringify({
					minify: this.#minifyHtml,
					base: this.#base,
					loader: this.#loaderStrategy,
					csp: this.#cspEnabled,
				}),
			].join('\n'),
		)
	}
	/**
	 * Writes generated non-page files: manifest, OG images, sitemap(s),
	 * adapter configs and build stats.
	 * @param {BuildOptions} opts
	 * @param {any} stats
	 * @returns {Promise<void>}
	 */
	async #writeGeneratedFiles(opts, stats) {
		// #1: asset manifest.json
		const manifest = this.manifest()
		await this.#writePage('/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
		this.#generatedPaths.add('/manifest.json')
		// #10: OG images
		for (const [url, body] of this.#ogImages) {
			await this.#writePageBuffer(url, body)
		}
		// #31: sitemap, split into parts above 50,000 URLs
		if (this.#sitemapBaseUrl != null && this.#sitemapPath != null) {
			const entries = this.#sitemapEntries()
			const base = this.#effectiveBaseUrl() + this.#base
			const sitemapPath = /** @type {string} */ (this.#sitemapPath)
			if (entries.length > 50_000) {
				/** @type {string[]} */
				const parts = []
				for (let i = 0; i < entries.length; i += 50_000) {
					const partPath = `/sitemap-${parts.length + 1}.xml`
					await this.#writePage(
						partPath,
						buildSitemap(entries.slice(i, i + 50_000), base),
					)
					this.#generatedPaths.add(partPath)
					parts.push(base + this.url(partPath))
				}
				await this.#writePage(sitemapPath, buildSitemapIndex(parts))
			} else {
				await this.#writePage(sitemapPath, this.#buildSitemap())
			}
			this.#generatedPaths.add(sitemapPath)
			// FIX #8: log the number of URLs actually written.
			console.log(
				`Generated sitemap at ${sitemapPath} with ${entries.length} URLs`,
			)
		}
		// #11: deployment adapter files
		await this.#generateAdapters()
		// #38: build statistics
		stats.manifest = manifest
		stats.buildOptions = { ...opts }
		stats.absoluteImports = this.#absoluteImports
		stats.robots = this.#robotsOptions
		stats.modules = this.#clientManager.moduleFingerprints()
		let totalBytes = 0
		for (const asset of this.#assets.values()) {
			totalBytes += Number(asset.size ?? 0)
		}
		for (const page of stats.pages) {
			totalBytes += Number(page.bytes ?? 0)
		}
		stats.totalBytes = totalBytes
		let largestModule = 0
		for (const fingerprint of stats.modules) {
			largestModule = Math.max(largestModule, String(fingerprint).length)
		}
		stats.largestModule = largestModule
		this.#lastStats = stats
	}
	/**
	 * Writes a Buffer to an output path.
	 * @param {string} url
	 * @param {Buffer} body
	 * @returns {Promise<void>}
	 */
	async #writePageBuffer(url, body) {
		const dest = this.#safeOutputPath(url)
		await fs.mkdir(pathUtil.dirname(dest), { recursive: true })
		await fs.writeFile(dest, body)
	}
	/**
	 * Emits platform configuration files (#11/#12).
	 * @returns {Promise<void>}
	 */
	async #generateAdapters() {
		const adapter = this.#adapter
		if (adapter == null) {
			return
		}
		const name = adapter.name
		const redirects = [...this.#redirects.entries()].map(
			([from, info]) => `${from}\t${info.to}\t${info.status}`,
		)
		const hashed = [...this.#assetManifest.values()]
		const immutable = hashed
			.map(
				(path) =>
					`${path}\n  Cache-Control: public, max-age=31536000, immutable`,
			)
			.join('\n')
		const headers = `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n${immutable ? immutable + '\n' : ''}`
		const staticGlobs = [
			...[...this.#staticDirMappings.keys()].map(
				(path) => path.replace(/\/+$/, '') + '/*',
			),
			'/_wfclient/*',
		]
		if (name === 'netlify' || name === 'cloudflare-pages') {
			await this.#writePage(
				'/_redirects',
				redirects.length > 0 ? redirects.join('\n') + '\n' : '',
			)
			await this.#writePage('/_headers', headers)
		}
		if (name === 'cloudflare-pages') {
			await this.#writePage(
				'/_routes.json',
				JSON.stringify(
					{ version: 1, include: ['/*'], exclude: staticGlobs },
					null,
					2,
				) + '\n',
			)
		}
		if (name === 'vercel') {
			await this.#writePage(
				'/vercel.json',
				JSON.stringify(
					{
						redirects: [...this.#redirects.entries()].map(
							([from, info]) => ({
								source: from,
								destination: info.to,
								permanent: info.status === 301 || info.status === 308,
							}),
						),
						headers: hashed.map((path) => ({
							source: path,
							headers: [
								{
									key: 'Cache-Control',
									value: 'public, max-age=31536000, immutable',
								},
							],
						})),
					},
					null,
					2,
				) + '\n',
			)
		}
		if (name === 'github-pages') {
			await this.#writePage('/.nojekyll', '')
			if (adapter.cname) {
				await this.#writePage('/CNAME', String(adapter.cname) + '\n')
			}
		}
		this.#generatedPaths.add('/_redirects')
		this.#generatedPaths.add('/_headers')
	}
	/**
	 * Writes `.gz` / `.br` variants of text-like outputs (#3).
	 * @param {('gzip' | 'br')[]} formats
	 * @param {any} stats
	 * @returns {Promise<void>}
	 */
	async #precompress(formats, stats) {
		const extensions = new Set([
			'.html', '.css', '.js', '.mjs', '.svg', '.json', '.xml', '.txt',
		])
		for (const rel of await listFilesRecursive(this.#outputPath)) {
			if (!extensions.has(pathUtil.extname(rel).toLowerCase())) {
				continue
			}
			const full = pathUtil.join(this.#outputPath, rel)
			const buffer = await fs.readFile(full)
			/** @type {Record<string, number>} */
			const sizes = { raw: buffer.length }
			for (const format of formats) {
				if (format === 'gzip') {
					const gz = zlib.gzipSync(buffer, { level: 9 })
					await fs.writeFile(full + '.gz', gz)
					sizes.gzip = gz.length
				} else if (format === 'br') {
					const br = zlib.brotliCompressSync(buffer)
					await fs.writeFile(full + '.br', br)
					sizes.br = br.length
				}
			}
			stats.compressed.push({ path: '/' + toPosixPath(rel), ...sizes })
		}
	}
	/**
	 * Prints per-page timings, per-asset sizes and the Top 10 outputs (#4).
	 * @param {any} stats
	 * @param {BuildOptions} opts
	 */
	#printReport(stats, opts) {
		if (opts.quiet) {
			return
		}
		/** @type {string[]} */
		const lines = [`Wunphile build report (${stats.durationMs}ms)`]
		lines.push(
			`  pages: ${stats.pages.length} (${stats.skipped} cached), assets: ${stats.assets.length}, behavior modules: ${stats.modules.length}`,
		)
		for (const page of stats.pages) {
			lines.push(
				`  page  ${page.path}: ${page.ms}ms, ${formatBytes(page.bytes)}${page.skipped ? ' (cached)' : ''}`,
			)
		}
		for (const asset of stats.assets) {
			let compressed = null
			for (const candidate of stats.compressed) {
				if (candidate.path === asset.finalUrl) {
					compressed = candidate
					break
				}
			}
			const extra = compressed
				? `${compressed.gzip != null ? `, gzip ${formatBytes(compressed.gzip)}` : ''}${compressed.br != null ? `, br ${formatBytes(compressed.br)}` : ''}`
				: ''
			lines.push(
				`  asset ${asset.finalUrl}: raw ${formatBytes(asset.rawSize)}${extra}`,
			)
		}
		/** @type {{ path: string, bytes: number }[]} */
		const largest = []
		for (const page of stats.pages) {
			largest.push({ path: String(page.path), bytes: Number(page.bytes) })
		}
		for (const asset of stats.assets) {
			largest.push({
				path: String(asset.finalUrl),
				bytes: Number(asset.size),
			})
		}
		largest.sort((a, b) => b.bytes - a.bytes)
		largest.length = Math.min(largest.length, 10)
		lines.push('  Top 10 largest outputs:')
		for (const item of largest) {
			lines.push(`    ${formatBytes(item.bytes).padStart(9)}  ${item.path}`)
		}
		console.log(lines.join('\n'))
	}
	/**
	 * Builds the site only.
	 *
	 * Order: clear output -> prepare assets -> expand dynamic routes ->
	 * write assets -> render pages concurrently -> write generated files ->
	 * precompress -> report.
	 *
	 * @param {BuildOptions} [options] `{ precompress, incremental, stats, concurrency, quiet }`
	 * @returns {Promise<void>}
	 */
	async build(options = {}) {
		if (!isMainThread) {
			console.warn(
				'The build() method was manually called in a hot reload thread. This is not supported, so the hot reload thread will exit.',
			)
			process.exit(0)
		}
		const opts = { ...this.#buildOptions, ...options }
		const startTime = Date.now()
		/** @type {any} */
		const stats = {
			startedAt: new Date(startTime).toISOString(),
			durationMs: 0,
			pages: [],
			assets: [],
			compressed: [],
			modules: [],
			skipped: 0,
			totalBytes: 0,
			largestModule: 0,
			timings: {},
		}
		this.#buildCache = opts.incremental ? await this.#loadBuildCache() : null
		if (!opts.incremental) {
			await this.#clearOutput()
		} else {
			await fs.mkdir(this.#outputPath, { recursive: true })
		}
		await this.#prepareAssets()
		await this.#expandDynamicPages()
		await this.#clientManager.waitForModules()
		await this.#writeAssets()
		const assetCountBefore = this.#staticFileMappings.size
		/** @type {Record<string, string>} */
		const nextCache = {}
		const rendered = new Set()
		// #22: bounded-concurrency page rendering. New pages registered while
		// rendering (behavior modules, OG images) are picked up in later rounds.
		while (true) {
			const batch = [...this.#pageMapping.entries()].filter(
				([path]) => !rendered.has(path),
			)
			if (batch.length === 0) {
				break
			}
			await mapConcurrent(
				batch,
				opts.concurrency ?? 8,
				async ([dest, component]) => {
					rendered.add(dest)
					const started = Date.now()
					let content = await this.#renderPage(
						dest,
						component,
						this.#makeContext(dest, {}, null, null),
					)
					if (this.#minifyHtml && isHtmlPath(dest)) {
						content = this.#minifyHtmlString(content)
					}
					const hash = this.#pageHash(dest, component)
					nextCache[dest] = hash
					const cached =
						opts.incremental &&
						this.#buildCache?.pages?.[dest] === hash &&
						(await statOrNull(this.toOutputPath(dest))) !== null
					if (!cached) {
						await this.#writePage(dest, content)
					} else {
						stats.skipped++
					}
					const ms = Date.now() - started
					stats.pages.push({
						path: dest,
						ms,
						bytes: Buffer.byteLength(content),
						skipped: Boolean(cached),
					})
					stats.timings[dest] = ms
				},
			)
		}
		// Modules imported by components register static files *during* render.
		if (this.#staticFileMappings.size !== assetCountBefore) {
			await this.#prepareAssets()
			await this.#writeAssets()
		}
		stats.assets = [...this.#assets.values()].map((asset) => ({
			path: asset.url,
			finalUrl: asset.finalUrl,
			rawSize: asset.rawSize,
			size: asset.size,
			hashed: asset.hashed,
		}))
		await this.#writeGeneratedFiles(opts, stats)
		if (opts.precompress?.length) {
			await this.#precompress(opts.precompress, stats)
		}
		if (opts.incremental) {
			await this.#saveBuildCache(nextCache)
		}
		stats.durationMs = Date.now() - startTime
		this.#lastStats = stats
		// #38: build-stats.json contains the final (post-compression) numbers.
		if (opts.stats) {
			await this.#writePage(
				'/build-stats.json',
				JSON.stringify(stats, null, 2) + '\n',
			)
			this.#generatedPaths.add('/build-stats.json')
		}
		// #25: onBuildEnd hook
		for (const plugin of this.#plugins) {
			if (typeof plugin.onBuildEnd === 'function') {
				await plugin.onBuildEnd({
					pages: stats.pages,
					assets: stats.assets,
					manifest: stats.manifest,
					stats,
				})
			}
		}
		// #4: build report
		this.#printReport(stats, opts)
	}
	/* ==================================================================
	 * Development server (#13, #14, #15, #16, #17, #33, #40)
	 * ================================================================ */
	/**
	 * Pushes a named SSE event to every connected dev client (#15).
	 * @param {string} event
	 * @param {any} data
	 */
	#broadcastDev(event, data) {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
		for (const res of this.#sseClients) {
			try {
				res.write(payload)
			} catch {
				this.#sseClients.delete(res)
			}
		}
	}
	/**
	 * Builds the injected dev client: SSE-first with long-polling fallback,
	 * a red error overlay, and accessibility warnings (#15/#33).
	 * @param {boolean} hotReloadEnabled
	 * @param {boolean} injectEnabled
	 * @returns {string}
	 */
	#devTrailer(hotReloadEnabled, injectEnabled) {
		if (!injectEnabled) {
			return ''
		}
		const initialError = JSON.stringify(this.#devError ?? null)
		const warnings = JSON.stringify(this.#devWarnings)
		const endpoint = JSON.stringify(DEV_ENDPOINT_PREFIX)
		const hotReload = hotReloadEnabled ? 'true' : 'false'
		return `
<!-- Injected by Wunphile for development mode hot reloading -->
<div id="__wf_overlay" style="display:none;position:fixed;z-index:2147483647;top:0;left:0;right:0;padding:12px 16px;font:13px/1.5 monospace;color:#fff;background:#b91c1c;white-space:pre-wrap;max-height:50vh;overflow:auto"></div>
<script type="module"${this.#nonceAttr()}>
(() => {
	const overlay = document.getElementById('__wf_overlay');
	const show = (message) => { overlay.textContent = String(message); overlay.style.display = 'block'; };
	const hide = () => { overlay.style.display = 'none'; overlay.textContent = ''; };
	const initialError = ${initialError};
	if (initialError) show(initialError); else hide();
	for (const warning of ${warnings}) console.warn('[wunphile a11y]', warning);
	const endpoint = ${endpoint};
	const hotReload = ${hotReload};
	function startPolling() {
		if (window.__wunphile_hotreload_poll) return;
		window.__wunphile_hotreload_poll = true;
		(async () => {
			while (true) {
				const abort = new AbortController();
				const timer = setTimeout(() => abort.abort(), 1000);
				try {
					const res = await fetch(endpoint, { signal: abort.signal });
					const rlTime = parseInt(res.headers.get('X-Wunphile-Reload')) || Number.MAX_SAFE_INTEGER;
					if (rlTime <= ${this.#lastReload}) await res.text();
					clearTimeout(timer);
					window.location.reload();
					return;
				} catch (err) {
					clearTimeout(timer);
					if (!(err instanceof DOMException && err.name === 'AbortError')) {
						await new Promise((resolve) => setTimeout(resolve, 1000));
					}
				}
			}
		})();
	}
	if (!hotReload) {
		// Hot reloading is disabled, but the error overlay and a11y warnings
		// are still injected in development mode.
	} else if (typeof EventSource !== 'undefined') {
		const es = new EventSource(endpoint);
		let opened = false;
		es.onopen = () => { opened = true; hide(); };
		es.addEventListener('reload', () => window.location.reload());
		es.addEventListener('wferror', (ev) => {
			try { show(JSON.parse(ev.data).message); } catch {}
		});
		es.addEventListener('wfwarn', (ev) => {
			try { for (const w of JSON.parse(ev.data).warnings) console.warn('[wunphile a11y]', w); } catch {}
		});
		es.onerror = () => { if (!opened) { es.close(); startPolling(); } };
	} else {
		startPolling();
	}
})();
</script>`
	}
	/**
	 * Creates a portable file watcher (#16).
	 * Prefers chokidar when installed, falls back to `fs.watch({recursive})`,
	 * and finally to per-directory watchers when recursion is unsupported.
	 * @param {(filename: string) => void} onChange
	 * @returns {void}
	 */
	#createWatcher(onChange) {
		const root = this.#rootPath
		if (
			process.platform === 'linux' &&
			parseInt(process.versions.node, 10) < 20
		) {
			console.warn(
				'[wunphile] recursive fs.watch is not supported on Linux before Node 20; install chokidar for reliable watching.',
			)
		}
		const ignored = [this.#outputPath, pathUtil.join(root, '.git'), pathUtil.join(root, CACHE_DIR)]
		const chokidar = resolveOptional('chokidar', root)
		if (chokidar?.watch) {
			const watcher = chokidar.watch(root, {
				ignoreInitial: true,
				ignored,
			})
			watcher.on(
				'all',
				(/** @type {any} */ _event, /** @type {any} */ filename) =>
					onChange(String(filename ?? '')),
			)
			this.#watchers.push({ close: () => watcher.close() })
			console.log('[wunphile] using chokidar for file watching')
			return
		}
		try {
			const watcher = fsSync.watch(
				root,
				{ recursive: true, persistent: true },
				(_eventType, filename) => {
					if (filename == null) {
						console.warn(
							'[wunphile] fs.watch reported a null filename (platform limitation); install chokidar for reliable watching.',
						)
					}
					onChange(filename == null ? '' : String(filename))
				},
			)
			this.#watchers.push({ close: () => watcher.close() })
		} catch (err) {
			console.warn(
				'[wunphile] recursive fs.watch is unavailable; falling back to per-directory watchers.',
				err,
			)
			/** @param {string} dir */
			const watchDir = (dir) => {
				if (ignored.some((path) => dir === path || dir.startsWith(path + pathUtil.sep))) {
					return
				}
				try {
					const watcher = fsSync.watch(dir, {}, (_eventType, filename) =>
						onChange(pathUtil.join(dir, String(filename ?? ''))),
					)
					this.#watchers.push({ close: () => watcher.close() })
				} catch {}
				try {
					for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
						if (entry.isDirectory()) {
							watchDir(pathUtil.join(dir, entry.name))
						}
					}
				} catch {}
			}
			watchDir(root)
		}
	}
	/**
	 * Returns true when a changed path should be ignored.
	 * @param {string} filename
	 * @returns {boolean}
	 */
	#ignoreChange(filename) {
		if (filename === '') {
			return false
		}
		const full = pathUtil.resolve(this.#rootPath, filename)
		return (
			full === this.#outputPath ||
			full.startsWith(this.#outputPath + pathUtil.sep) ||
			full.includes(pathUtil.sep + '.git' + pathUtil.sep) ||
			full.includes(pathUtil.sep + CACHE_DIR + pathUtil.sep)
		)
	}
	/**
	 * Re-runs the main module in a worker and installs its output (#15).
	 * @param {any} hrEmitter
	 * @returns {Promise<void>}
	 */
	async #reloadFromWorker(hrEmitter) {
		if (!isWorkerApiSupported) {
			return
		}
		const worker = new Worker(this.#mainModulePath, {
			workerData: {
				rootPath: this.#rootPath,
				outputPath: this.#outputPath,
				notFoundPath: this.#notFoundPath,
				config: this.#config ?? {},
			},
		})
		let gotError = false
		/** @type {string | null} */
		let errorMessage = null
		/** @type {Map<string, any>} */
		const pageMapping = new Map()
		const preRendered = new Map()
		/** @type {Map<string, string>} */
		const staticDirMapping = new Map()
		/** @type {Map<string, string>} */
		const staticFileMapping = new Map()
		/** @type {Map<string, any>} */
		const staticDirOptions = new Map()
		/** @type {Map<string, any>} */
		const staticFileOptions = new Map()
		/** @type {Map<string, any>} */
		const redirects = new Map()
		/** @type {Map<string, any>} */
		const collections = new Map()
		worker.on(
			'message',
			/** @type {(msg: any) => void} */ ((msg) => {
				switch (msg.type) {
					case 'pageRaw':
						preRendered.set(msg.path, msg.content)
						pageMapping.set(msg.path, () => html(msg.content))
						break
					case 'staticDir':
						staticDirMapping.set(msg.path, msg.dir)
						staticDirOptions.set(msg.path, msg.options ?? {})
						break
					case 'staticFile':
						staticFileMapping.set(msg.path, msg.file)
						staticFileOptions.set(msg.path, msg.options ?? {})
						break
					case 'redirect':
						redirects.set(msg.path, { to: msg.to, status: msg.status })
						break
					case 'collection':
						collections.set(msg.name, msg.entries ?? [])
						break
					case 'pageError':
						gotError = true
						errorMessage = String(msg.error)
						console.error(
							`Error while rendering page "${msg.path}":\n${msg.error}`,
						)
						break
				}
			}),
		)
		worker.on('error', (err) => {
			gotError = true
			errorMessage = err.stack || String(err)
			console.error('Error while reloading:', errorMessage)
		})
		worker.on('messageerror', (err) => {
			gotError = true
			errorMessage = String(err)
			console.error('Worker message error:', err)
		})
		await new Promise((resolve) => worker.on('exit', resolve))
		if (!gotError) {
			this.#pageMapping = pageMapping
			this.#preRenderedContent = preRendered
			this.#staticDirMappings = staticDirMapping
			this.#staticFileMappings = staticFileMapping
			this.#staticDirOptions = staticDirOptions
			this.#staticFileOptions = staticFileOptions
			this.#redirects = redirects
			this.#collections = collections
			this.#devError = null
			await this.#prepareAssets()
			console.log('Reloaded successfully.')
		} else {
			this.#devError = errorMessage ?? 'Unknown reload error'
			console.error(
				'Reload failed - keeping previous state. Fix the error and save again to retry.',
			)
		}
		// Always emit reload so browsers recheck, even on failure.
		hrEmitter?.emit('reload')
	}
	/**
	 * Watches the project and hot-reloads the dev server.
	 * @param {any} hrEmitter
	 */
	#watchHotReload(hrEmitter) {
		console.log(
			`Development mode hot reloading enabled. Watching "${this.#rootPath}" for changes.`,
		)
		let pending = false
		this.#createWatcher(async (filename) => {
			if (this.#ignoreChange(filename) || pending) {
				return
			}
			pending = true
			try {
				await new Promise((resolve) => setTimeout(resolve, 50))
				await this.#reloadFromWorker(hrEmitter)
			} catch (err) {
				this.#devError = err instanceof Error ? err.stack || err.message : String(err)
				console.error('Error while reloading:', err)
				hrEmitter?.emit('reload')
			} finally {
				pending = false
			}
		})
	}
	/**
	 * Watches the project and rebuilds without starting an HTTP server (#28).
	 * @param {BuildOptions} buildOpts
	 */
	#watchBuild(buildOpts) {
		console.log(
			`Build watch mode enabled. Watching "${this.#rootPath}" for changes.`,
		)
		let pending = false
		this.#createWatcher(async (filename) => {
			if (this.#ignoreChange(filename) || pending) {
				return
			}
			pending = true
			try {
				await new Promise((resolve) => setTimeout(resolve, 50))
				console.log('[wunphile] change detected, rebuilding...')
				await this.build({ ...buildOpts, quiet: true })
			} catch (err) {
				console.error('[wunphile] rebuild failed:', err)
			} finally {
				pending = false
			}
		})
	}
	/**
	 * Serves the site on a local HTTP server.
	 *
	 * Adds ETag/304, Range, gzip/br compression, SSE hot reload with a long
	 * polling fallback, an error overlay, plugin `onDevRequest`, accessibility
	 * warnings and a `(path, lastReload)` render cache.
	 *
	 * @param {number} port The port to listen on
	 * @param {string} [host='127.0.0.1'] The host to listen on
	 * @param {EventEmitter<{ reload: [] }>|null} [hotReloadEventEmitter=null]
	 * @param {{ signal?: AbortSignal }} [options]
	 * @returns {Promise<DevHandle>} A handle with `server` and `close()` (#40)
	 */
	async serve(
		port,
		host = '127.0.0.1',
		hotReloadEventEmitter = null,
		options = {},
	) {
		if (!isMainThread) {
			console.warn(
				'The serve() method was manually called in a hot reload thread. This is not supported, so the hot reload thread will exit.',
			)
			process.exit(0)
		}
		const injectEnabled = readEnv(DEV_NO_INJECT_ENV_VAR) !== '1'
		if (!injectEnabled) {
			hotReloadEventEmitter = null
		}
		const http = await import('node:http')
		const extToMime = (await this.#loadExtToMime()) ?? new Map()
		/**
		 * @param {string} path
		 * @returns {string}
		 */
		const pathToMime = (path) => {
			const dotIdx = path.lastIndexOf('.')
			if (dotIdx === -1) {
				return 'application/octet-stream'
			}
			const ext = path.substring(dotIdx + 1).toLowerCase()
			return extToMime.get(ext) ?? mimeForExt(ext)
		}
		await this.#prepareAssets()
		await this.#expandDynamicPages()
		await this.#clientManager.waitForModules()
		const devEmitter = hotReloadEventEmitter
		/** @type {any[]} */
		const waitResponses = []
		if (devEmitter !== null) {
			devEmitter.on('reload', () => {
				this.#lastReload = Date.now()
				this.#clientManager.newGeneration()
				this.#devRenderCache.clear()
				for (const res of waitResponses) {
					try {
						res.write('ok')
						res.end()
					} catch {}
				}
				waitResponses.length = 0
				this.#broadcastDev('reload', { t: this.#lastReload })
				if (this.#devError) {
					this.#broadcastDev('wferror', { message: this.#devError })
				}
			})
		}
		const server = http.createServer(async (req, res) => {
			try {
				const url = new URL(
					/** @type {string} */ (req.url),
					'http://localhost',
				)
				let basePath = url.pathname
				if (
					this.#base !== '' &&
					(basePath === this.#base || basePath.startsWith(this.#base + '/'))
				) {
					basePath = basePath.slice(this.#base.length) || '/'
				}
				// #25: plugin hook, may fully handle the request.
				for (const plugin of this.#plugins) {
					if (typeof plugin.onDevRequest === 'function') {
						const handled = await plugin.onDevRequest(req, res)
						if (handled === true || res.writableEnded) {
							return
						}
					}
				}
				// #20: client-side behavior error reports.
				if (basePath === '/_wfclient/error' && req.method === 'POST') {
					let body = ''
					for await (const chunk of req) {
						body += chunk
					}
					console.error('[wunphile] client behavior error:', body)
					res.writeHead(204)
					res.end()
					return
				}
				// #15: SSE (preferred) and long polling (fallback).
				if (devEmitter !== null && basePath === DEV_ENDPOINT_PREFIX) {
					const accept = String(req.headers.accept ?? '')
					if (
						accept.includes('text/event-stream') ||
						url.searchParams.has('sse')
					) {
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache, no-transform',
							Connection: 'keep-alive',
							'X-Accel-Buffering': 'no',
						})
						res.write('retry: 2000\n\n')
						if (this.#devError) {
							res.write(
								`event: wferror\ndata: ${JSON.stringify({ message: this.#devError })}\n\n`,
							)
						}
						this.#sseClients.add(res)
						req.on('close', () => this.#sseClients.delete(res))
						return
					}
					res.writeHead(200, {
						'Content-Type': 'text/html',
						'X-Wunphile-Reload': String(this.#lastReload),
						'Content-Length': 5,
					})
					res.write('...')
					req.on('close', () => {
						const idx = waitResponses.indexOf(res)
						if (idx !== -1) {
							waitResponses.splice(idx, 1)
						}
					})
					waitResponses.push(res)
					return
				}
				if (basePath === '/manifest.json') {
					await sendContent(res, req, {
						body: JSON.stringify(this.manifest(), null, 2) + '\n',
						mime: mimeForExt('json'),
					})
					return
				}
				// #12: real HTTP redirects in development mode.
				const redirect = this.#redirects.get(basePath)
				if (redirect != null) {
					res.writeHead(redirect.status, {
						Location: redirect.to,
						'Cache-Control': 'no-store',
					})
					res.end()
					return
				}
				if (this.#ogImages.has(basePath)) {
					await sendContent(res, req, {
						body: /** @type {Buffer} */ (this.#ogImages.get(basePath)),
						mime: basePath.endsWith('.png')
							? mimeForExt('png')
							: mimeForExt('svg'),
					})
					return
				}
				// #1/#2: assets (including fingerprinted URLs and CSS rewrites).
				const asset = this.#assets.get(basePath)
				if (asset != null) {
					/** @type {Record<string, string>} */
					const headers = {
						...(asset.headers ?? {}),
						...(asset.hashed
							? { 'Cache-Control': 'public, max-age=31536000, immutable' }
							: {}),
					}
					if (asset.content != null) {
						await sendContent(res, req, {
							body: asset.content,
							mime: asset.mime,
							headers,
						})
						return
					}
					if (asset.stat?.isFile()) {
						await sendContent(res, req, {
							filePath: asset.sourcePath,
							stat: asset.stat,
							mime: asset.mime,
							headers,
						})
						return
					}
				}
				/** @type {string[]} */
				let paths
				if (basePath.endsWith('/')) {
					paths = [basePath + 'index.html']
				} else {
					paths = [basePath, basePath + '/index.html']
				}
				/**
				 * Boundary-aware static prefix matching (BUG 6 FIX).
				 * @param {string} path
				 * @param {string} staticPath
				 * @returns {boolean}
				 */
				const matchesStaticPrefix = (path, staticPath) => {
					if (path === staticPath) {
						return true
					}
					const prefixWithSlash = staticPath.endsWith('/')
						? staticPath
						: staticPath + '/'
					return path.startsWith(prefixWithSlash)
				}
				/**
				 * @param {string} path
				 * @param {number} [status=200]
				 * @returns {Promise<boolean>}
				 */
				const tryPath = async (path, status = 200) => {
					const mime = pathToMime(path)
					const component = this.#pageMapping.get(path)
					if (component !== undefined) {
						// #17: cache rendered pages by (path, lastReload).
						const cacheKey = `${path}|${this.#lastReload}`
						const cached = this.#devRenderCache.get(path)
						let htmlStr = cached?.key === cacheKey ? cached.html : null
						if (htmlStr == null) {
							htmlStr =
								this.#preRenderedContent.get(path) ??
								(await this.#renderPage(
									path,
									component,
									this.#makeContext(path, {}, null, null),
								))
							this.#devRenderCache.set(path, { key: cacheKey, html: htmlStr })
						}
						// #33: development-mode accessibility checks.
						if (mime.startsWith('text/html')) {
							const warnings = checkAccessibility(htmlStr)
							if (warnings.length > 0) {
								this.#devWarnings = warnings.map((w) => `${path}: ${w}`)
								this.#broadcastDev('wfwarn', {
									path,
									warnings: this.#devWarnings,
								})
							}
						}
						const body =
							htmlStr +
							(mime.startsWith('text/html')
								? this.#devTrailer(devEmitter !== null, injectEnabled)
								: '')
						await sendContent(res, req, {
							body,
							mime,
							status,
							etag: `W/"${this.#lastReload}-${contentHash(body)}"`,
						})
						return true
					}
					// #35: decode and validate static paths before opening files.
					for (const [staticPath, dirPath] of this.#staticDirMappings) {
						if (!matchesStaticPrefix(path, staticPath)) {
							continue
						}
						let relative
						try {
							relative = decodeURIComponent(
								path.substring(staticPath.length),
							).replace(/^\/+/, '')
						} catch {
							return false
						}
						if (relative.includes('\u0000')) {
							return false
						}
						const baseDir = pathUtil.resolve(this.toProjectPath(dirPath))
						const fsPath = pathUtil.resolve(baseDir, relative)
						const boundary = pathUtil.relative(baseDir, fsPath)
						if (
							boundary === '..' ||
							boundary.startsWith('..' + pathUtil.sep) ||
							pathUtil.isAbsolute(boundary)
						) {
							console.warn(
								`[wunphile] blocked path traversal attempt: ${path}`,
							)
							return false
						}
						const stat = await statOrNull(fsPath)
						if (stat?.isFile()) {
							await sendContent(res, req, {
								filePath: fsPath,
								stat,
								mime,
							})
							return true
						}
					}
					for (const [staticPath, filePath] of this.#staticFileMappings) {
						if (path !== staticPath) {
							continue
						}
						const fsPath = this.toProjectPath(filePath)
						const stat = await statOrNull(fsPath)
						if (stat?.isFile()) {
							await sendContent(res, req, {
								filePath: fsPath,
								stat,
								mime,
							})
							return true
						}
					}
					return false
				}
				for (const path of paths) {
					if (await tryPath(path)) {
						return
					}
				}
				if (!(await tryPath(this.#notFoundPath, 404))) {
					res.writeHead(404, { 'Content-Type': 'text/plain' })
					res.write('Not Found')
					res.end()
				}
			} catch (err) {
				console.error('[wunphile] dev server error:', err)
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'text/plain' })
				}
				res.end('Internal Server Error')
			}
		})
		await new Promise((resolve) => {
			server.listen(port, host, () => resolve(undefined))
		})
		console.log(`Serving on http://${host}:${port}`)
		/** @type {DevHandle} */
		const handle = {
			server,
			close: () =>
				new Promise((resolve) => {
					for (const client of this.#sseClients) {
						try {
							client.end()
						} catch {}
					}
					this.#sseClients.clear()
					for (const watcher of this.#watchers) {
						try {
							watcher.close()
						} catch {}
					}
					this.#watchers.length = 0
					server.close(() => resolve())
				}),
		}
		if (options.signal) {
			options.signal.addEventListener(
				'abort',
				() => {
					void handle.close()
				},
				{ once: true },
			)
		}
		return handle
	}
	/**
	 * Serves the built `dist` directory as a pure static server, without
	 * requiring any `#pageMapping` (#27). Supports ETag/304, Range and
	 * precompressed `.br`/`.gz` artifacts.
	 *
	 * @param {number} [port=3000]
	 * @param {string} [host='127.0.0.1']
	 * @param {{ signal?: AbortSignal }} [options]
	 * @returns {Promise<DevHandle>}
	 */
	async preview(port = 3000, host = '127.0.0.1', options = {}) {
		const http = await import('node:http')
		const extToMime = (await this.#loadExtToMime()) ?? new Map()
		/**
		 * @param {string} path
		 * @returns {string}
		 */
		const pathToMime = (path) => {
			const dotIdx = path.lastIndexOf('.')
			if (dotIdx === -1) {
				return 'application/octet-stream'
			}
			const ext = path.substring(dotIdx + 1).toLowerCase()
			return extToMime.get(ext) ?? mimeForExt(ext)
		}
		const server = http.createServer(async (req, res) => {
			try {
				const url = new URL(
					/** @type {string} */ (req.url),
					'http://localhost',
				)
				let pathname = url.pathname
				if (
					this.#base !== '' &&
					(pathname === this.#base || pathname.startsWith(this.#base + '/'))
				) {
					pathname = pathname.slice(this.#base.length) || '/'
				}
				const candidates = pathname.endsWith('/')
					? [pathname + 'index.html']
					: [pathname, pathname + '/index.html']
				for (const candidate of candidates) {
					let relative
					try {
						relative = decodeURIComponent(candidate).replace(/^\/+/, '')
					} catch {
						continue
					}
					const fsPath = pathUtil.resolve(this.#outputPath, relative)
					const boundary = pathUtil.relative(this.#outputPath, fsPath)
					if (
						boundary === '..' ||
						boundary.startsWith('..' + pathUtil.sep) ||
						pathUtil.isAbsolute(boundary)
					) {
						continue
					}
					const stat = await statOrNull(fsPath)
					if (!stat?.isFile()) {
						continue
					}
					const mime = pathToMime(candidate)
					// Prefer precompressed artifacts when available (#3).
					const accept = String(req.headers['accept-encoding'] ?? '')
					for (const [ext, encoding] of [
						['.br', 'br'],
						['.gz', 'gzip'],
					]) {
						if (!accept.includes(encoding)) {
							continue
						}
						const preStat = await statOrNull(fsPath + ext)
						if (preStat?.isFile()) {
							const body = await fs.readFile(fsPath + ext)
							res.writeHead(200, {
								'Content-Type': mime,
								'Content-Encoding': encoding,
								'Content-Length': String(body.length),
								Vary: 'Accept-Encoding',
								'Accept-Ranges': 'bytes',
							})
							res.end(req.method === 'HEAD' ? undefined : body)
							return
						}
					}
					await sendContent(res, req, {
						filePath: fsPath,
						stat,
						mime,
					})
					return
				}
				const notFound = pathUtil.resolve(
					this.#outputPath,
					this.#notFoundPath.replace(/^\/+/, ''),
				)
				const stat = await statOrNull(notFound)
				if (stat?.isFile()) {
					await sendContent(res, req, {
						filePath: notFound,
						stat,
						mime: mimeForExt('html'),
						status: 404,
					})
				} else {
					res.writeHead(404, { 'Content-Type': 'text/plain' })
					res.end('Not Found')
				}
			} catch (err) {
				console.error('[wunphile] preview server error:', err)
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'text/plain' })
				}
				res.end('Internal Server Error')
			}
		})
		await new Promise((resolve) => {
			server.listen(port, host, () => resolve(undefined))
		})
		console.log(
			`Previewing ${this.#outputPath} on http://${host}:${port}`,
		)
		/** @type {DevHandle} */
		const handle = {
			server,
			close: () =>
				new Promise((resolve) => server.close(() => resolve())),
		}
		if (options.signal) {
			options.signal.addEventListener(
				'abort',
				() => {
					void handle.close()
				},
				{ once: true },
			)
		}
		return handle
	}
	/**
	 * Runs the site generator CLI.
	 *
	 * @param {string[] | string} [argv] Arguments (defaults to `process.argv`)
	 * @returns {Promise<any>}
	 */
	async cli(argv = process.argv.slice(2, process.argv.length)) {
		if (!isMainThread) {
			return
		}
		const args = Array.isArray(argv)
			? argv
			: String(argv).trim().split(/\s+/).filter(Boolean)
		if (args.includes('--help') || args.includes('-h')) {
			console.log(
				`Usage: ${process.argv[1]} [command] [options]
Commands / options:
  (none), --build, -b   Build the site (default action).
  --dev, -d             Start the development server with hot reloading.
  --preview             Serve the built output directory as a static server.
  --watch               Rebuild on changes without starting an HTTP server.
  --stats               Write dist/build-stats.json.
  --incremental         Use .wunphile/cache.json to skip unchanged pages.
  --precompress         Write .gz and .br variants of text assets.
  --quiet               Suppress the build report.
  --port <n>            Development/preview port (default 3000).
  --host <host>         Development/preview host (default 127.0.0.1).
  --help, -h            Show this help message.
Environment variables (WUNPHILE_* aliases take precedence):
  SSG_ROOT_PATH / WUNPHILE_ROOT_PATH
  SSG_OUTPUT_PATH / WUNPHILE_OUTPUT_PATH
  SSG_NOT_FOUND_PATH / WUNPHILE_NOT_FOUND_PATH
  SSG_DEV_PORT / WUNPHILE_DEV_PORT
  SSG_DEV_HOST / WUNPHILE_DEV_HOST
  SSG_DEV_NO_HOT_RELOAD / WUNPHILE_DEV_NO_HOT_RELOAD
  SSG_DEV_NO_INJECT / WUNPHILE_DEV_NO_INJECT`.trim(),
			)
			return
		}
		await this.#clientManager.waitForModules()
		/**
		 * @param {string} name
		 * @returns {string | null}
		 */
		const argValue = (name) => {
			const inline = args.find((arg) => arg.startsWith(name + '='))
			if (inline) {
				return inline.slice(name.length + 1)
			}
			const idx = args.indexOf(name)
			return idx === -1 ? null : (args[idx + 1] ?? null)
		}
		const httpPort = parseInt(
			readEnv(DEV_PORT_ENV_VAR) || argValue('--port') || '3000',
			10,
		)
		const httpHost =
			readEnv(DEV_HOST_ENV_VAR) || argValue('--host') || '127.0.0.1'
		if (isNaN(httpPort)) {
			console.error(
				`Invalid port specified in ${DEV_PORT_ENV_VAR} environment variable: ${readEnv(DEV_PORT_ENV_VAR)}`,
			)
			process.exit(1)
		}
		/** @type {BuildOptions} */
		const buildOpts = { ...this.#buildOptions }
		if (args.includes('--stats')) {
			buildOpts.stats = true
		}
		if (args.includes('--incremental')) {
			buildOpts.incremental = true
		}
		if (args.includes('--quiet')) {
			buildOpts.quiet = true
		}
		if (args.includes('--precompress')) {
			buildOpts.precompress = ['gzip', 'br']
		}
		if (args.includes('--preview')) {
			return this.preview(httpPort, httpHost)
		}
		if (args.includes('--dev') || args.includes('-d')) {
			/** @type {EventEmitter<{ reload: [] }> | null} */
			let hrEmitter = null
			if (
				isWorkerApiSupported &&
				readEnv(DEV_NO_HOT_RELOAD_ENV_VAR) !== '1'
			) {
				hrEmitter = new EventEmitter()
				this.#watchHotReload(hrEmitter)
			}
			return this.serve(httpPort, httpHost, hrEmitter)
		}
		if (args.includes('--watch')) {
			await this.build(buildOpts)
			this.#watchBuild(buildOpts)
			return
		}
		const now = Date.now()
		await this.build(buildOpts)
		console.log(`Built site in ${Date.now() - now}ms`)
	}
}
/**
 * Render fragment types. `HEAD` is collected during rendering and injected
 * into `<head>` instead of being emitted inline (#7).
 * @type {Record<string, RenderFragmentEnum>}
 */
export const RenderFragmentType = {
	TEXT: 0,
	HTML: 1,
	BEHAVIOR_MODULE: 2,
	BEHAVIOR_MODULE_LOADER: 3,
	HEAD: 4,
}
// REFACTOR: Public compatibility alias; must be the exact same class object.
/**
 * Backward-compatible alias for the Wunphile class.
 *
 * `SSG` is the legacy name kept so that existing code importing it
 * continues to work. It refers to exactly the same class as {@link Wunphile}.
 * New code must use `Wunphile` directly; this alias is deprecated and may be
 * removed in a future major release.
 *
 * @type {typeof Wunphile}
 */
export const SSG = Wunphile
/**
 * A render fragment is a string that can be rendered to HTML.
 */
export class RenderFragment {
	/**
	 * Creates render fragments from the provided value.
	 * @param {any} val The value to convert
	 * @returns {RenderFragments} The resulting render fragments
	 */
	static from(val) {
		/** @type {RenderFragments} */
		const res = []
		if (val instanceof RenderFragment) {
			res.push(val)
		} else if (val instanceof Array) {
			for (const elem of val) {
				res.push(...RenderFragment.from(elem))
			}
		} else {
			res.push(new RenderFragment(RenderFragmentType.TEXT, String(val)))
		}
		return res
	}
	/** @type {RenderFragmentEnum} */
	type
	/** @type {string} */
	value
	/** @type {Promise<any> | null} */
	behaviorModulePromise
	/** @type {Record<string, any> | null} Structured payload for HEAD/behavior fragments. */
	meta
	/**
	 * @param {RenderFragmentEnum} type
	 * @param {string} value
	 * @param {Promise<any> | null} [behaviorModulePromise]
	 * @param {Record<string, any> | null} [meta]
	 */
	constructor(type, value, behaviorModulePromise = null, meta = null) {
		this.type = type
		this.value = value
		this.behaviorModulePromise = behaviorModulePromise
		this.meta = meta
	}
	// FIX #1: Restore the missing instance method. #renderToHtmlAsync() and
	// renderToHtml() both call fragment.toHtml(), so without it every page
	// render throws `TypeError: fragment.toHtml is not a function`.
	/**
	 * Renders the fragment to HTML.
	 * @returns {string}
	 */
	toHtml() {
		switch (this.type) {
			case RenderFragmentType.TEXT:
				return sanitizeHtml(this.value)
			case RenderFragmentType.HTML:
				return this.value
			case RenderFragmentType.BEHAVIOR_MODULE:
			case RenderFragmentType.BEHAVIOR_MODULE_LOADER:
			case RenderFragmentType.HEAD:
				// Behavior modules and Head fragments are not rendered inline.
				// They are collected separately by #renderToHtmlAsync.
				return ''
			default:
				throw new Error(
					`Unknown fragment type: ${this.type}. Valid types are contained in the RenderFragmentType enum.`,
				)
		}
	}
}
/**
 * Template string function that takes in HTML and interpolates it with the provided values.
 * @param {string|TemplateStringsArray} strs
 * @param {any[]} vals
 * @returns {RenderFragments}
 */
export function html(strs, ...vals) {
	/** @type {RenderFragments} */
	const res = []
	const strsProc = typeof strs === 'string' ? [strs] : strs
	for (let i = 0; i < strsProc.length; i++) {
		const str = strsProc[i]
		if (str !== '') {
			res.push(new RenderFragment(RenderFragmentType.HTML, str))
		}
		if (i < vals.length) {
			res.push(...RenderFragment.from(vals[i]))
		}
	}
	return res
}
/**
 * Generates a plain text render fragment from a raw string.
 * @param {string|TemplateStringsArray} strs
 * @param {any[]} vals
 * @returns {RenderFragments}
 */
export function text(strs, ...vals) {
	if (typeof strs === 'string') {
		return RenderFragment.from(strs)
	}
	return RenderFragment.from(String.raw(strs, ...vals))
}
/**
 * Component that renders the behavior module loader.
 * @type {Component<void, void>}
 */
export const BehaviorLoader = () => {
	return [new RenderFragment(RenderFragmentType.BEHAVIOR_MODULE_LOADER, '')]
}
/**
 * @typedef BehaviorModuleProps
 * @property {Promise<{ default: BehaviorModule }>} module
 * @property {LoadStrategy} [load] Hydration strategy (#20): eager/visible/idle/interaction.
 */
/**
 * Wraps a component in a behavior.
 * @param {BehaviorModuleProps} props
 * @param {RenderFragments} children
 * @returns {RenderFragments}
 */
export const BehaviorComponent = (props, children) => {
	return [
		new RenderFragment(
			RenderFragmentType.BEHAVIOR_MODULE,
			'',
			props.module,
			props.load ? { load: props.load } : null,
		),
		...children,
	]
}
/**
 * Declares head metadata for a page (#7/#30).
 *
 * All `Head` fragments in a page (and in its layout) are merged and injected
 * into `<head>` during rendering. `title`, `description`, `canonical`,
 * `meta`, `og`, `links`, `jsonLd` and `image` are supported. With a sitemap
 * base URL, canonical and hreflang tags are added automatically.
 *
 * @param {Record<string, any>} props
 * @returns {RenderFragments}
 */
export function Head(props) {
	return [
		new RenderFragment(
			RenderFragmentType.HEAD,
			JSON.stringify(props ?? {}),
			null,
			props ?? {},
		),
	]
}
/**
 * Identity helper providing typed autocomplete for the single config object
 * (#26). All existing chained methods remain valid.
 *
 * @example
 * const wunphile = new Wunphile(import.meta.url, defineConfig({
 *   outDir: 'dist', baseUrl: 'https://example.com', plugins: [myPlugin],
 * }))
 *
 * @param {WunphileConfig} config
 * @returns {WunphileConfig}
 */
export function defineConfig(config) {
	return config
}
/**
 * Renders the provided render fragments to HTML.
 * @param {RenderFragments} fragments
 * @returns {string}
 */
export function renderToHtml(fragments) {
	/** @type {string[]} */
	const res = []
	for (const fragment of fragments) {
		res.push(fragment.toHtml())
	}
	return res.join('')
}
/**
 * Returns the stats of the specified path, or null if the path doesn't exist.
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats|null>}
 */
async function statOrNull(path) {
	try {
		return await fs.stat(path)
	} catch (/** @type {any} */ err) {
		if (err.code === 'ENOENT') {
			return null
		} else {
			throw err
		}
	}
}
/**
 * Copies a directory recursively.
 * @param {string} source
 * @param {string} target
 * @returns {Promise<void>}
 */
export async function copyRecursive(source, target) {
	if (!(await fs.stat(source)).isDirectory()) {
		await fs.copyFile(source, target)
		return
	}
	let targetStat = await statOrNull(target)
	if (targetStat === null) {
		await fs.mkdir(target, { recursive: true })
		targetStat = await fs.stat(target)
	}
	if (!targetStat.isDirectory()) {
		throw new Error(
			`Cannot copy from source ${source} to non-directory target ${target}`,
		)
	}
	const paths = ['']
	while (paths.length > 0) {
		const path = /** @type {string} */ (paths.shift())
		const files = await fs.readdir(pathUtil.join(source, path))
		for (const file of files) {
			const childPath = pathUtil.join(path, file)
			const realPath = pathUtil.join(source, childPath)
			const targetPath = pathUtil.join(target, childPath)
			if ((await fs.stat(realPath)).isDirectory()) {
				await fs.mkdir(targetPath, { recursive: true })
				paths.push(childPath)
			} else {
				await fs.copyFile(realPath, targetPath)
			}
		}
	}
}
const htmlEntityRegex = /[&<>"']/
/**
 * Escapes HTML entities (`& < > " '`) in a string.
 *
 * IMPORTANT (#37): this is *entity escaping*, not an HTML sanitizer. It makes
 * untrusted text safe to interpolate into HTML, but it does NOT validate URLs,
 * strip tags or make pasted rich text safe. Use {@link escapeAttribute} for
 * attribute values and {@link stripHtml} for plain-text summaries (e.g. RSS).
 *
 * @param {string} html
 * @returns {string}
 * @since 1.0.0
 */
export function sanitizeHtml(html) {
	const match = htmlEntityRegex.exec(html)
	if (match === null) {
		return html
	}
	let index = 0
	let lastIndex = 0
	let out = ''
	let escape = ''
	for (index = match.index; index < html.length; index++) {
		switch (html.charCodeAt(index)) {
			case 34: escape = '&quot;'; break
			case 38: escape = '&amp;'; break
			case 39: escape = '&#39;'; break
			case 60: escape = '&lt;'; break
			case 62: escape = '&gt;'; break
			default: continue
		}
		if (lastIndex !== index) {
			out += html.substring(lastIndex, index)
		}
		lastIndex = index + 1
		out += escape
	}
	if (lastIndex !== index) {
		return out + html.substring(lastIndex)
	}
	return out
}
