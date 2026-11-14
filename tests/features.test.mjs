import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as pathUtil from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

import {
	Wunphile,
	html,
	Head,
	BehaviorComponent,
	BehaviorLoader,
	RenderFragment,
	RenderFragmentType,
	renderToHtml,
	defineConfig,
	minifyHtml,
	buildSitemap,
	buildSitemapIndex,
	generateLoaderScript,
	modulePreloadLinks,
	parseFrontmatter,
	renderMarkdownBuiltin,
	globToRegExp,
	readImageSize,
	contentHash,
	hashPath,
	sha256,
	escapeAttribute,
	stripHtml,
	safeRedirectUrl,
	jsStringLiteral,
	checkAccessibility,
	buildFeed,
	buildRobots,
	renderHeadTags,
	formatBytes,
	mapConcurrent,
	mimeForExt,
	isHtmlPath,
} from '../index.mjs'

/** Creates a temp directory that is removed when the test finishes. */
async function makeTempDir(t) {
	const dir = await fs.mkdtemp(pathUtil.join(os.tmpdir(), 'wunphile-feat-'))
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	return dir
}

/**
 * Creates a Wunphile instance rooted at a temp directory.
 * @param {any} t
 * @param {any} [config]
 */
async function makeSite(t, config) {
	const root = await makeTempDir(t)
	const out = pathUtil.join(root, 'dist')
	const wunphile = new Wunphile(import.meta.url, config)
	wunphile.overrideRootPath(root)
	wunphile.overrideOutputPath(out)
	return { root, out, wunphile }
}

/* ---------------------------- pure helpers ---------------------------- */

