import process from 'node:process'
// FIX #2: pathToFileURL is required to turn Windows absolute paths
// ("D:\...") into file: URLs before passing them to dynamic import().
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
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
     * @typedef {{ type: 'plain' } | { type: 'behavior', rewrittenContent: string, rewrittenPath: string }} LoadedModule
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
			this.#wunphile.staticFile(
				CLIENT_MOUNT_PREFIX + relativePath,
				pathUtil.relative(this.#getProjectRootPath(), modPath),
			)
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
			})
			this.#wunphile.pageRaw(CLIENT_MOUNT_PREFIX + rewrittenPath, out)
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
	 * The script is a JS module that imports the scripts on the browser.
	 * The scripts can also be preloaded, but this function only generates the loader JavaScript, not the HTML script tag for it.
	 *
	 * BUG 2 FIX: Previously, the import statements were concatenated with no
	 * separator. Without a line terminator, ASI does not apply and the browser
	 * reports a SyntaxError. We now join with `;\n`.
	 *
	 * Additionally, paths are now embedded with `JSON.stringify()` so any
	 * special characters are safely escaped inside the JS string literal
	 * (defense-in-depth against issue #3).
	 *
	 * @param {string[]} rewrittenRelativePaths The rewritten relative paths to behavior modules (POSIX-style)
	 * @returns {string} The loader script
	 */
	generateLoaderScript(rewrittenRelativePaths) {
		if (rewrittenRelativePaths.length === 0) {
			return ''
		}
		// Dedupe: N usages of the same module should produce a single import.
		const paths = /** @type {Set<string>} */ (
			new Set(rewrittenRelativePaths.map(toPosixPath))
		)
		const hydrateScript = `
function hydrate(mod, path) {
    const comment = ${JSON.stringify(CLIENT_BEHAVIOR_HYDRATE_PREFIX)} + path
    
    const treeWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT)
    let node
    while ((node = treeWalker.nextNode())) {
        if (node.nodeType === Node.COMMENT_NODE && node.textContent === comment) {
            // Find next element.
            let elem
            let nextNode = node
            while ((nextNode = treeWalker.nextNode())) {
                if (nextNode.nodeType === Node.ELEMENT_NODE) {
                    elem = nextNode
                    break												break
                }
                }
            
            if (elem) {
                mod.behavior(elem)
            }
        }
    }
}
        `.trim()
		// BUG 2 FIX: Join statements with ';\n' so ASI is not relied upon.
		// Use JSON.stringify for safe embedding in a JS string literal.
		const stmts = []
		for (const path of paths) {
			stmts.push(
				`import(${JSON.stringify(CLIENT_MOUNT_PREFIX + path)}).then(mod => hydrate(mod.default, ${JSON.stringify(path)}))`,
			)
		}
		return hydrateScript + '\n' + stmts.join(';\n')
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
	 * @param {string} [clientDir='./src/client'] The path to the client directory. Client behaviors must be within this directory.
	 *
	 * Used to resolve the root path and for identifying the main module for hot reloading.
	 */
	constructor(importMetaUrl, clientDir = './src/client') {
		const mainModulePath = fileURLToPath(importMetaUrl)
		// FIX #10: Supply the project root resolver; #rootPath is assigned
		// just below, so a lazy getter is used instead of a snapshot.
		this.#clientManager = new ClientManager(
			this,
			pathUtil.join(pathUtil.dirname(mainModulePath), clientDir),
			() => this.#rootPath,
		)
		if (isMainThread) {
			// Resolve paths
			this.#mainModulePath = mainModulePath
			this.#rootPath = pathUtil.resolve(
				process.env[ROOT_PATH_ENV_VAR] ||
					pathUtil.dirname(fileURLToPath(importMetaUrl)),
			)
			this.#outputPath = pathUtil.resolve(
				process.env[OUTPUT_PATH_ENV_VAR] ||
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
			const nfRaw = process.env[NOT_FOUND_PATH_ENV_VAR] || '/404.html'
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
	 * Loads all behavior modules and injects loaders.
	 * @param {RenderFragments} fragments The render fragments to render
	 * @returns {Promise<string>} The rendered HTML
	 */
	async #renderToHtmlAsync(fragments) {
		/**
		 * Mapping of fragment indexes to their behavior module promises.
		 * @type {Map<number, Promise<{ default: BehaviorModule }>>}
		 */
		const fragProms = new Map()
		for (let i = 0; i < fragments.length; i++) {
			const fragment = fragments[i]
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
		/**
		 * Mapping of fragment indexes to their loaded behavior modules.
		 * Values are behavior modules' rewritten paths, relative to the client root (POSIX-style).
		 * @type {Map<number, string>}
		 */
		const fragMods = new Map()
		for (const [i, prom] of fragProms.entries()) {
			const mod = /** @type {BehaviorModule} */ ((await prom).default)
			// BUG 3 FIX: Normalize to POSIX so the key matches what was stored
			// by #loadModule (which now also stores POSIX-normalized keys).
			const relativePath = relPosix(
				this.#clientManager.rootPath,
				fileURLToPath(mod.behaviorModuleUrl),
			)
			const info = this.#clientManager.loadedModules.get(relativePath)
			if (info?.type !== 'behavior') {
				throw new Error(
					`Supposed behavior module "${relativePath}" is not a behavior module.`,
				)
			}
			fragMods.set(i, info.rewrittenPath)
		}
		/** @type {string[]} */
		const res = []
		for (let i = 0; i < fragments.length; i++) {
			const fragment = fragments[i]
			if (fragment.type === RenderFragmentType.BEHAVIOR_MODULE) {
				const relativePath = /** @type {string} */ (fragMods.get(i))
				// We add a hydration comment that will be used by the loader to find components to apply behaviors to.
				res.push(
					`<!--${CLIENT_BEHAVIOR_HYDRATE_PREFIX}${relativePath}-->`,
				)
			} else if (
				fragment.type === RenderFragmentType.BEHAVIOR_MODULE_LOADER
			) {
				if (fragMods.size !== 0) {
					res.push(
						`<script type="module">\n${this.#clientManager.generateLoaderScript([...fragMods.values()])}\n</script>`,
					)
				}
			} else {
				res.push(fragment.toHtml())
			}
		}
		return res.join('')
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
	 * @param {string} path The page's path
	 * @param {Component<void, void>} component The page's component
	 */
	page(path, component) {
		if (!path.startsWith('/')) {
			throw new Error(
				`Page path must start with a forward slash, but got "${path}"`,
			)
		}
		if (isMainThread) {
			this.#pageMapping.set(path, component)
		} else {
			// FIX #12: Without a rejection handler, a failed render became an
			// unhandled rejection inside the worker and the main thread kept
			// treating the reload as successful. Report it as pageError.
			this.#renderToHtmlAsync(component())
				.then((content) => {
					parentPort.postMessage({
						type: 'pageRaw',
						path,
						content,
					})
				})
				.catch((err) => {
					parentPort.postMessage({
						type: 'pageError',
						path,
						error:
							err instanceof Error
								? err.stack || err.message
								: String(err),
					})
				})
		}
	}
	/**
	 * Registers raw content to a page path.
	 * @param {string} path The page's path
	 * @param {string} content The page's content
	 */
	pageRaw(path, content) {
		this.page(path, () => html(content))
	}
	/**
	 * Registers a redirect from one path to another.
	 * @param {string} path The path to redirect from
	 * @param {string} url The URL/path to redirect to
	 */
	redirect(path, url) {
		// FIX #8: Remember redirect paths so #buildSitemap() can omit them.
		this.#redirectPaths.add(path)
		// FIX #3: Build a single HTML fragment holding the JSON string literal.
		// JSON.stringify() output is already a valid, escaped JS literal, so
		// the generated <script> body parses as JavaScript; interpolating an
		// array of RenderFragments here is never safe.
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
        <title>Redirecting to ${url}...</title>
    </head>
    <body>
        Redirecting to <a href="${url}">${url}</a>... (click link if nothing happens)
        <meta http-equiv="refresh" content="0; url=${url}" />
        <script>location.assign(${new RenderFragment(RenderFragmentType.HTML, JSON.stringify(url))})</script>
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
	 */
	staticDir(path, dir) {
		if (!path.startsWith('/')) {
			throw new Error(
				`Static directory path must start with a forward slash, but got "${path}"`,
			)
		}
		if (isMainThread) {
			this.#staticDirMappings.set(toPosixPath(path), dir)
		} else {
			parentPort.postMessage({
				type: 'staticDir',
				path,
				dir,
			})
		}
	}
	/**
	 * Registers a static file to a path.
	 * @param {string} path The path to the static file
	 * @param {string} file The file to copy
	 */
	staticFile(path, file) {
		if (!path.startsWith('/')) {
			throw new Error(
				`Static file path must start with a forward slash, but got "${path}"`,
			)
		}
		if (isMainThread) {
			this.#staticFileMappings.set(toPosixPath(path), file)
		} else {
			parentPort.postMessage({
				type: 'staticFile',
				path,
				file,
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
		// Protect <pre>, <textarea>, <script>, <style> from whitespace collapsing.
		const protectedRe =
			/(<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\2>)/gi
		const placeholders = []
		const masked = htmlStr.replace(protectedRe, (match) => {
			placeholders.push(match)
			return `\u0000${placeholders.length - 1}\u0000`
		})
		let out = masked
			// Remove HTML comments, but preserve conditional comments (<!--[if ...]> ... <![endif]-->).
			// FIX #4: Also preserve <!--wf-behavior:...--> hydration markers,
			// otherwise minifyHtml() silently disables every client behavior.
			.replace(/<!--(?!\[if|wf-behavior:)[\s\S]*?-->/g, '')
			// Collapse whitespace between tags.
			// FIX #13: No global /\s{2,}/ -> ' ' pass; it collapsed repeated
			// spaces inside ordinary text nodes and broke space-sensitive
			// inline content, contrary to "conservative minify".
			.replace(/>\s+</g, '><')
			.trim()
		// Restore protected blocks.
		out = out.replace(/\u0000(\d+)\u0000/g, (_, idx) =>
			placeholders[Number(idx)],
		)
		return out
	}
	/**
	 * Builds the sitemap.xml content from registered pages.
	 * Excludes the client mount prefix, redirects, and the not-found page.
	 *
	 * NEW FEATURE.
	 *
	 * @returns {string} The sitemap.xml content
	 */
	#buildSitemap() {
		if (this.#sitemapBaseUrl == null) {
			return ''
		}
		const excludedPrefixes = [CLIENT_MOUNT_PREFIX]
		// FIX #8: redirect() pages are registered through page(), so they
		// must be filtered out explicitly along with the not-found page.
		const excludePaths = new Set([
			this.#notFoundPath,
			...this.#redirectPaths,
		])
		const entries = []
		for (const path of this.#pageMapping.keys()) {
			if (excludedPrefixes.some((p) => path.startsWith(p))) {
				continue
			}
			if (excludePaths.has(path)) {
				continue
			}
			entries.push(this.#sitemapBaseUrl + path)
		}
		entries.sort()
		const xmlEntries = entries
			.map(
				(url) =>
					`  <url>\n    <loc>${sanitizeHtml(url)}</loc>\n  </url>`,
			)
			.join('\n')
		return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xmlEntries}\n</urlset>\n`
	}
	/**
	 * Builds the site only.
	 * This method will clear the output directory before building.
	 *
	 * The order in which paths are processed is as follows:
	 *  1. Static directories
	 *  2. Static files
	 *  3. Pages
	 *  4. Sitemap (if enabled)
	 *
	 * @returns {Promise<void>}
	 */
	async build() {
		if (!isMainThread) {
			console.warn(
				'The build() method was manually called in a hot reload thread. This is not supported, so the hot reload thread will exit.',
			)
			process.exit(0)
		}
		if ((await statOrNull(this.#outputPath)) === null) {
			await fs.mkdir(this.#outputPath, { recursive: true })
		} else {
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
		// Static dirs first.
		for (const [dest, src] of this.#staticDirMappings) {
			await copyRecursive(
				this.toProjectPath(src),
				this.toOutputPath(dest),
			)
		}
		// Static files next.
		for (const [dest, src] of this.#staticFileMappings) {
			const outPath = this.toOutputPath(dest)
			const outDir = pathUtil.dirname(outPath)
			await fs.mkdir(outDir, { recursive: true })
			await fs.copyFile(this.toProjectPath(src), outPath)
		}
		// Pages last.
		for (const [dest, component] of this.#pageMapping) {
			const dir = pathUtil.dirname(pathUtil.join(this.#outputPath, dest))
			if ((await statOrNull(dir)) === null) {
				await fs.mkdir(dir, { recursive: true })
			}
			let content = await this.#renderToHtmlAsync(component())
			// NEW FEATURE: Apply HTML minification if enabled.
			if (this.#minifyHtml) {
				content = this.#minifyHtmlString(content)
			}
			await fs.writeFile(
				pathUtil.join(this.#outputPath, dest),
				content,
			)
		}
		// NEW FEATURE: Generate sitemap.xml if enabled.
		if (this.#sitemapBaseUrl != null && this.#sitemapPath != null) {
			const sitemapContent = this.#buildSitemap()
			const sitemapOutPath = this.toOutputPath(this.#sitemapPath)
			const sitemapDir = pathUtil.dirname(sitemapOutPath)
			if ((await statOrNull(sitemapDir)) === null) {
				await fs.mkdir(sitemapDir, { recursive: true })
			}
			await fs.writeFile(sitemapOutPath, sitemapContent)
			// FIX #8: Log the number of URLs actually written, not the number
			// of registered pages (which also counts client mounts, redirects
			// and the not-found page). Every entry is emitted as one <url>.
			const writtenEntries = (sitemapContent.match(/<url>/g) ?? []).length
			console.log(
				`Generated sitemap at ${this.#sitemapPath} with ${writtenEntries} URLs`,
			)
		}
	}
	/**
	 * Serves the site on a local HTTP server.
	 *
	 * @param {number} port The port to listen on
	 * @param {string} [host='127.0.0.1'] The host to listen on (optional, defaults to `127.0.0.1`)
	 * @param {EventEmitter<{ reload: [] }>|null} [hotReloadEventEmitter=null] The event emitter to emit hot reload events on
	 * @returns {Promise<void>}
	 */
	async serve(port, host = '127.0.0.1', hotReloadEventEmitter = null) {
		if (!isMainThread) {
			console.warn(
				'The serve() method was manually called in a hot reload thread. This is not supported, so the hot reload thread will exit.',
			)
			process.exit(0)
		}
		if (process.env[DEV_NO_INJECT_ENV_VAR] === '1') {
			hotReloadEventEmitter = null
		}
		const http = await import('node:http')
		const extToMime = await this.#loadExtToMime()
		if (extToMime === null) {
			console.error(
				'Could not resolve a MIME database to use development mode.',
			)
			console.error(
				`Please add the mime-db package to your NPM project or place a copy of mime-db's JSON database next to Wunphile as mime-db.json.`,
			)
			process.exit(1)
		}
		/**
		 * @param {string} path
		 * @returns {string}
		 */
		const pathToMime = (path) => {
			const def = 'application/octet-stream'
			const dotIdx = path.lastIndexOf('.')
			if (dotIdx === -1) {
				return def
			}
			return extToMime.get(path.substring(dotIdx + 1)) ?? def
		}
		// IMPROVEMENT (issue #9): Cache the trailer string once (per lastReload value)
		// instead of regenerating it for every HTML response.
		/** @type {Map<number, string>} */
		const trailerCache = new Map()
		const mkTrailer = () => {
			if (hotReloadEventEmitter === null) {
				return ''
			}
			const cached = trailerCache.get(this.#lastReload)
			if (cached !== undefined) {
				return cached
			}
			const trailer = `
<!-- Injected by Wunphile for development mode hot reloading -->
<script type="module">
if (!window.__wunphile_hotreload) {
	window.__wunphile_hotreload = true
	let abort
	let abortTimeout = 0
	while (true) {
		abort?.abort()
		clearTimeout(abort)
		abort = new AbortController()
		abortTimeout = setTimeout(() => abort.abort(), 1_000)
		try {
			const res = await fetch('/__hotreload', { signal: abort.signal })
			const rlTime = parseInt(res.headers.get('X-Wunphile-Reload')) || Number.MAX_SAFE_INTEGER
			if (rlTime <= ${this.#lastReload}) {
				await res.text()
			}
			window.location.reload()
		} catch (err) {
			if (!(err instanceof DOMException && err.name === 'AbortError')) {
				console.error('hot reload check failed, sleeping')
				await new Promise(res => setTimeout(res, 1_000))
			}
		}
	}
}
</script>`
			trailerCache.set(this.#lastReload, trailer)
			if (trailerCache.size > 10) {
				// Bounded cache; oldest entries are least-recently-used.
				const firstKey = trailerCache.keys().next().value
				if (firstKey !== undefined) {
					trailerCache.delete(firstKey)
				}
			}
			return trailer
		}
		/** @type {import('node:http').ServerResponse[]} */
		const waitResponses = []
		if (hotReloadEventEmitter != null) {
			hotReloadEventEmitter.on('reload', () => {
				this.#lastReload = Date.now()
				for (const res of waitResponses) {
					res.write('ok')
					res.end()
				}
				waitResponses.length = 0
			})
		}
		const server = http.createServer(async (req, res) => {
			const url = new URL(
				/** @type {string} */ (req.url),
				'http://localhost',
			)
			const basePath = url.pathname
			if (hotReloadEventEmitter !== null && basePath === '/__hotreload') {
				res.writeHead(200, {
					'Content-Type': 'text/html',
					'X-Wunphile-Reload': String(this.#lastReload),
					'Content-Length': 5,
				})
				res.write('...')
				res.req.on('close', () => {
					for (let i = 0; i < waitResponses.length; i++) {
						if (waitResponses[i] === res) {
							waitResponses.splice(i, 1)
							break
						}
					}
				})
				waitResponses.push(res)
				return
			}
			/** @type {string[]} */
			let paths
			if (basePath.endsWith('/')) {
				paths = [basePath + 'index.html']
			} else {
				paths = [basePath, basePath + '/index.html']
			}
			/**
			 * Matches a path against a static prefix, ensuring the path either
			 * equals the prefix or continues with a `/` boundary.
			 *
			 * BUG 6 FIX: Previously `path.startsWith(staticPath)` would let
			 * `/assetsEvil/x.js` incorrectly match the `/assets` prefix.
			 *
			 * @param {string} path The request path
			 * @param {string} staticPath The configured static mount prefix
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
				const pageMapping = this.#pageMapping.get(path)
				if (pageMapping !== undefined) {
					res.writeHead(status, { 'Content-Type': mime })
					res.write(await this.#renderToHtmlAsync(pageMapping()))
					if (mime === 'text/html') {
						console.log(`Serving ${path}`)
						res.write(mkTrailer())
					}
					res.end()
					return true
				}
				// Try static directories.
				for (const [staticPath, dirPath] of this.#staticDirMappings) {
					// BUG 6 FIX: Use boundary-aware matching.
					if (matchesStaticPrefix(path, staticPath)) {
						const fsPath = this.toProjectPath(
							pathUtil.join(
								dirPath,
								path.substring(staticPath.length),
							),
						)
						if ((await statOrNull(fsPath)) !== null) {
							await using file = await fs.open(fsPath, 'r')
							console.log(`Serving ${path}`)
							res.writeHead(200, { 'Content-Type': mime })
							try {
								await pipeline(file.createReadStream(), res)
							} catch {}
							res.end()
							return true
						}
					}
				}
				// Try static files.
				for (const [staticPath, filePath] of this.#staticFileMappings) {
					if (path === staticPath) {
						const fsPath = this.toProjectPath(filePath)
						if ((await statOrNull(fsPath)) !== null) {
							// FIX #11: Use pipeline() exactly like the static
							// directory branch. pipe() already ends the
							// response, so the extra res.end() inside the
							// promise could raise ERR_STREAM_WRITE_AFTER_END.
							await using file = await fs.open(fsPath, 'r')
							res.writeHead(200, { 'Content-Type': mime })
							try {
								await pipeline(file.createReadStream(), res)
							} catch {}
							res.end()
							return true
						}
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
		})
		server.listen(port, host, () => {
			console.log(`Serving on http://${host}:${port}`)
		})
	}
	/**
	 * Runs the site generator CLI.
	 *
	 * @returns {Promise<void>}
	 */
	async cli() {
		if (!isMainThread) {
			return
		}
		const args = process.argv.slice(2, process.argv.length)
		if (args.includes('--help') || args.includes('-h')) {
			console.log(
				`Usage: ${process.argv[1]} [options]
Options:
  --help, -h
    Show this help message.
  --build, -b
    Build the site (default action).
  --dev, -d
  	Start a development server.
  	Watches the project root directory for changes and hot reloads the site.
  	The project will be running in development mode.
Environment variables:
  SSG_ROOT_PATH
    The root path of the project.
    Defaults to the directory of the program main module.
  SSG_OUTPUT_PATH
    The output path of the generated site.
    Defaults to "dist" in the project root path.
  SSG_NOT_FOUND_PATH
    The path to use for the "not found" page.
    Defaults to "/404.html".
  SSG_DEV_PORT
  	The port to listen on for the development server.
    Defaults to 3000.
  SSG_DEV_HOST
    The host to listen on for the development server.
    Defaults to "127.0.0.1".
  SSG_DEV_NO_HOT_RELOAD
    If set to 1, disables hot reloading in development mode.
  SSG_DEV_NO_INJECT
  	If set to 1, disables injecting hot reload scripts into pages in development mode.
`.trim(),
			)
			return
		}
		await this.#clientManager.waitForModules()
		if (args.includes('--dev') || args.includes('-d')) {
			const httpPort = parseInt(process.env[DEV_PORT_ENV_VAR] || '3000')
			const httpHost = process.env[DEV_HOST_ENV_VAR] || '127.0.0.1'
			if (isNaN(httpPort)) {
				console.error(
					`Invalid port specified in ${DEV_PORT_ENV_VAR} environment variable: ${process.env[DEV_PORT_ENV_VAR]}`,
				)
				process.exit(1)
			}
			/** @type {EventEmitter<{ reload: [] }>|null} */
			let hrEmitter = null
			if (
				isWorkerApiSupported &&
				process.env[DEV_NO_HOT_RELOAD_ENV_VAR] !== '1'
			) {
				hrEmitter = new EventEmitter()
				let hasPendingReload = false
				console.log(
					`Development mode hot reloading enabled. Watching "${this.#rootPath}" for changes.`,
				)
				const oldFs = await import('node:fs')
				oldFs.watch(
					this.#rootPath,
					// FIX #7: fs.watch has no `ignored` option (that is a chokidar
					// API); it was silently ignored, so output writes caused
					// hot-reload loops. Filter in the callback instead.
					{ recursive: true, persistent: true },
					async (_eventType, filename) => {
						// FIX #7: A null filename means the platform did not report
						// one, so conservatively allow the reload in that case.
						if (filename != null) {
							const full = pathUtil.resolve(
								this.#rootPath,
								String(filename),
							)
							if (full.startsWith(this.#outputPath)) {
								return
							}
						}
						if (hasPendingReload) {
							return
						}
						hasPendingReload = true
						try {
							// Wait a little while to let writes finish.
							await new Promise((resolve) =>
								setTimeout(resolve, 50),
							)
							const worker = new Worker(this.#mainModulePath, {
								workerData: {
									rootPath: this.#rootPath,
									outputPath: this.#outputPath,
									notFoundPath: this.#notFoundPath,
								},
							})
							let gotError = false
							/** @type {Error | null} */
							let lastError = null
							/** @type {Map<string, Component<void, void>>} */
							const pageMapping = new Map()
							/** @type {Map<string, string>} */
							const staticDirMapping = new Map()
							/** @type {Map<string, string>} */
							const staticFileMapping = new Map()
							worker.on(
								'message',
								/** @type {(msg: any) => void} */ (
									(msg) => {
										switch (msg.type) {
											case 'pageRaw':
												pageMapping.set(msg.path, () =>
													html(msg.content),
												)
												break
											case 'staticDir':
												staticDirMapping.set(
													msg.path,
													msg.dir,
												)
												break
											case 'staticFile':
												staticFileMapping.set(
													msg.path,
													msg.file,
												)
												break
											// FIX #12: Merge worker-side render
											// failures into the existing gotError
											// path, so the old mapping is kept and
											// reload is still emitted only once.
											case 'pageError':
												gotError = true
												lastError = new Error(String(msg.error))
												console.error(
													`Error while rendering page "${msg.path}":\n${msg.error}`,
												)
												break
											}
									}
								),
							)
							worker.on('error', (err) => {
								gotError = true
								lastError = err
								// IMPROVEMENT: Print the full stack so users can
								// actually locate the source of the reload failure.
								console.error('Error while reloading:', err.stack || err)
							})
							// NEW: Capture unhandled rejections inside the worker
							// (e.g., from top-level await failures in user code).
							worker.on('messageerror', (err) => {
								gotError = true
								lastError = err
								console.error('Worker message error:', err.stack || err)
							})
							await new Promise((res) => worker.on('exit', res))
							if (!gotError) {
								this.#pageMapping = pageMapping
								this.#staticDirMappings = staticDirMapping
								this.#staticFileMappings = staticFileMapping
								console.log('Reloaded successfully.')
							} else {
								// NEW: Display a clearer user-facing hint.
								console.error(
									'Reload failed - keeping previous state. Fix the error and save again to retry.',
								)
							}
						} finally {
							hasPendingReload = false
						}
						// Always emit reload so browsers recheck, even on failure.
						// @ts-expect-error hrEmitter is assigned by now
						hrEmitter.emit('reload')
					},
				)
			}
			await this.serve(httpPort, httpHost, hrEmitter)
			return
		}
		const now = Date.now()
		await this.build()
		console.log(`Built site in ${Date.now() - now}ms`)
	}
}
/** @typedef {0 | 1 | 2 | 3} RenderFragmentEnum Render fragment types. */
/**
 * Render fragment types.
 * @type {Record<string, RenderFragmentEnum>}
 */
export const RenderFragmentType = {
	TEXT: 0,
	HTML: 1,
	BEHAVIOR_MODULE: 2,
	BEHAVIOR_MODULE_LOADER: 3,
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
	/**
	 * @param {RenderFragmentEnum} type
	 * @param {string} value
	 * @param {Promise<any> | null} [behaviorModulePromise]
	 */
	constructor(type, value, behaviorModulePromise = null) {
		this.type = type
		this.value = value
		this.behaviorModulePromise = behaviorModulePromise
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
				// Behavior modules are not rendered to HTML.
				// The loader is injected separately by #renderToHtmlAsync.
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
		),
		...children,
	]
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
 * Sanitizes the provided HTML by escaping HTML entities
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
