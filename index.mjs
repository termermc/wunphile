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

import * as fs from 'node:fs/promises'
import * as pathUtil from 'node:path'

/**
 * The main class for the Wunphile library.
 *
 * @example
 * ```js
 * import { Wunphile } from 'wunphile'
 * import { IndexPage } from './components/Greeting.js'
 *
 * const ssg = new SimpleJsSsg(import.meta.url)
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
     * Creates a new Wunphile instance.
     *
     * @example
     * ```js
     * import { Wunphile } from 'wunphile'
     * import { IndexPage } from './components/Greeting.js'
     *
     * const ssg = new SimpleJsSsg(import.meta.url)
     *
     * ssg.page('/index.html', IndexPage)
     *
     * await ssg.cli()
     * ```
     *
     * @param {string} importMetaUrl The `import.meta.url` of the program main module.
     * Used to resolve the root path and for identifying the main module for hot reloading.
     */
    constructor(importMetaUrl) {
        if (isMainThread) {
            // Resolve paths
            this.#mainModulePath = fileURLToPath(importMetaUrl)
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
            // Send content to main thread.
            parentPort.postMessage({
                type: 'pageRaw',
                path,
                content: renderToHtml(component()),
            })
        }
    }

    /**
     * Registers raw content to a page path.
     * @param {string} path The page's path
     * @param {string} content The page's content
     */
    pageRaw(path, content) {
        this.page(path , () => html(content))
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
            await fs.copyFile(this.toProjectPath(src), this.toOutputPath(dest))
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
                renderToHtml(component()),
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
                    res.write(renderToHtml(pageMapping()))
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
                            const readStream = file.createReadStream()

                            res.writeHead(200, { 'Content-Type': mime })
                            await new Promise((promRes, rej) => {
                                readStream
                                    .pipe(res)
                                    .on('close', promRes)
                                    .on('error', rej)
                            })
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
     * Renders the fragment to HTML.
     * @returns {string}
     */
    toHtml() {
        switch (this.type) {
            case RenderFragmentType.TEXT:
                return sanitizeHtml(this.value)
            case RenderFragmentType.HTML:
                return this.value
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
     */
    constructor(type, value) {
        this.type = type
        this.value = value
    }
}

/**
 * Template string function that takes in HTML and interpolates it with the provided values.
 * The values can be any type, but all values except render fragments or arrays of render fragments will be sanitized.
 *
 * @example
 * ```ts
 * const greeting = html`<h1>Hello, ${name}!</h1>`
 * ```
 *
 * @param {string|string[]} strs The string(s) to interpolate
 * @param {any[]} vals The values to interpolate
 * @returns {RenderFragments} The resulting render fragments
 */
export function html(strs, ...vals) {
    if (typeof strs === 'string') {
        strs = [strs]
    }

    /** @type {RenderFragments} */
    const res = []

    for (let i = 0; i < strs.length; i++) {
        const str = strs[i]

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

// Constants and utils for sanitizing HTML
/** @type {Record<string, string>} */
const htmlEntityReplacements = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
}
const htmlEntityRegex = /[&<>"'/]/g
/**
 * @param {string} match
 * @returns {string}
 */
function htmlEntityReplacer(match) {
    return htmlEntityReplacements[match]
}

/**
 * Sanitizes the provided HTML by escaping HTML entities
 * @param {string} html The HTML to sanitize
 * @returns {string} The sanitized HTML
 * @since 1.0.0
 */
export function sanitizeHtml(html) {
    return String(html).replace(htmlEntityRegex, htmlEntityReplacer)
}