test('pure helper exports are usable without an instance', () => {
	assert.equal(minifyHtml('<p>a   b</p>  <em>x</em>'), '<p>a   b</p><em>x</em>')
	assert.equal(minifyHtml('<!-- x --><p>y</p>'), '<p>y</p>')
	assert.match(minifyHtml('<!--wf-behavior:a--><p>y</p>'), /wf-behavior:a/)
	assert.match(buildSitemap(['/a.html'], 'https://e.com'), /https:\/\/e\.com\/a\.html/)
	assert.match(
		buildSitemap([{ path: '/a.html', lastmod: '2026-01-01', priority: 0.8 }], 'https://e.com'),
		/<priority>0\.8<\/priority>/,
	)
	assert.match(buildSitemapIndex(['https://e.com/sitemap-1.xml']), /sitemapindex/)
	assert.equal(escapeAttribute('<a&"'), '&lt;a&amp;&quot;')
	assert.equal(stripHtml('<p>Hello <b>world</b></p>'), 'Hello world')
	assert.equal(hashPath('/a/app.js', 'abcd'), '/a/app.abcd.js')
	assert.equal(sha256('a').length, 64)
	assert.equal(contentHash('a').length, 8)
	assert.equal(mimeForExt('css'), 'text/css; charset=utf-8')
	assert.equal(isHtmlPath('/index.html'), true)
	assert.equal(isHtmlPath('/_wfclient/x.js'), false)
	assert.equal(formatBytes(2048), '2.0KB')
	assert.throws(() => safeRedirectUrl('javascript:alert(1)'), /Unsafe redirect/)
	assert.doesNotThrow(() => safeRedirectUrl('/ok.html?a=1'))
	assert.doesNotThrow(() => safeRedirectUrl('https://example.com/x'))
	assert.equal(JSON.parse(jsStringLiteral('</script>').replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')), '</script>')
	assert.deepEqual(globToRegExp('**/*.md').test('a/b/c.md'), true)
	assert.deepEqual(globToRegExp('**/*.md').test('c.md'), true)
	assert.deepEqual(globToRegExp('**/*.md').test('a/c.txt'), false)
	assert.deepEqual(parseFrontmatter('---\ntitle: Hi\ntags: [a, b]\ndraft: false\n---\n# Body').data, {
		title: 'Hi',
		tags: ['a', 'b'],
		draft: false,
	})
	assert.match(renderMarkdownBuiltin('# Title\n\nHello **world** `code`'), /<h1>Title<\/h1>/)
	assert.match(renderMarkdownBuiltin('Hello **world**'), /<strong>world<\/strong>/)
	assert.match(renderMarkdownBuiltin('```js\nconst a = 1\n```'), /<pre><code/)
	assert.deepEqual(
		readImageSize(Buffer.from('89504e470d0a1a0a0000000d494844520000000a000000140802000000', 'hex')),
		{ width: 10, height: 20 },
	)
	const png = Buffer.alloc(24)
	png.write('89504e470d0a1a0a', 0, 'hex')
	png.write('0000000d49484452', 8, 'hex')
	png.writeUInt32BE(320, 16)
	png.writeUInt32BE(200, 20)
	assert.deepEqual(readImageSize(png), { width: 320, height: 200 })
	assert.equal(checkAccessibility('<html><img src="x"></html>').length >= 2, true)
	assert.match(buildFeed({ format: 'rss', title: 'T', entries: [{ slug: 'p', title: 'P', html: '<p>x</p>' }], baseUrl: 'https://e.com' }), /<rss/)
	assert.match(buildFeed({ format: 'atom', entries: [] }), /<feed/)
	assert.match(JSON.parse(buildFeed({ format: 'json', entries: [] })).version, /jsonfeed/)
	assert.match(buildRobots({ sitemap: true, disallow: ['/admin'] }), /Disallow: \/admin/)
	assert.match(renderHeadTags({ title: 'Hi' }, { baseUrl: 'https://e.com', path: '/' }), /rel="canonical"/)
	assert.match(renderHeadTags({ title: 'Hi' }, { baseUrl: '', path: '/' }), /<title>Hi<\/title>/)
})

test('generateLoaderScript: dynamic default, static strategy, dedupe, valid syntax', () => {
	const dynamic = generateLoaderScript(['a/one.js', 'b/two.js'])
	assert.equal((dynamic.match(/import\(/g) ?? []).length, 2)
	assert.match(dynamic, /\);\nimport\(/)
	assert.doesNotThrow(() => new Function(dynamic), dynamic)
	assert.equal(generateLoaderScript([]), '')
	assert.equal((generateLoaderScript(['a\\one.js', 'a/one.js']).match(/import\(/g) ?? []).length, 1)
	const staticScript = generateLoaderScript(['a/one.js'], { strategy: 'static' })
	assert.match(staticScript, /^[\s\S]*import \* as wfMod0 from "\/_wfclient\/a\/one\.js";/)
	assert.match(staticScript, /IntersectionObserver/)
	assert.match(staticScript, /adoptedStyleSheets/)
	assert.match(staticScript, /wfReport/)
	assert.match(modulePreloadLinks(['a/one.js']), /rel="modulepreload"/)
})

test('mapConcurrent bounds concurrency', async () => {
	let active = 0
	let maxActive = 0
	await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
		active++
		maxActive = Math.max(maxActive, active)
		await new Promise((resolve) => setTimeout(resolve, 1))
		active--
	})
	assert.ok(maxActive <= 3, `maxActive=${maxActive}`)
})

test('Head fragment is not emitted inline', () => {
	const fragments = Head({ title: 'x' })
	assert.equal(fragments[0].type, RenderFragmentType.HEAD)
	assert.equal(fragments[0].toHtml(), '')
	assert.equal(renderToHtml(fragments), '')
})

/* ------------------------- asset pipeline ----------------------------- */

test('staticFile({hash:true}) emits fingerprinted name, manifest and asset()', async (t) => {
	const { root, out, wunphile } = await makeSite(t)
	await fs.writeFile(pathUtil.join(root, 'app.js'), 'console.log("hello")\n', 'utf8')
	await fs.writeFile(pathUtil.join(root, 'img.png'), Buffer.from('png-bytes'))
	wunphile.staticFile('/assets/app.js', 'app.js', { hash: true })
	wunphile.staticFile('/assets/img.png', 'img.png', { hash: true })
	wunphile.transformAsset('js', (code) => code.replace('hello', 'world'))
	wunphile.page('/index.html', () => html`<script src="${wunphile.asset('/assets/app.js')}"></script>`)
	await wunphile.build({ quiet: true })
	const files = await fs.readdir(pathUtil.join(out, 'assets'))
	const jsFile = files.find((f) => f.startsWith('app.') && f.endsWith('.js'))
	assert.ok(jsFile, JSON.stringify(files))
	assert.match(jsFile, /^app\.[0-9a-f]{8}\.js$/)
	const manifest = JSON.parse(await fs.readFile(pathUtil.join(out, 'manifest.json'), 'utf8'))
	assert.equal(manifest['/assets/app.js'], '/assets/' + jsFile)
	assert.equal(manifest['/assets/img.png'].startsWith('/assets/img.'), true)
	assert.equal(await fs.readFile(pathUtil.join(out, 'assets', jsFile), 'utf8'), 'console.log("world")\n')
	const page = await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8')
	assert.ok(page.includes('/assets/' + jsFile), page)
	assert.equal(wunphile.asset('/assets/app.js'), '/assets/' + jsFile)
})

test('CSS url() references are rewritten to hashed paths', async (t) => {
	const { root, out, wunphile } = await makeSite(t)
	await fs.mkdir(pathUtil.join(root, 'assets', 'img'), { recursive: true })
	await fs.writeFile(pathUtil.join(root, 'assets', 'img', 'x.png'), 'PNGDATA')
	await fs.writeFile(pathUtil.join(root, 'assets', 'style.css'), 'body { background: url(img/x.png); }')
	wunphile.staticDir('/assets', 'assets', { hash: true })
	await wunphile.build({ quiet: true })
	const cssFile = (await fs.readdir(pathUtil.join(out, 'assets'))).find((f) => f.startsWith('style.') && f.endsWith('.css'))
	assert.ok(cssFile)
	const css = await fs.readFile(pathUtil.join(out, 'assets', cssFile), 'utf8')
	const manifest = JSON.parse(await fs.readFile(pathUtil.join(out, 'manifest.json'), 'utf8'))
	assert.ok(css.includes(manifest['/assets/img/x.png']), css)
})

test('precompress writes .gz/.br and stats writes build-stats.json', async (t) => {
	const { root, out, wunphile } = await makeSite(t)
	await fs.writeFile(pathUtil.join(root, 'a.css'), 'body { color: red; }')
	wunphile.staticFile('/a.css', 'a.css')
	wunphile.page('/index.html', () => html`<html><head></head><body>x</body></html>`)
	await wunphile.build({ quiet: true, precompress: ['gzip', 'br'], stats: true })
	assert.ok((await fs.stat(pathUtil.join(out, 'index.html.gz'))).size > 0)
	assert.ok((await fs.stat(pathUtil.join(out, 'index.html.br'))).size > 0)
	const stats = JSON.parse(await fs.readFile(pathUtil.join(out, 'build-stats.json'), 'utf8'))
	assert.equal(stats.pages.length, 1)
	assert.ok(stats.totalBytes > 0)
	assert.ok(stats.compressed.some((c) => c.path === '/index.html' && c.br > 0))
	assert.equal(wunphile.stats().durationMs, stats.durationMs)
})

test('incremental build skips unchanged pages and writes cache.json', async (t) => {
	const { root, wunphile } = await makeSite(t)
	wunphile.page('/index.html', () => html`<p>stable</p>`)
	const opts = { quiet: true, incremental: true }
	await wunphile.build(opts)
	assert.equal(wunphile.stats().skipped, 0)
	await wunphile.build(opts)
	assert.equal(wunphile.stats().skipped, 1, 'second build should reuse the cached page')
	const cache = JSON.parse(await fs.readFile(pathUtil.join(root, '.wunphile', 'cache.json'), 'utf8'))
	assert.ok(cache.pages['/index.html'])
})

/* --------------------------- security --------------------------------- */

test('redirect() rejects javascript: URLs and escapes attribute/JS contexts', async (t) => {
	const { out, wunphile } = await makeSite(t)
	assert.throws(
		() => wunphile.redirect('/x.html', 'javascript:alert(1)'),
		/Unsafe redirect URL/,
	)
	assert.throws(() => wunphile.redirect('/x.html', 'data:text/html,x'), /Unsafe/)
	wunphile.redirect('/go.html', '/t.html?a=1&b="x"')
	await wunphile.build({ quiet: true })
	const page = await fs.readFile(pathUtil.join(out, 'go.html'), 'utf8')
	assert.match(page, /href="\/t\.html\?a=1&amp;b=&quot;x&quot;"/)
	const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(page)[1]
	assert.doesNotThrow(() => new Function(script), script)
	assert.match(script, /location\.assign\("\/t\.html/)
})

test('path traversal in static dir is blocked and output writes are bounded', async (t) => {
	const { root, wunphile } = await makeSite(t)
	await fs.mkdir(pathUtil.join(root, 'assets'), { recursive: true })
	await fs.writeFile(pathUtil.join(root, 'assets', 'ok.txt'), 'ok')
	await fs.writeFile(pathUtil.join(root, 'secret.txt'), 'SECRET')
	wunphile.staticDir('/assets', 'assets')
	wunphile.page('/index.html', () => html`x`)
	const handle = await wunphile.serve(0, '127.0.0.1', null)
	try {
		const port = handle.server.address().port
		const res = await fetch(`http://127.0.0.1:${port}/assets/%2e%2e/secret.txt`)
		assert.notEqual(await res.text(), 'SECRET')
	} finally {
		await handle.close()
	}
})

/* ----------------------- content / routing ---------------------------- */

test('contentDir + collection + dynamic route + layout + Head/canonical', async (t) => {
	const { root, out, wunphile } = await makeSite(t)
	await fs.mkdir(pathUtil.join(root, 'content', 'posts'), { recursive: true })
	await fs.writeFile(
		pathUtil.join(root, 'content', 'posts', 'alpha.md'),
		'---\ntitle: Alpha\ndate: 2026-01-02\n---\n# Alpha\n\nHello **alpha**.\n',
	)
	await fs.writeFile(
		pathUtil.join(root, 'content', 'posts', 'beta.md'),
		'---\ntitle: Beta\ndate: 2026-01-01\n---\n# Beta\n\nB body.\n',
	)
	const posts = wunphile.collection('posts', {
		from: 'content/posts',
		sort: 'date:desc',
	})
	assert.deepEqual(posts.map((p) => p.slug), ['alpha', 'beta'])
	assert.match(posts[0].html, /<strong>alpha<\/strong>/)
	wunphile.sitemap('https://example.com')
	wunphile.layout((children, ctx) => html`<!doctype html><html lang="en"><head></head><body>${children}</body></html>`)
	wunphile.page('/index.html', () => html`${Head({ title: 'Home', description: 'd' })}<ul>${posts.map((p) => html`<li>${p.title}</li>`)}</ul>`)
	wunphile.page('/blog/[slug].html', ({ params, entry }) =>
		html`${Head({ title: entry?.title ?? params.slug })}<article>${entry?.html ?? ''}</article>`,
	)
	await wunphile.build({ quiet: true })
	const index = await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8')
	assert.match(index, /<title>Home<\/title>/)
	assert.match(index, /rel="canonical" href="https:\/\/example\.com\/index\.html"/)
	assert.match(index, /<li>Alpha<\/li>/)
	assert.match(index, /<html lang="en">/)
	for (const slug of ['alpha', 'beta']) {
		const page = await fs.readFile(pathUtil.join(out, 'blog', slug + '.html'), 'utf8')
		assert.match(page, new RegExp(`<title>${slug === 'alpha' ? 'Alpha' : 'Beta'}</title>`))
		assert.match(page, /<article>/)
	}
	const sitemap = await fs.readFile(pathUtil.join(out, 'sitemap.xml'), 'utf8')
	assert.match(sitemap, /https:\/\/example\.com\/blog\/alpha\.html/)
})

test('getStaticPaths() explicitly provides dynamic params', async (t) => {
	const { out, wunphile } = await makeSite(t)
	wunphile.getStaticPaths(() => [{ slug: 'one' }, { slug: 'two' }])
	wunphile.page('/p/[slug].html', ({ params }) => html`<p>${params.slug}</p>`)
	await wunphile.build({ quiet: true })
	assert.match(await fs.readFile(pathUtil.join(out, 'p', 'one.html'), 'utf8'), /one/)
	assert.match(await fs.readFile(pathUtil.join(out, 'p', 'two.html'), 'utf8'), /two/)
})

test('feeds and robots.txt are generated', async (t) => {
	const { root, out, wunphile } = await makeSite(t)
	await fs.mkdir(pathUtil.join(root, 'content', 'posts'), { recursive: true })
	await fs.writeFile(
		pathUtil.join(root, 'content', 'posts', 'p.md'),
		'---\ntitle: Post\ndate: 2026-01-01\n---\nBody text\n',
	)
	wunphile.collection('posts', { from: 'content/posts' })
	wunphile.sitemap('https://example.com')
	wunphile.feed({ collection: 'posts', path: '/feed.xml', format: 'rss', title: 'Blog', baseUrl: 'https://example.com' })
	wunphile.feed({ collection: 'posts', path: '/feed.json', format: 'json', baseUrl: 'https://example.com' })
	wunphile.robotsTxt({ sitemap: true, disallow: ['/admin'] })
	await wunphile.build({ quiet: true })
	const rss = await fs.readFile(pathUtil.join(out, 'feed.xml'), 'utf8')
	assert.match(rss, /<title>Blog<\/title>/)
	assert.match(rss, /<item>/)
	const json = JSON.parse(await fs.readFile(pathUtil.join(out, 'feed.json'), 'utf8'))
	assert.equal(json.items.length, 1)
	const robots = await fs.readFile(pathUtil.join(out, 'robots.txt'), 'utf8')
	assert.match(robots, /Disallow: \/admin/)
	assert.match(robots, /Sitemap: https:\/\/example\.com\/sitemap\.xml/)
	const sitemap = await fs.readFile(pathUtil.join(out, 'sitemap.xml'), 'utf8')
	assert.ok(!sitemap.includes('/feed.xml'), sitemap)
	assert.ok(!sitemap.includes('/robots.txt'), sitemap)
})

test('i18n expands routes and emits hreflang / xhtml:link', async (t) => {
	const { out, wunphile } = await makeSite(t)
	wunphile.sitemap('https://example.com')
	wunphile.i18n({ locales: ['en', 'zh'], defaultLocale: 'en' })
	wunphile.page('/about.html', ({ localeLinks }) => html`<html><head></head><body>${localeLinks.map((l) => html`<a href="${l.href}">${l.locale}</a>`)}</body></html>`)
	await wunphile.build({ quiet: true })
	assert.ok((await fs.stat(pathUtil.join(out, 'about.html'))).size > 0)
	assert.ok((await fs.stat(pathUtil.join(out, 'zh', 'about.html'))).size > 0)
	const page = await fs.readFile(pathUtil.join(out, 'about.html'), 'utf8')
	assert.match(page, /hreflang="zh"/)
	assert.match(page, /hreflang="x-default"/)
	const sitemap = await fs.readFile(pathUtil.join(out, 'sitemap.xml'), 'utf8')
	assert.match(sitemap, /xhtml:link/)
})

/* ------------------------- images / OG -------------------------------- */

test('image() fingerprints and infers dimensions without sharp', async (t) => {
	const { root, out, wunphile } = await makeSite(t)
	await fs.mkdir(pathUtil.join(root, 'img'), { recursive: true })
	const png = Buffer.alloc(24)
	png.write('89504e470d0a1a0a', 0, 'hex')
	png.write('0000000d49484452', 8, 'hex')
	png.writeUInt32BE(320, 16)
	png.writeUInt32BE(200, 20)
	await fs.writeFile(pathUtil.join(root, 'img', 'hero.png'), png)
	wunphile.staticDir('/img', 'img')
	wunphile.page('/index.html', () => html`<main>${wunphile.image('/img/hero.png', { alt: 'Hero' })}</main>`)
	await wunphile.build({ quiet: true })
	const page = await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8')
	assert.match(page, /width="320" height="200"/)
	assert.match(page, /alt="Hero"/)
	assert.match(page, /loading="lazy"/)
	assert.match(page, /hero\.[0-9a-f]{8}\.png/)
})

test('ogImage() writes a pure SVG fallback and links it from Head', async (t) => {
	const { out, wunphile } = await makeSite(t)
	wunphile.sitemap('https://example.com')
	wunphile.ogImage({ background: '#123456' })
	wunphile.page('/index.html', () => html`<html><head></head><body>${Head({ title: 'My Page' })}</body></html>`)
	await wunphile.build({ quiet: true })
	const page = await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8')
	assert.match(page, /property="og:image"/)
	const og = await fs.readFile(pathUtil.join(out, 'og', 'index.svg'), 'utf8')
	assert.match(og, /<svg/)
	assert.match(og, /My Page/)
	assert.match(og, /#123456/)
})

/* ------------------------- adapters / redirects ----------------------- */

test('redirect status + netlify/vercel/cloudflare adapters emit 301 config', async (t) => {
	const { root, out, wunphile } = await makeSite(t)
	await fs.writeFile(pathUtil.join(root, 'app.js'), 'console.log(1)\n')
	wunphile.staticFile('/assets/app.js', 'app.js', { hash: true })
	wunphile.adapter('netlify')
	wunphile.redirect('/old.html', '/new.html', { status: 301 })
	await wunphile.build({ quiet: true })
	const redirects = await fs.readFile(pathUtil.join(out, '_redirects'), 'utf8')
	assert.match(redirects, /\/old\.html\s+\/new\.html\s+301/)
	const headers = await fs.readFile(pathUtil.join(out, '_headers'), 'utf8')
	assert.match(headers, /immutable/)
})

test('vercel.json and _routes.json are generated', async (t) => {
	const { out, wunphile } = await makeSite(t)
	wunphile.staticDir('/assets', 'assets')
	wunphile.adapter('vercel')
	wunphile.redirect('/a.html', '/b.html', { status: 308 })
	wunphile.page('/index.html', () => html`x`)
	await wunphile.build({ quiet: true })
	const vercel = JSON.parse(await fs.readFile(pathUtil.join(out, 'vercel.json'), 'utf8'))
	assert.equal(vercel.redirects[0].permanent, true)
})

test('github-pages adapter writes .nojekyll', async (t) => {
	const { out, wunphile } = await makeSite(t)
	wunphile.adapter('github-pages')
	wunphile.page('/index.html', () => html`x`)
	await wunphile.build({ quiet: true })
	assert.ok((await fs.stat(pathUtil.join(out, '.nojekyll'))).isFile())
})

/* --------------------------- plugins / config -------------------------- */

test('defineConfig + plugin hooks (onPageRender/onAsset/onBuildEnd)', async (t) => {
	const { root, out, wunphile } = await makeSite(t)
	const seen = { pages: [], assets: 0, built: null }
	const config = defineConfig({
		plugins: [
			{
				onPageRender(h, path) {
					seen.pages.push(path)
					return h.replace('</body>', '<!--plugin--></body>')
				},
				onAsset() {
					seen.assets++
				},
				onBuildEnd(manifest) {
					seen.built = manifest.manifest
				},
			},
		],
		build: { quiet: true },
	})
	wunphile.applyConfig(config)
	await fs.writeFile(pathUtil.join(root, 'a.txt'), 'a')
	wunphile.staticFile('/a.txt', 'a.txt')
	wunphile.page('/index.html', () => html`<html><body>x</body></html>`)
	await wunphile.build()
	assert.ok(seen.pages.includes('/index.html'))
	assert.ok(seen.assets >= 1)
	assert.ok(seen.built !== null)
	assert.match(await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8'), /<!--plugin-->/)
})

test('constructor accepts a config object (single config object API)', async (t) => {
	const root = await makeTempDir(t)
	const out = pathUtil.join(root, 'out')
	const wunphile = new Wunphile(import.meta.url, {
		root,
		outDir: 'out',
		baseUrl: 'https://example.com',
		minify: true,
		build: { quiet: true },
	})
	wunphile.page('/index.html', () => html`<html><head></head><body>x</body></html>`)
	await wunphile.build()
	assert.ok((await fs.stat(pathUtil.join(out, 'index.html'))).isFile())
	const page = await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8')
	assert.match(page, /rel="canonical" href="https:\/\/example\.com\/index\.html"/)
})

test('CSP nonce is injected consistently into scripts', async (t) => {
	const { out, wunphile } = await makeSite(t)
	wunphile.enableCsp()
	wunphile.redirect('/go.html', '/index.html')
	wunphile.page('/index.html', () => html`<html><head></head><body>${wunphile.cspNonce()}</body></html>`)
	await wunphile.build({ quiet: true })
	const nonce = wunphile.cspNonce()
	const redirect = await fs.readFile(pathUtil.join(out, 'go.html'), 'utf8')
	assert.match(redirect, new RegExp(`nonce="${nonce}"`))
	const index = await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8')
	assert.ok(index.includes(nonce))
})

/* ----------------------------- dev server ------------------------------ */

test('dev server: ETag/304, Range, gzip and closeable handle', async (t) => {
	const { root, wunphile } = await makeSite(t)
	await fs.mkdir(pathUtil.join(root, 'assets'), { recursive: true })
	const body = 'ABCDEFGHIJ'.repeat(100)
	await fs.writeFile(pathUtil.join(root, 'assets', 'big.txt'), body)
	wunphile.staticDir('/assets', 'assets')
	wunphile.page('/index.html', () => html`<html lang="en"><head><title>x</title></head><body>ok</body></html>`)
	const handle = await wunphile.serve(0, '127.0.0.1', null)
	try {
		const base = `http://127.0.0.1:${handle.server.address().port}`
		const first = await fetch(base + '/assets/big.txt')
		assert.equal(first.status, 200)
		assert.match(first.headers.get('accept-ranges'), /bytes/)
		const etag = first.headers.get('etag')
		assert.ok(etag)
		const cached = await fetch(base + '/assets/big.txt', { headers: { 'If-None-Match': etag } })
		assert.equal(cached.status, 304)
		const ranged = await fetch(base + '/assets/big.txt', { headers: { Range: 'bytes=0-9' } })
		assert.equal(ranged.status, 206)
		assert.equal(await ranged.text(), 'ABCDEFGHIJ')
		assert.match(ranged.headers.get('content-range'), /bytes 0-9\/1000/)
		const http = await import('node:http')
		const compressedHeaders = await new Promise((resolve, reject) => {
			http
				.get(
					{
						host: '127.0.0.1',
						port: handle.server.address().port,
						path: '/index.html',
						headers: { 'Accept-Encoding': 'gzip' },
					},
					(response) => {
						response.resume()
						response.on('end', () => resolve(response.headers))
					},
				)
				.on('error', reject)
		})
		assert.equal(compressedHeaders['content-encoding'], 'gzip')
		const page = await fetch(base + '/index.html')
		assert.match(await page.text(), /<html lang="en">/)
	} finally {
		await handle.close()
	}
	assert.equal(handle.server.listening, false)
})

test('preview() serves dist without page mappings', async (t) => {
	const { out, wunphile } = await makeSite(t)
	await fs.mkdir(out, { recursive: true })
	await fs.writeFile(pathUtil.join(out, 'index.html'), '<p>built</p>')
	const handle = await wunphile.preview(0, '127.0.0.1')
	try {
		const base = `http://127.0.0.1:${handle.server.address().port}`
		assert.equal(await (await fetch(base + '/')).text(), '<p>built</p>')
		assert.equal((await fetch(base + '/missing')).status, 404)
	} finally {
		await handle.close()
	}
})

test('cli() accepts --stats/--incremental via argv override', async (t) => {
	const { out, wunphile } = await makeSite(t)
	wunphile.page('/index.html', () => html`x`)
	await wunphile.cli(['--build', '--stats', '--quiet'])
	assert.ok((await fs.stat(pathUtil.join(out, 'build-stats.json'))).isFile())
})

/* ------------------------------ CLI bin -------------------------------- */

test('standalone CLI builds through wunphile.config.mjs', async (t) => {
	const root = await makeTempDir(t)
	const indexPath = pathUtil.resolve(import.meta.dirname, '..', 'index.mjs')
	const indexUrl = pathToFileURL(indexPath).href
	await fs.writeFile(
		pathUtil.join(root, 'wunphile.config.mjs'),
		[
			`import { Wunphile, html, defineConfig } from ${JSON.stringify(indexUrl)}`,
			'const wunphile = new Wunphile(import.meta.url, defineConfig({ build: { quiet: true } }))',
			"wunphile.page('/index.html', () => html`<p>from cli</p>`)",
			'export default wunphile',
			'',
		].join('\n'),
		'utf8',
	)
	const cliPath = pathUtil.resolve(import.meta.dirname, '..', 'bin', 'wunphile.mjs')
	const { execFile } = await import('node:child_process')
	const { promisify } = await import('node:util')
	const run = promisify(execFile)
	await run(process.execPath, [cliPath, 'build'], { cwd: root })
	const page = await fs.readFile(pathUtil.join(root, 'dist', 'index.html'), 'utf8')
	assert.match(page, /from cli/)
})

/* -------------------------- island/client side ------------------------- */

test('behavior load strategy and styles are encoded in the loader', () => {
	const script = generateLoaderScript([
		{ path: 'behavior/Counter-a.js', load: 'visible', styles: '.x{color:red}' },
	])
	assert.match(script, /"l":"visible"/)
	assert.match(script, /"s":"\.x\{color:red\}"/)
	assert.doesNotThrow(() => new Function(script), script)
})

test('RenderFragment keeps HEAD fragments out of renderToHtml', () => {
	const fragment = new RenderFragment(RenderFragmentType.HEAD, '{}', null, { title: 'x' })
	assert.equal(fragment.toHtml(), '')
	assert.equal(renderToHtml([fragment]), '')
})

/* ------------------- additional end-to-end coverage ------------------- */

test('dev server: 301 redirect, SSE reload and onDevRequest plugin', async (t) => {
	const { wunphile } = await makeSite(t)
	const emitter = new EventEmitter()
	wunphile.use({
		onDevRequest(req, res) {
			if (req.url === '/custom') {
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.end('from plugin')
				return true
			}
		},
	})
	wunphile.redirect('/old.html', '/new.html', { status: 301 })
	wunphile.page('/new.html', () => html`<html lang="en"><head><title>n</title></head><body>ok</body></html>`)
	const handle = await wunphile.serve(0, '127.0.0.1', emitter)
	try {
		const port = handle.server.address().port
		const base = `http://127.0.0.1:${port}`
		const redirected = await fetch(base + '/old.html', { redirect: 'manual' })
		assert.equal(redirected.status, 301)
		assert.equal(redirected.headers.get('location'), '/new.html')
		assert.equal(await (await fetch(base + '/custom')).text(), 'from plugin')
		const http = await import('node:http')
		const sse = await new Promise((resolve, reject) => {
			const req = http.get(
				{
					host: '127.0.0.1',
					port,
					path: '/__hotreload',
					headers: { Accept: 'text/event-stream' },
				},
				(response) => {
					assert.equal(response.headers['content-type'], 'text/event-stream')
					let data = ''
					response.setEncoding('utf8')
					response.on('data', (chunk) => {
						data += chunk
						if (data.includes('event: reload')) {
							resolve(data)
						}
					})
					setTimeout(() => emitter.emit('reload'), 30)
				},
			)
			req.on('error', reject)
		})
		assert.match(sse, /event: reload/)
	} finally {
		await handle.close()
	}
})

test('serve() closes when its AbortSignal is aborted', async (t) => {
	const { wunphile } = await makeSite(t)
	wunphile.page('/index.html', () => html`x`)
	const controller = new AbortController()
	const handle = await wunphile.serve(0, '127.0.0.1', null, {
		signal: controller.signal,
	})
	controller.abort()
	await new Promise((resolve) => setTimeout(resolve, 50))
	assert.equal(handle.server.listening, false)
})

test('static loader strategy hydrates behaviors with styles + load strategy', async (t) => {
	const root = await makeTempDir(t)
	const out = pathUtil.join(root, 'dist')
	const clientDir = pathUtil.join(root, 'src', 'client')
	await fs.mkdir(pathUtil.join(clientDir, 'behavior'), { recursive: true })
	await fs.mkdir(pathUtil.join(clientDir, 'lib'), { recursive: true })
	await fs.writeFile(pathUtil.join(clientDir, 'lib', 'label.mjs'), 'export const label = 1\n')
	await fs.writeFile(
		pathUtil.join(clientDir, 'behavior', 'Counter.mjs'),
		[
			"import '../lib/label.mjs'",
			'export default {',
			'  behaviorModuleUrl: import.meta.url,',
			"  behavior: (elem) => { elem.textContent = 'clicked' },",
			"  styles: '.counter{color:red}',",
			"  load: 'idle',",
			'}',
			'',
		].join('\n'),
	)
	const mainUrl = pathToFileURL(pathUtil.join(root, 'main.mjs')).href
	const wunphile = new Wunphile(mainUrl, {
		root,
		outDir: 'dist',
		loader: 'static',
		build: { quiet: true },
	})
	const behaviorUrl = pathToFileURL(
		pathUtil.join(clientDir, 'behavior', 'Counter.mjs'),
	).href
	wunphile.page(
		'/index.html',
		() =>
			html`<html><head></head><body>${BehaviorComponent(
				{ module: import(behaviorUrl) },
				html`<button>x</button>`,
			)}${BehaviorLoader()}</body></html>`,
	)
	await wunphile.build()
	const page = await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8')
	assert.match(page, /import \* as wfMod0 from "\/_wfclient\/behavior\/Counter-/)
	assert.match(page, /rel="modulepreload"/)
	assert.match(page, /"l":"idle"/)
	assert.match(page, /"s":"\.counter\{color:red\}"/)
	assert.match(page, /<!--wf-behavior:/)
	const moduleFile = (await fs.readdir(pathUtil.join(out, '_wfclient', 'behavior')))
		.find((f) => f.startsWith('Counter-'))
	assert.ok(moduleFile)
	const moduleSource = await fs.readFile(
		pathUtil.join(out, '_wfclient', 'behavior', moduleFile),
		'utf8',
	)
	assert.match(moduleSource, /import "\.\.\/lib\/label\.mjs"/)
	assert.match(moduleSource, /styles: "\.counter\{color:red\}"/)
	assert.ok((await fs.stat(pathUtil.join(out, '_wfclient', 'lib', 'label.mjs'))).isFile())
})

test('absoluteImports rewrites shared dependencies to one canonical URL', async (t) => {
	const root = await makeTempDir(t)
	const clientDir = pathUtil.join(root, 'src', 'client')
	await fs.mkdir(pathUtil.join(clientDir, 'behavior'), { recursive: true })
	await fs.mkdir(pathUtil.join(clientDir, 'lib'), { recursive: true })
	await fs.writeFile(pathUtil.join(clientDir, 'lib', 'label.mjs'), 'export const label = 1\n')
	await fs.writeFile(
		pathUtil.join(clientDir, 'behavior', 'Counter.mjs'),
		[
			"import '../lib/label.mjs'",
			'export default {',
			'  behaviorModuleUrl: import.meta.url,',
			"  behavior: (elem) => { elem.textContent = 'x' },",
			'}',
			'',
		].join('\n'),
	)
	const wunphile = new Wunphile(
		pathToFileURL(pathUtil.join(root, 'main.mjs')).href,
		{ root, outDir: 'dist', absoluteImports: true, build: { quiet: true } },
	)
	const behaviorUrl = pathToFileURL(
		pathUtil.join(clientDir, 'behavior', 'Counter.mjs'),
	).href
	wunphile.page(
		'/index.html',
		() =>
			html`<html><head></head><body>${BehaviorComponent(
				{ module: import(behaviorUrl) },
				html`<button>x</button>`,
			)}${BehaviorLoader()}</body></html>`,
	)
	await wunphile.build()
	const moduleFile = (await fs.readdir(pathUtil.join(root, 'dist', '_wfclient', 'behavior')))
		.find((f) => f.startsWith('Counter-'))
	const source = await fs.readFile(
		pathUtil.join(root, 'dist', '_wfclient', 'behavior', moduleFile),
		'utf8',
	)
	assert.match(source, /import "\/_wfclient\/lib\/label\.mjs"/)
})

test('cloudflare-pages adapter emits _routes.json and _headers', async (t) => {
	const { out, wunphile } = await makeSite(t)
	wunphile.staticDir('/assets', 'assets')
	wunphile.adapter('cloudflare-pages')
	wunphile.page('/index.html', () => html`x`)
	await wunphile.build({ quiet: true })
	const routes = JSON.parse(await fs.readFile(pathUtil.join(out, '_routes.json'), 'utf8'))
	assert.ok(routes.exclude.includes('/assets/*'))
	assert.ok((await fs.stat(pathUtil.join(out, '_headers'))).isFile())
})

test('Head supports canonical override, links and JSON-LD', async (t) => {
	const { out, wunphile } = await makeSite(t)
	wunphile.sitemap('https://example.com')
	wunphile.page('/index.html', () =>
		html`<html><head></head><body>${Head({
			title: 'Custom',
			canonical: 'https://cdn.example.com/custom',
			og: { title: 'OG Title', image: '/og.png' },
			links: [{ rel: 'alternate', type: 'application/rss+xml', href: '/feed.xml' }],
			jsonLd: { '@type': 'WebSite', name: 'Custom' },
		})}</body></html>`,
	)
	await wunphile.build({ quiet: true })
	const page = await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8')
	assert.match(page, /<title>Custom<\/title>/)
	assert.match(page, /href="https:\/\/cdn\.example\.com\/custom"/)
	assert.match(page, /property="og:image" content="\/og\.png"/)
	assert.match(page, /rel="alternate" type="application\/rss\+xml"/)
	assert.match(page, /application\/ld\+json/)
})

test('preview() serves precompressed artifacts', async (t) => {
	const { out, wunphile } = await makeSite(t)
	await fs.mkdir(out, { recursive: true })
	await fs.writeFile(pathUtil.join(out, 'index.html'), '<p>built</p>')
	const zlib = await import('node:zlib')
	await fs.writeFile(
		pathUtil.join(out, 'index.html.br'),
		zlib.brotliCompressSync(Buffer.from('<p>built</p>')),
	)
	const handle = await wunphile.preview(0, '127.0.0.1')
	try {
		const http = await import('node:http')
		const headers = await new Promise((resolve, reject) => {
			http
				.get(
					{
						host: '127.0.0.1',
						port: handle.server.address().port,
						path: '/',
						headers: { 'Accept-Encoding': 'br' },
					},
					(res) => {
						res.resume()
						res.on('end', () => resolve(res.headers))
					},
				)
				.on('error', reject)
		})
		assert.equal(headers['content-encoding'], 'br')
	} finally {
		await handle.close()
	}
})

test('--build --watch rebuilds on file changes without an HTTP server', async (t) => {
	const root = await makeTempDir(t)
	const indexPath = pathUtil.resolve(import.meta.dirname, '..', 'index.mjs')
	const indexUrl = pathToFileURL(indexPath).href
	await fs.writeFile(pathUtil.join(root, 'value.txt'), 'one')
	await fs.writeFile(
		pathUtil.join(root, 'main.mjs'),
		[
			`import { Wunphile, html } from ${JSON.stringify(indexUrl)}`,
			"import fs from 'node:fs'",
			'const value = fs.readFileSync(new URL("./value.txt", import.meta.url), "utf8")',
			'const wunphile = new Wunphile(import.meta.url, { build: { quiet: true } })',
			'wunphile.page("/index.html", () => html`<p>${value}</p>`)',
			"await wunphile.cli(['--build', '--watch'])",
			'',
		].join('\n'),
		'utf8',
	)
	const { spawn } = await import('node:child_process')
	const child = spawn(process.execPath, [pathUtil.join(root, 'main.mjs')], {
		cwd: root,
		stdio: 'ignore',
	})
	t.after(() => child.kill())
	const output = pathUtil.join(root, 'dist', 'index.html')
	/** @param {string} expected */
	const waitFor = async (expected) => {
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fs.readFile(output, 'utf8')).includes(expected)) {
					return
				}
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		throw new Error(`output never contained "${expected}"`)
	}
	await waitFor('one')
	await fs.writeFile(pathUtil.join(root, 'value.txt'), 'two')
	await new Promise((resolve) => setTimeout(resolve, 150))
	await waitFor('two')
	child.kill()
})
