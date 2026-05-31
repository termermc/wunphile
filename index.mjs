import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

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

/**
 * The name of the environment variable that specifies the root path.
 * @type {string}
 */
export const ROOT_PATH_ENV_VAR = 'SSG_ROOT_PATH'

/**
 * The name of the environment variable that specifies the output path.
 * @type {string}
 */
export const OUTPUT_PATH_ENV_VAR = 'SSG_OUTPUT_PATH'

/**
 * The name of the environment variable that specifies the path to use for the not found page.
 * @type {string}
 */
export const NOT_FOUND_PATH_ENV_VAR = 'SSG_NOT_FOUND_PATH'

/**
 * The name of the environment variable that specifies the development server port.
 * @type {string}
 */
export const DEV_PORT_ENV_VAR = 'SSG_DEV_PORT'

/**
 * The name of the environment variable that specifies the development server host.
 * @type {string}
 */
export const DEV_HOST_ENV_VAR = 'SSG_DEV_HOST'

/**
 * The name of the environment variable that specifies whether hot reloading is enabled in development mode.
 * @type {string}
 */
export const DEV_NO_HOT_RELOAD_ENV_VAR = 'SSG_DEV_NO_HOT_RELOAD'

/**
 * The name of the environment variable that specifies whether hot reloading is enabled in development mode.
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

/* Types */
/**
 * @typedef {RenderFragment[]} RenderFragments
 * An array of render fragments.
 */

/**
 * @typedef {(props: TProps, children: TChildren) => RenderFragments} Component
 *
 * A component is a function that returns render fragments.
 * It can take in props and optionally children.
 *
 * @example
 * ```ts
 * const Greeting: Component<{ name: string }, void> = (props) => html`<h1>Hello, ${props.name}!</h1>`
 * ```
 *
 * @template TProps The component's props type
 * @template TChildren The component's children type
 */

/**
 * @typedef {(element: HTMLElement) => void} Behavior
 * A behavior is a function that will run on the browser.
 * Its first argument is the containing element of the component the behavior is attached to.
 */

/**
 * @typedef BehaviorModule
 * A behavior module is a module that will run on the browser.
 * It can be used in tandem with components to add interactivity.
 * For example, an image component could be augmented with a behavior that allows it to be enlarged.
 *
 * Behavior modules can also include common functions that other modules can use.
 *
 * The benefit of using behavior modules is that your JavaScript engine's TypeScript support can be used to automatically convert behaviors to plain JS for the browser.
 *
 * Important: top-level code (other than imports), as well as extra properties on the module, will not be included in the browser bundle.
 * If you need a stateful module, write a plain JS module and import it. You must not use TypeScript for such modules, as the builder will not be able to convert them to plain JS.
 *
 * All imports must be relative within the client directory.
 * Additionally, all imports to behavior modules must be top-level, otherwise the builder will not be able to resolve and convert them.
 * Do not write any import statements after your export statement! The builder is not smart enough to find them.
 *
 * EXTREMELY IMPORTANT: Do not import any modules with side effects.
 * Modules are actually imported in the Node.js environment, so modules with side effects can wreck the build by modifying global state or calling browser APIs.
 * So long as modules don't have side effects, you can safely import them. Libraries such as jQuery do not have side effects, so you can safely import them.
 *
 * @property {string} behaviorModuleUrl The behavior module's URL. Use `import.meta.url` for this value. Do not access this property; its runtime value is undefined behavior.
 * @property {Behavior} [behavior] The behavior to run on the browser. Can be omitted if this module only provides functions for other modules to use.
 * @property {Record<string, Function> | undefined} [functions] A map of functions to export. Can be omitted if this module only provides a behavior.
 *
 * @example
 * ```ts
 * import type { BehaviorModule } from 'wunphile'
 *
 * export default {
 *     behaviorModuleUrl: import.meta.url,
 *     behavior: (element: HTMLElement) => {
 *         element.addEventListener('click', () => {
 *             element.style.backgroundColor = 'red'
 *         })
 *     },
 *     functions: {
 *         getRandomNumber: () => Math.random(),
 *     },
 * } satisfies BehaviorModule
 * ```
 */

