/**
 * Public TypeScript types for Wunphile.
 *
 * The runtime is a single JavaScript file. These declarations mirror the
 * module-scope JSDoc typedefs in `index.mjs` and can be imported directly:
 *
 * ```ts
 * import type { Component, BehaviorModule, RenderFragments } from 'wunphile/types'
 * ```
 *
 * The generated `dist/index.d.mts` also re-exports the same names, so
 * `import type { Component } from 'wunphile'` works for published installs.
 */

export type RenderFragmentEnum = 0 | 1 | 2 | 3 | 4
export type LoadStrategy = 'eager' | 'visible' | 'idle' | 'interaction'

export interface RenderFragment {
	type: RenderFragmentEnum
	value: string
	behaviorModulePromise: Promise<any> | null
	meta: Record<string, any> | null
	toHtml(): string
}

export type RenderFragments = RenderFragment[]

export interface BehaviorModule {
	behaviorModuleUrl: string
	behavior?: (elem: Element, ctx?: any) => void
	functions?: Record<string, (...args: any[]) => any>
	/** CSS shipped alongside the module and adopted by the loader (#21). */
	styles?: string
	/** Default island hydration strategy (#20). */
	load?: LoadStrategy
}

export interface ContentEntry {
	slug: string
	path: string
	data: Record<string, any>
	body: string
	html: string
	title: string
	description: string
	date: string
	mtime: number
	params: Record<string, string>
}

export interface PageContext {
	path: string
	params: Record<string, string>
	entry?: any
	collections: Record<string, ContentEntry[]>
	wunphile: any
	locale: string | null
	locales: string[]
	localeLinks: { locale: string; href: string }[]
	props?: any
	children?: any
}

export type Component<P = void, C = void> = (
	ctx?: PageContext & { props?: P; children?: C },
) => RenderFragments | Promise<RenderFragments>

export interface StaticOptions {
	/** Emit a content-hashed filename and a manifest entry (#1). */
	hash?: boolean
	/** Allow asset transforms (registered hooks / optional deps) (#2). */
	transform?: boolean
	/** Extra headers emitted into adapter configs (#11). */
	headers?: Record<string, string>
}

export interface SitemapEntry {
	path?: string
	loc?: string
	lastmod?: string | number | Date
	changefreq?: string
	priority?: number | string
	alternates?: { hreflang: string; href: string }[]
}

export interface AssetRecord {
	url: string
	finalUrl: string
	sourcePath: string
	content: Uint8Array | null
	mime: string
	rawSize: number
	size: number
	hashed: boolean
	headers: Record<string, string>
}

export interface Plugin {
	name?: string
	onPageRender?: (
		html: string,
		path: string,
	) => string | void | Promise<string | void>
	onAsset?: (asset: AssetRecord) => void | Promise<void>
	onBuildEnd?: (manifest: {
		pages: any[]
		assets: any[]
		manifest: Record<string, string>
		stats: any
	}) => void | Promise<void>
	onDevRequest?: (
		req: any,
		res: any,
	) => boolean | void | Promise<boolean | void>
}

export interface BuildOptions {
	precompress?: ('gzip' | 'br')[]
	incremental?: boolean
	stats?: boolean
	concurrency?: number
	quiet?: boolean
}

export interface HeadProps {
	title?: string
	description?: string
	canonical?: string | false
	robots?: string
	image?: string
	meta?: Record<string, string>[]
	og?: Record<string, any>
	links?: Record<string, string>[]
	jsonLd?: any
}

export interface I18nOptions {
	locales: string[]
	defaultLocale?: string
	prefixDefault?: boolean
	urlForLocale?: (locale: string, path: string) => string
}

export interface DevHandle {
	server: any
	close(): Promise<void>
}

export interface WunphileConfig {
	root?: string
	outDir?: string
	base?: string
	baseUrl?: string
	clientDir?: string
	notFoundPath?: string
	sitemap?: string | { baseUrl: string; path?: string }
	minify?: boolean
	plugins?: Plugin[]
	markdown?: { renderer?: string; [key: string]: any }
	image?: { widths?: number[]; formats?: string[]; [key: string]: any }
	adapter?:
		| 'netlify'
		| 'vercel'
		| 'cloudflare-pages'
		| 'github-pages'
		| { name: string; [key: string]: any }
	i18n?: I18nOptions
	feed?: any
	robots?: any
	ogImage?: any
	content?: { collections?: Record<string, any>; [key: string]: any }
	loader?: 'dynamic' | 'static'
	absoluteImports?: boolean
	csp?: boolean
	build?: BuildOptions
	/** Only used by the standalone CLI when the config exports a plain object. */
	entry?: string
}

export interface BuildStats {
	startedAt: string
	durationMs: number
	pages: { path: string; ms: number; bytes: number; skipped: boolean }[]
	assets: {
		path: string
		finalUrl: string
		rawSize: number
		size: number
		hashed: boolean
	}[]
	compressed: { path: string; raw: number; gzip?: number; br?: number }[]
	modules: string[]
	skipped: number
	totalBytes: number
	largestModule: number
	timings: Record<string, number>
	manifest: Record<string, string>
}