/**
 * @typedef {'file' | 'inline'} PageBehaviorLoaderType
 * How to load behaviors for a page.
 *
 * If set to "import", the loader will be imported as a file. This will result in slightly slower loading, but is compatible with content security policies that disallow inline scripts.
 * If set to "inline", the loader will be inlined in the page. This is the default and fastest option. If your content security policy disallows inline scripts, use "import" instead.
 */

import * as fs from 'node:fs/promises'
import * as pathUtil from 'node:path'

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
    #ssg

    /**
     * The path to the client directory.
     * Absolute path.
     * @type {string}
     */
    rootPath

    /**
     * All currently loaded modules.
     * The key is the path relative to the client directory.
     * @type {Map<string, LoadedModule>}
     */
    loadedModules = new Map()

    /**
     * All currently loading modules.
     * A set of promises from `import()` calls.
     * @type {Set<Promise<any>>}
     */
    #loadingModules = /** @type {Set<Promise<any>>} */ (new Set())

    /**
     * Creates a new client manager.
     * @param {Wunphile} ssg The Wunphile instance
     * @param {string} rootPath The path to the client directory
     */
    constructor(ssg, rootPath) {
        this.#ssg = ssg
        this.rootPath = pathUtil.resolve(rootPath)
    }

    /**
     * Returns the path relative to the client directory, or null if it is outside the client directory.
     * @param {string} path The path to check
     * @returns {string | null} The path relative to the client directory, or null if it is outside the client directory
     */
    #getPathRelativeToClientDir(path) {
        const res = pathUtil.relative(this.rootPath, path)
        if (res.startsWith('..')) {
            return null
        } else {
            return './' + res
        }
    }

    /**
     * Loads a module.
     * Processes behavior modules and makes note of non-behavior modules.
     * @param {any} mod The imported module.
     * @param {string | null} modPath The module's path, or null if this is supposed to be a behavior module.
     * @param {string} [modSrc] The module's source code, if available to the caller. This function will load it if not provided.
     */
    async #loadModule(mod, modPath, modSrc) {
        if (typeof mod?.default?.behaviorModuleUrl === 'string') {
            // This is a behavior module.
            const behaviorMod = /** @type {BehaviorModule} */ (mod.default)
            const modUrl = behaviorMod.behaviorModuleUrl

            const isTypeScript = modUrl.endsWith('.ts') || modUrl.endsWith('.mts')

            const behaviorModPath = pathUtil.resolve(fileURLToPath(modUrl))
            const behaviorModDir = pathUtil.resolve(
                pathUtil.dirname(behaviorModPath),
            )

            // TODO Check if path is within the client directory.

            // Load the behavior module's source from the filesystem.
            /** @type {string} */
            let source
            if (modSrc == null) {
                source = (await fs.readFile(behaviorModPath, 'utf8')).toString()
            } else {
                source = modSrc
            }

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

                const specifiedPath = /** @type {string} */ (
                    eval(match.groups.path)
                )

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
                let relativeToModDir = pathUtil.relative(
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
                const promise = import(fullImportPath)
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
                modOutPath = modOutPath.slice(0, -3) + '.js'
            }

            // Set the loaded module and mount it.
            const rewrittenPath = pathUtil.relative(this.rootPath, modOutPath)
            this.loadedModules.set(
                pathUtil.relative(this.rootPath, behaviorModPath),
                {
                    type: 'behavior',
                    rewrittenContent: out,
                    rewrittenPath,
                },
            )
            this.#ssg.pageRaw(CLIENT_MOUNT_PREFIX + rewrittenPath, out)
        } else {
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

            const relativePath = pathUtil.relative(this.rootPath, modPath)
            this.loadedModules.set(relativePath, { type: 'plain' })
            this.#ssg.staticFile(
                CLIENT_MOUNT_PREFIX + relativePath,
                pathUtil.relative(
                    './',
                    pathUtil.join(this.rootPath, relativePath),
                ),
            )
        }
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
        this.#loadingModules.add(promise)

        // Don't bother catching errors, let it crash if it fails.
        promise
            .then((mod) => this.#loadModule(mod, null))
            .finally(() => this.#loadingModules.delete(promise))
    }

    /**
     * Waits for all modules to load.
     * @returns {Promise<void>}
     */
    async waitForModules() {
        while (this.#loadingModules.size > 0) {
            for (const promise of this.#loadingModules) {
                await new Promise(setImmediate)
                await promise
            }
        }
    }

    /**
     * Generates a loader script for the specified rewritten relative paths to behavior modules.
     * The script is a JS module that imports the scripts on the browser.
     * The scripts can also be preloaded, but this function only generates the loader JavaScript, not the HTML script tag for it.
     * @param {string[]} rewrittenRelativePaths The rewritten relative paths to behavior modules
     * @returns {string} The loader script
     */
    generateLoaderScript(rewrittenRelativePaths) {
        if (rewrittenRelativePaths.length === 0) {
            return ''
        }

        const paths = /** @type {Set<string>} */ (
            new Set(rewrittenRelativePaths)
        )

        /** @type {Map<string, string>} */
        const varMappings = new Map()
        let num = 0
        for (const path of paths) {
            varMappings.set(`behavior${num++}`, path)
        }

        const hydrateScript = `
function hydrate(mod, path) {
    const comment = '${CLIENT_BEHAVIOR_HYDRATE_PREFIX}' + path
    
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
                    break
                }
            }
            
            if (elem) {
                mod.behavior(elem)
            }
        }
    }
}
        `.trim()

        let out = hydrateScript + '\n'
        for (const [varName, path] of varMappings) {
            out += `import ${varName} from '${CLIENT_MOUNT_PREFIX}${path}'\n`
            out += `hydrate(${varName}, '${path}')\n`
        }

        return out
    }
}

/**
 * The main class for the Wunphile library.
 *
 * @example
 * ```js
 * import { Wunphile } from 'wunphile'
 * import { IndexPage } from './components/Greeting.js'
 *
 * const ssg = new Wunphile(import.meta.url)
 *
 * ssg.page('/index.html', IndexPage)
 *
 * await ssg.cli()
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
     * @type {string}
     */
    #notFoundPath

    /**
     * The path of the output directory to write the generated site to.
     * This is normally specified by the `SSG_OUTPUT_PATH` environment variable, or defaults to `dist` in the process's current working directory if not specified.
     * @returns {string}
     */
    get outputPath() {
        return this.#outputPath
    }
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
     * Preloads a behavior module.
     * The loading is done asynchronously, similarly to using an HTML `<link rel="modulepreload">` tag.
     * Calling this function will cause a behavior module to be included in the generated site, regardless of whether it is used in any pages.
     *
     * @example
     * ```js
     * ssg.preloadBehaviorModule(import('./client/behavior/Greeting.js'))
     * ```
     * @param {Promise<{ default: BehaviorModule }>} promise The promise from the `import()` call for the behavior module
     */
    preloadBehaviorModule(promise) {
        this.#clientManager.loadBehaviorModule(promise)
    }

    /**
     * Creates a new Wunphile instance.
     *
     * @example
     * ```js
     * import { Wunphile } from 'wunphile'
     * import { IndexPage } from './components/Greeting.js'
     *
     * const ssg = new Wunphile(import.meta.url)
     *
     * ssg.page('/index.html', IndexPage)
     *
     * await ssg.cli()
     * ```
     *
     * @param {string} importMetaUrl The `import.meta.url` of the program main module.
     * @param {string} [clientDir='./src/client'] The path to the client directory. Client behaviors must be within this directory.
     *
     * Used to resolve the root path and for identifying the main module for hot reloading.
     */
    constructor(importMetaUrl, clientDir = './src/client') {
        const mainModulePath = fileURLToPath(importMetaUrl)

        this.#clientManager = new ClientManager(
            this,
            pathUtil.join(pathUtil.dirname(mainModulePath), clientDir),
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
            this.#notFoundPath = pathUtil.resolve(
                process.env[NOT_FOUND_PATH_ENV_VAR] || '/404.html',
            )

            if (!this.#notFoundPath.startsWith('/')) {
                throw new Error(
                    'The not found page must start with a forward slash.',
                )
            }
        } else {
            // Use paths in worker data.
            this.#mainModulePath = ''
            this.#rootPath = workerData.rootPath
            this.#outputPath = workerData.outputPath
            this.#notFoundPath = workerData.notFoundPath
        }
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
         * Values are behavior modules' rewritten paths, relative to the client root.
         * @type {Map<number, string>}
         */
        const fragMods = new Map()
        for (const [i, prom] of fragProms.entries()) {
            const mod = /** @type {BehaviorModule} */ ((await prom).default)
            const relativePath = pathUtil.relative(
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
                // TODO Figure out loader.
                // We should mount a loader script and then include it as a tag if set in settings.
                // For now, we're going to inline it to get out an MVP.

                res.push(
                    `<script type="module">\n${this.#clientManager.generateLoaderScript([...fragMods.values()])}\n</script>`,
                )
            } else {
                res.push(fragment.toHtml())
            }
        }

        return res.join('')
    }

    /**
     * Overrides the root path.
     * The root path is normally specified by the `SSG_ROOT_PATH` environment variable, or defaults to the directory of the program main module if not specified.
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
     * The output path is normally specified by the `SSG_OUTPUT_PATH` environment variable, or defaults to `dist` relative to the root path if not specified.
     * @param {string} path The output path
     * @returns {Wunphile} This
     */
    overrideOutputPath(path) {
        if (!isMainThread) {
            return this
        }

        if (!path.startsWith('/')) {
            throw new Error(
                'The not found page must start with a forward slash.',
            )
        }

        this.#outputPath = pathUtil.resolve(path)
        return this
    }

    /**
     * Overrides the not found path.
     * The not found path is normally specified by the `SSG_NOT_FOUND_PATH` environment variable, or defaults to `/404.html` if not specified.
     * @param {string} path The not found path
     * @returns {Wunphile} This
     */
    overrideNotFoundPath(path) {
        if (!isMainThread) {
            return this
        }

        this.#notFoundPath = pathUtil.resolve(path)
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
            this.#renderToHtmlAsync(component()).then((content) => {
                // Send content to main thread.
                parentPort.postMessage({
                    type: 'pageRaw',
                    path,
                    content,
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
     * The redirect is done with an HTML file using a meta refresh tag and fallback JavaScript.
     * @param {string} path The path to redirect from
     * @param {string} url The URL/path to redirect to
     */
    redirect(path, url) {
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
        <script>location.assign(${html(JSON.stringify(url))})</script>
    </body>
</html>
        `)
    }

    /**
     * Registers a component to be used as the not found page.
     * The not found page is configured via the `SSG_NOT_FOUND_PATH` environment variable, and defaults to `/404.html`.
     * @param {Component<void, void>} component The component to use for the not found page
     */
    notFoundPage(component) {
        this.page(this.#notFoundPath, component)
    }

    /**
     * Registers a static directory to a path.
     * For example, if you have a directory named `site-assets` in your project and you want to serve it at the path `/assets` in the generated site,
     * you would call this method with `staticDir('/assets', './site-assets')`.
     *
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
            this.#staticDirMappings.set(path, dir)
        } else {
            // Send content to main thread.
            parentPort.postMessage({
                type: 'staticDir',
                path,
                dir,
            })
        }
    }

    /**
     * Registers a static file to a path.
     * For example, if you have a file named `site-icon.ico` in your project and you want to serve it at the path `/favicon.ico` in the generated site,
     * you would call this method with `staticFile('/favicon.ico', './site-icon.ico')`.
     *
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
            this.#staticFileMappings.set(path, file)
        } else {
            // Send content to main thread.
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
     * Builds the site only.
     * This method will clear the output directory before building.
     *
     * The order in which paths are processed is as follows:
     *  1. Static directories
     *  2. Static files
     *  3. Pages
     *
     * If a path is specified multiple times, the last one will ultimately be used.
     *
     * Instead of calling this method directly, you can also call the {@link Wunphile#cli} method, which will determine whether
     * to build or watch the site depending on the environment and arguments, acting as a CLI.
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
            // Output directory doesn't exist, create it.
            await fs.mkdir(this.#outputPath, { recursive: true })
        } else {
            // Output directory exists, clear it.
            for (const file of await fs.readdir(this.#outputPath)) {
                await fs.rm(this.toOutputPath(file), {
                    recursive: true,
                    force: true,
                })
            }
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
            // Create containing directory if it doesn't exist.
            const dir = pathUtil.dirname(pathUtil.join(this.#outputPath, dest))
            if ((await statOrNull(dir)) === null) {
                await fs.mkdir(dir, { recursive: true })
            }

            await fs.writeFile(
                pathUtil.join(this.#outputPath, dest),
                await this.#renderToHtmlAsync(component()),
            )
        }
    }

    /**
     * Serves the site on a local HTTP server.
     *
     * The site will be served without being built or touching the file system.
     *
     * This is not meant for production, only for local development.
     * Production sites should be built ahead of time, and their output should be
     * served on a web server such as Nginx or Caddy.
     *
     * The order in which paths are resolved is as follows:
     *  1. Pages
     *  2. Static files
     *  3. Static directories
     *
     * If a path is specified multiple times, the first one will ultimately be used.
     * This is the reverse of the order in which paths are processed when building the site,
     * which serves to mimic how the built version would be served statically.
     *
     * Instead of calling this method directly, you can also call the {@link Wunphile#cli} method, which will determine whether
     * to build or watch the site depending on the environment and arguments, acting as a CLI.
     *
     * @param {number} port The port to listen on
     * @param {string} [host='127.0.0.1'] The host to listen on (optional, defaults to `127.0.0.1`)
     * @param {EventEmitter<{ reload: [] }>|null} [hotReloadEventEmitter=null] The event emitter to emit hot reload events on (optional, defaults to `null`).
     * If null, no hot reload code will be injected into pages.
     * To trigger a hot reload, emit the `reload` event on the event emitter.
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

        // Import necessary packages dynamically to avoid importing them when this method is not used.
        const http = await import('node:http')

        /** @type {typeof import('mime-db/index')} */
        let mimeDbRaw

        try {
            mimeDbRaw = /** @type {typeof import('mime-db/index')} */ (
                (await import('mime-db')).default
            )
        } catch (err) {
            console.error(
                'mime-db dependency not available; development mode will not work. Import error:',
                err,
            )
            console.error(
                'To fix this, add mime-db as a dependency for your project, or install wunphile as an NPM dependency.',
            )
            process.exit(1)
        }

        // Build mapping of extensions to MIME types.
        /** @type {Map<string, string>} */
        const extToMime = new Map()
        for (const mime in mimeDbRaw) {
            const info = mimeDbRaw[mime]

            if (info.extensions instanceof Array) {
                for (const ext of info.extensions) {
                    extToMime.set(ext, mime)
                }
            }
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

        // Inject script at the end of pages that triggers a reload when a request to `/__hotreload` responds.
        /** @type {string} */
        let trailer
        /** @type {import('node:http').ServerResponse[]} */
        const waitResponses = []
        if (hotReloadEventEmitter === null) {
            trailer = ''
        } else {
            trailer = `
<!-- Injected by Wunphile for development mode hot reloading -->
<script>fetch('/__hotreload').then(() => window.location.reload())</script>`

            hotReloadEventEmitter.on('reload', () => {
                // Resolve all pending responses.
                for (const res of waitResponses) {
                    res.writeHead(200, { 'Content-Type': 'text/html' })
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
                // Put response in a queue so that it can be resolved upon a "reload" event.
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
                        // Page is HTML; inject trailer.
                        res.write(trailer)
                    }
                    res.end()

                    return true
                }

                // Try static directories.
                for (const [staticPath, dirPath] of this.#staticDirMappings) {
                    if (path.startsWith(staticPath)) {
                        const fsPath = this.toProjectPath(
                            pathUtil.join(
                                dirPath,
                                path.substring(staticPath.length),
                            ),
                        )
                        if ((await statOrNull(fsPath)) !== null) {
                            // Open file read stream.
                            const file = await fs.open(fsPath, 'r')
                            try {
                                const readStream = file.createReadStream()
                                console.log(`Serving ${path}`)

                                res.writeHead(200, { 'Content-Type': mime })
                                await new Promise((promRes, rej) => {
                                    readStream
                                        .pipe(res)
                                        .on('close', promRes)
                                        .on('error', rej)
                                })
                                res.end()
                            } finally {
                                await file.close()
                            }

                            return true
                        }
                    }
                }

                // Try static files.
                for (const [staticPath, filePath] of this.#staticFileMappings) {
                    if (path === staticPath) {
                        const fsPath = this.toProjectPath(filePath)
                        if ((await statOrNull(fsPath)) !== null) {
                            // Open file read stream.
                            const file = await fs.open(fsPath, 'r')
                            try {
                                const readStream = file.createReadStream()

                                res.writeHead(200, { 'Content-Type': mime })
                                await new Promise((promRes, rej) => {
                                    readStream
                                        .pipe(res)
                                        .on('close', promRes)
                                        .on('error', rej)
                                })
                                res.end()
                            } finally {
                                await file.close()
                            }

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

            // No paths match, try the configured not found page.
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
     * The CLI can build the site or serve it on a local HTTP server for development.
     *
     * Call this only after all pages and static files have been registered.
     * It should be at the end of your main module.
     *
     * @example
     * ```js
     * import { Wunphile } from 'wunphile'
     *
     * const ssg = new Wunphile(import.meta.url)
     *
     * // Register pages and static files.
     * // ...
     *
     * await ssg.cli()
     * ```
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
    The path to use for the "note found" page.
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

        // Wait client manager to be ready, then mount client paths.
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

            if (process.env[DEV_NO_HOT_RELOAD_ENV_VAR] !== '1') {
                /** @type {typeof import('chokidar/index')} */
                let chokidar = /** @type {any} */ (null)

                let isHrEnabled = false

                if (isWorkerApiSupported) {
                    try {
                        // Dynamically import Chokidar to avoid importing it when development mode is not used.
                        chokidar = await import('chokidar')

                        isHrEnabled = true
                    } catch (err) {
                        console.warn(
                            'Chokidar file watcher dependency not available; hot reloading will not work. Import error:',
                            err,
                        )
                    }
                }

                if (isHrEnabled) {
                    hrEmitter = new EventEmitter()

                    let hasPendingReload = false

                    console.log(
                        `Development mode hot reloading enabled. Watching "${this.#rootPath}" for changes.`,
                    )

                    chokidar
                        .watch(this.#rootPath, {
                            ignoreInitial: true,
                            persistent: true,
                        })
                        .on('all', async () => {
                            if (hasPendingReload) {
                                return
                            }

                            hasPendingReload = true

                            try {
                                // Wait a little while to let writes finish.
                                await new Promise((resolve) =>
                                    setTimeout(resolve, 50),
                                )

                                // Re-run main module in a worker.
                                // This is necessary because we have no way of manually clearing the module cache in ESM.
                                const worker = new Worker(
                                    this.#mainModulePath,
                                    {
                                        workerData: {
                                            rootPath: this.#rootPath,
                                            outputPath: this.#outputPath,
                                            notFoundPath: this.#notFoundPath,
                                        },
                                    },
                                )

                                let gotError = false

                                /** @type {Map<string, Component<void, void>>} */
                                const pageMapping = new Map()
                                /** @type {Map<string, string>} */
                                const staticDirMapping = new Map()
                                /** @type {Map<string, string>} */
                                const staticFileMapping = new Map()

                                // Receive mappings from worker.
                                worker.on(
                                    'message',
                                    /** @type {(msg: any) => void} */ (
                                        (msg) => {
                                            switch (msg.type) {
                                                case 'pageRaw':
                                                    pageMapping.set(
                                                        msg.path,
                                                        () => html(msg.content),
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
                                            }
                                        }
                                    ),
                                )
                                worker.on('error', (err) => {
                                    gotError = true
                                    console.error('Error while reloading:', err)
                                })

                                // Wait for reload to finish.
                                await new Promise((res) =>
                                    worker.on('exit', res),
                                )

                                if (!gotError) {
                                    // Replace mappings.
                                    this.#pageMapping = pageMapping
                                    this.#staticDirMappings = staticDirMapping
                                    this.#staticFileMappings = staticFileMapping
                                }

                                // @ts-expect-error hrEmitter is assigned by now
                                hrEmitter.emit('reload')
                            } finally {
                                hasPendingReload = false
                            }
                        })
                }
            }

            await this.serve(httpPort, httpHost, hrEmitter)
            return
        }

        // If the method hasn't returned yet, build the site.
        const now = Date.now()
        await this.build()
        console.log(`Built site in ${Date.now() - now}ms`)
    }
}

/**
 * Render fragment types.
 * @enum {number}
 */
const RenderFragmentType = {
    /**
     * Text.
     * Will be sanitized.
     */
    TEXT: 0,

    /**
     * Raw HTML.
     * Will not be sanitized.
     */
    HTML: 1,

    /**
     * Behavior module import.
     */
    BEHAVIOR_MODULE: 2,

    /**
     * Loader for module imports.
     */
    BEHAVIOR_MODULE_LOADER: 3,
}

/**
 * A render fragment is a string that can be rendered to HTML.
 * How it will be rendered depends on the fragment type.
 */
export class RenderFragment {
    /**
     * Creates render fragments from the provided value.
     *
     * If the value is a render fragment, an array with it as the only element will be returned.
     * If the value is an array, each fragment will be processed with this function and returned in an array.
     * If the value is anything else, it will be turned into a string with the {@link String} function and returned as a text fragment.
     *
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

    /**
     * The fragment type.
     * @type {RenderFragmentType}
     * @readonly
     */
    type

    /**
     * The fragment's value.
     * How it will be rendered depends on the fragment type.
     * @type {string}
     * @readonly
     */
    value

    /**
     * The attached behavior module promise.
     * This is null if the fragment is not a behavior module import.
     * @type {Promise<any> | null}
     * @readonly
     */
    behaviorModulePromise

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
                // The loader needs to be constructed outside of this function.
                return ''
            default:
                throw new Error(
                    `Unknown fragment type: ${this.type}. Valid types are contained in the RenderFragmentType enum.`,
                )
        }
    }

    /**
     * Instantiates a new RenderFragment with the specified type and value.
     * @param {RenderFragmentType} type The fragment type
     * @param {string} value The fragment value
     * @param {Promise<any> | null} behaviorModulePromise The attached behavior module promise (defaults to null)
     */
    constructor(type, value, behaviorModulePromise = null) {
        this.type = type
        this.value = value
        this.behaviorModulePromise = behaviorModulePromise
    }
}

/**
 * Template string function that takes in HTML and interpolates it with the provided values.
 * The values can be any type, but all values except render fragments or arrays of render fragments will be sanitized.
 *
 * @example
 * ```js
 * const greeting = html`<h1>Hello, ${name}!</h1>`
 * ```
 *
 * @param {string|TemplateStringsArray} strs The string(s) to interpolate
 * @param {any[]} vals The values to interpolate
 * @returns {RenderFragments} The resulting render fragments
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
 * The string's escape sequences will not be processed.
 *
 * @example
 * ```js
 * const greeting = text`Hello, ${name}!`
 * ```
 *
 * @param {string|TemplateStringsArray} strs The string(s) to interpolate
 * @param {any[]} vals The values to interpolate
 * @returns {RenderFragments} The resulting plain text render fragment
 */
export function text(strs, ...vals) {
    if (typeof strs === 'string') {
        return RenderFragment.from(strs)
    }

    return RenderFragment.from(String.raw(strs, ...vals))
}

/**
 * Component that renders the behavior module loader.
 * This is required for any pages' behavior modules to be loaded on the browser.
 * You can use this component at the end of your page's body.
 *
 * @type {Component<void, void>}
 */
export const BehaviorLoader = () => {
    return [new RenderFragment(RenderFragmentType.BEHAVIOR_MODULE_LOADER, '')]
}

/**
 * @typedef BehaviorModuleProps
 * The props type for a behavior module.
 *
 * @property {Promise<{ default: BehaviorModule }>} module The promise from the `import()` call for the behavior module. For example, `import('./client/behavior/Greeting.js')`.
 */

/**
 * Wraps a component in a behavior.
 * The first element in the children will be the element passed to the behavior.
 *
 * You must use {@link BehaviorLoader} at the end of your page's body, otherwise the behavior module will never be loaded on the browser.
 * @param {BehaviorModuleProps} props The component's props
 * @param {RenderFragments} children The component's children (should contain a single parent element)
 * @returns {RenderFragments} The rendered behavior module
 *
 * @type {Component<BehaviorModuleProps, RenderFragments>}
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
 * @param {RenderFragments} fragments The render fragments to render
 * @returns {string} The rendered HTML
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
 * @param {string} path The path to stat
 * @returns {Promise<import('node:fs').Stats|null>} The stats, or null if the path doesn't exist
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
 * @param {string} source The source directory
 * @param {string} target The target directory
 * @returns {Promise<void>}
 */
export async function copyRecursive(source, target) {
    // Stat to check if it's a directory
    if (!(await fs.stat(source)).isDirectory()) {
        // If it's not a directory, just copy it
        await fs.copyFile(source, target)
        return
    }

    // Since the path is a directory, stat target to make sure the function can do what it needs to
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

    // Loop util there are no more paths to crawl
    while (paths.length > 0) {
        const path = /** @type {string} */ (paths.shift())

        // List children
        const files = await fs.readdir(pathUtil.join(source, path))
        for (const file of files) {
            const childPath = pathUtil.join(path, file)
            const realPath = pathUtil.join(source, childPath)

            // Check if path is a directory, adding to paths list if it is, otherwise copying the file
            const targetPath = pathUtil.join(target, childPath)
            if ((await fs.stat(realPath)).isDirectory()) {
                await fs.mkdir(targetPath)
                paths.push(childPath)
            } else {
                await fs.copyFile(realPath, targetPath)
            }
        }
    }
}

// Regex that matches HTML entities.
const htmlEntityRegex = /[&<>"']/

/**
 * Sanitizes the provided HTML by escaping HTML entities
 * @param {string} html The HTML to sanitize
 * @returns {string} The sanitized HTML
 * @since 1.0.0
 */
export function sanitizeHtml(html) {
    // Adapted from https://github.com/component/escape-html

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
            case 34: // "
                escape = '&quot;'
                break
            case 38: // &
                escape = '&amp;'
                break
            case 39: // '
                escape = '&#39;'
                break
            case 60: // <
                escape = '&lt;'
                break
            case 62: // >
                escape = '&gt;'
                break
            default:
                continue
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
