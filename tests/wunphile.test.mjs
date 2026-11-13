import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as pathUtil from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
	Wunphile,
	SSG,
	html,
	text,
	RenderFragment,
	RenderFragmentType,
	BehaviorLoader,
	BehaviorComponent,
	renderToHtml,
	sanitizeHtml,
	copyRecursive,
	ROOT_PATH_ENV_VAR,
	OUTPUT_PATH_ENV_VAR,
} from '../index.mjs'

const execFileAsync = promisify(execFile)
const indexPath = pathUtil.resolve(import.meta.dirname, '..', 'index.mjs')
const indexUrl = pathToFileURL(indexPath).href

/** Creates a temp directory that is removed when the test finishes. */
async function makeTempDir(t) {
	const dir = await fs.mkdtemp(pathUtil.join(os.tmpdir(), 'wunphile-test-'))
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	return dir
}

/**
 * Loads a test-only copy of index.mjs with two private members exposed.
 * The shipped file is untouched: no test hook enters the public API surface.
 */
async function loadInternals(t) {
	const src = await fs.readFile(indexPath, 'utf8')
	const patched =
		src
			.replaceAll(
				'#getPathRelativeToClientDir',
				'getPathRelativeToClientDir',
			)
			.replaceAll('#loadingModules', 'loadingModules')
			.replaceAll('#loadModule', 'loadModule')
			.replaceAll('#minifyHtmlString', 'minifyHtmlString') +
		'\n// Test-only hook. This copy lives in a temp directory.\nexport { ClientManager }\n'
	const dir = await makeTempDir(t)
	const file = pathUtil.join(dir, 'index.internals.mjs')
	await fs.writeFile(file, patched, 'utf8')
	return import(pathToFileURL(file).href)
}

/** Builds a minimal real project in a child process and returns its paths. */
async function runFixture(t, { minify = false } = {}) {
	const root = await makeTempDir(t)
	const out = pathUtil.join(root, 'dist')
	const clientDir = pathUtil.join(root, 'src', 'client')
	await fs.mkdir(pathUtil.join(clientDir, 'behavior'), { recursive: true })
	await fs.mkdir(pathUtil.join(clientDir, 'lib'), { recursive: true })
	await fs.writeFile(
		pathUtil.join(clientDir, 'lib', 'label.mjs'),
		"export const label = 'hydrated'\n",
		'utf8',
	)
	await fs.writeFile(
		pathUtil.join(clientDir, 'behavior', 'Counter.mjs'),
		[
			"import '../lib/label.mjs'",
			'export default {',
			'    behaviorModuleUrl: import.meta.url,',
			"    behavior: (elem) => { elem.textContent = 'hydrated' },",
			'}',
			'',
		].join('\n'),
		'utf8',
	)
	const mainSource = [
		`import { Wunphile, html, BehaviorComponent, BehaviorLoader } from ${JSON.stringify(indexUrl)}`,
		'const wunphile = new Wunphile(import.meta.url)',
		...(minify ? ['wunphile.minifyHtml()'] : []),
		"wunphile.sitemap('https://example.com')",
		"wunphile.page('/index.html', () => html`",
		'<!doctype html>',
		'<html><body>',
		'<p>keep   spaces</p>',
		"${BehaviorComponent({ module: import('./src/client/behavior/Counter.mjs') }, html`<button>Click</button>`)}",
		'${BehaviorLoader()}',
		'</body></html>`)',
		"wunphile.redirect('/go.html', '/index.html')",
		'await wunphile.build()',
		'',
	].join('\n')
	const mainPath = pathUtil.join(root, 'main.mjs')
	await fs.writeFile(mainPath, mainSource, 'utf8')
	// CWD differs from the project root on purpose: this exercises FIX #10.
	const { stdout, stderr } = await execFileAsync(
		process.execPath,
		[mainPath],
		{
			cwd: os.tmpdir(),
			env: {
				...process.env,
				[ROOT_PATH_ENV_VAR]: root,
				[OUTPUT_PATH_ENV_VAR]: out,
			},
		},
	)
	return { root, out, stdout, stderr }
}

function scriptBodyOf(pageHtml) {
	const match = /<script>([\s\S]*?)<\/script>/.exec(pageHtml)
	assert.ok(match, 'redirect page must contain an inline <script>')
	return match[1]
}

/* ---------------------------- P0 regressions --------------------------- */

test('1. RenderFragment.toHtml() covers every fragment type', () => {
	assert.equal(
		new RenderFragment(RenderFragmentType.TEXT, '<b>&"').toHtml(),
		'&lt;b&gt;&amp;&quot;',
	)
	assert.equal(
		new RenderFragment(RenderFragmentType.HTML, '<b>raw</b>').toHtml(),
		'<b>raw</b>',
	)
	assert.equal(
		new RenderFragment(RenderFragmentType.BEHAVIOR_MODULE, 'ignored').toHtml(),
		'',
	)
	assert.equal(
		new RenderFragment(
			RenderFragmentType.BEHAVIOR_MODULE_LOADER,
			'ignored',
		).toHtml(),
		'',
	)
	assert.throws(
		() => new RenderFragment(/** @type {any} */ (99), 'x').toHtml(),
		/Unknown fragment type: 99/,
	)
})

test('2. renderToHtml escapes interpolated text', () => {
	assert.match(renderToHtml(html`<p>${'<b>'}</p>`), /&lt;b&gt;/)
})

test('3. redirect() emits a syntactically valid <script>', async (t) => {
	const out = await makeTempDir(t)
	const wunphile = new Wunphile(import.meta.url)
	wunphile.overrideOutputPath(out)
	wunphile.redirect('/go.html', '/target.html?a=1&b="x"')
	await wunphile.build()
	const pageHtml = await fs.readFile(pathUtil.join(out, 'go.html'), 'utf8')
	const body = scriptBodyOf(pageHtml)
	assert.ok(!body.includes('[object Object]'), body)
	assert.doesNotThrow(() => new Function(body), body)
	assert.match(body, /location\.assign\("\/target\.html/)
})

test('4. #getPathRelativeToClientDir rejects Windows cross-drive paths', async (t) => {
	const { ClientManager } = await loadInternals(t)
	const root = await makeTempDir(t)
	const cm = new ClientManager(/** @type {any} */ ({}), root, () => root)
	cm.rootPath = 'C:\\proj\\client'
	// On Windows pathUtil.relative() returns an absolute "D:\..." path here;
	// the old startsWith('..') check turned it into ./D:/proj/client/x.js.
	assert.equal(
		cm.getPathRelativeToClientDir('D:\\proj\\client\\x.js'),
		null,
	)
	// A genuinely relative parent escape is still rejected.
	assert.equal(
		cm.getPathRelativeToClientDir('C:\\proj\\outside\\x.js'),
		null,
	)
})

test('5. #getPathRelativeToClientDir does not reject "..foo" filenames', async (t) => {
	const { ClientManager } = await loadInternals(t)
	const root = await makeTempDir(t)
	const cm = new ClientManager(/** @type {any} */ ({}), root, () => root)
	cm.rootPath = root
	assert.equal(
		cm.getPathRelativeToClientDir(pathUtil.join(root, '..foo.js')),
		'./..foo.js',
	)
	assert.equal(
		cm.getPathRelativeToClientDir(pathUtil.join(root, 'nested', 'a.js')),
		'./' + toPosix(pathUtil.join('nested', 'a.js')),
	)
	// The client directory itself is not a valid module path.
	assert.equal(cm.getPathRelativeToClientDir(root), null)
})

function toPosix(p) {
	return p.split('\\').join('/')
}

/* ------------------------- behaviour-fix regressions ------------------- */

test('6. minifyHtml keeps <!--wf-behavior:--> hydration comments', async (t) => {
	const { out, stderr } = await runFixture(t, { minify: true })
	const pageHtml = await fs.readFile(
		pathUtil.join(out, 'index.html'),
		'utf8',
	)
	assert.match(pageHtml, /<!--wf-behavior:/, stderr)
	assert.match(pageHtml, /<script type="module">/, stderr)
	// Conservative minify: repeated spaces in text nodes survive.
	assert.ok(pageHtml.includes('keep   spaces'), pageHtml + stderr)
	const { Wunphile: IWunphile } = await loadInternals(t)
	const probe = new IWunphile(import.meta.url)
	assert.equal(
		probe.minifyHtmlString('<p>a   b</p>  <em>x</em>'),
		'<p>a   b</p><em>x</em>',
	)
})

test('7. generateLoaderScript separates imports and deduplicates paths', async (t) => {
	const { ClientManager } = await loadInternals(t)
	const root = await makeTempDir(t)
	const cm = new ClientManager(/** @type {any} */ ({}), root, () => root)
	const script = cm.generateLoaderScript(['a/one.js', 'b/two.js'])
	assert.match(script, /\);\nimport\(/, script)
	assert.equal((script.match(/import\(/g) ?? []).length, 2)
	assert.ok(script.includes('"/_wfclient/a/one.js"'))
	assert.ok(script.includes('"/_wfclient/b/two.js"'))
	const deduped = cm.generateLoaderScript([
		'a\\one.js',
		'a/one.js',
	])
	assert.equal((deduped.match(/import\(/g) ?? []).length, 1)
	assert.equal(cm.generateLoaderScript([]), '')
})

test('8. waitForModules rejects on module load failures', async (t) => {
	const { ClientManager } = await loadInternals(t)
	const root = await makeTempDir(t)
	const cm = new ClientManager(/** @type {any} */ ({}), root, () => root)
	const err = new Error('injected module failure')
	cm.loadingModules.add(Promise.reject(err))
	await assert.rejects(() => cm.waitForModules(), (e) => e === err)

	// The real entry point must surface failures too, without leaving an
	// unhandled rejection behind.
	const cm2 = new ClientManager(/** @type {any} */ ({}), root, () => root)
	const err2 = new Error('behavior import failure')
	cm2.loadBehaviorModule(Promise.reject(err2))
	await assert.rejects(() => cm2.waitForModules(), (e) => e === err2)
})

test('9. sitemap excludes redirect and not-found pages, log uses real count', async (t) => {
	const out = await makeTempDir(t)
	const wunphile = new Wunphile(import.meta.url)
	wunphile.overrideOutputPath(out)
	wunphile.sitemap('https://example.com/')
	wunphile.page('/index.html', () => html`<p>home</p>`)
	wunphile.page('/about.html', () => html`<p>about</p>`)
	wunphile.redirect('/old.html', '/index.html')
	wunphile.notFoundPage(() => html`<p>404</p>`)

	const logs = []
	const originalLog = console.log
	console.log = (...args) => logs.push(args.join(' '))
	try {
		await wunphile.build()
	} finally {
		console.log = originalLog
	}
	const xml = await fs.readFile(pathUtil.join(out, 'sitemap.xml'), 'utf8')
	assert.ok(!xml.includes('/old.html'), xml)
	assert.ok(!xml.includes('/404.html'), xml)
	assert.ok(!xml.includes('_wfclient'), xml)
	assert.ok(xml.includes('https://example.com/index.html'))
	assert.ok(xml.includes('https://example.com/about.html'))
	assert.equal((xml.match(/<url>/g) ?? []).length, 2)
	assert.ok(
		logs.some((line) => line.includes('with 2 URLs')),
		logs.join('\n'),
	)
})

test('FIX #10: plain module mounts are relative to the project root, not CWD', async (t) => {
	const { ClientManager } = await loadInternals(t)
	const projectRoot = await makeTempDir(t)
	const clientDir = pathUtil.join(projectRoot, 'src', 'client')
	await fs.mkdir(pathUtil.join(clientDir, 'lib'), { recursive: true })
	const plainModule = pathUtil.join(clientDir, 'lib', 'label.mjs')
	await fs.writeFile(plainModule, 'export const label = 1\n', 'utf8')
	/** @type {[string, string][]} */
	const calls = []
	const fakeWunphile = {
		staticFile: (p, f) => calls.push([p, f]),
		pageRaw: () => {},
	}
	const cm = new ClientManager(fakeWunphile, clientDir, () => projectRoot)
	await cm.loadModule({ default: {} }, plainModule)
	assert.equal(calls.length, 1)
	assert.equal(calls[0][0], '/_wfclient/lib/label.mjs')
	assert.equal(calls[0][1], pathUtil.relative(projectRoot, plainModule))
	assert.equal(pathUtil.isAbsolute(calls[0][1]), false)
	// toProjectPath() must resolve back to the original file.
	assert.equal(pathUtil.join(projectRoot, calls[0][1]), plainModule)
})

/* --------------------------- naming refactor --------------------------- */

test('10. SSG is strictly the same class object as Wunphile', () => {
	assert.equal(SSG, Wunphile)
	assert.equal(SSG.name, 'Wunphile')
})

test('11. new SSG() and new Wunphile() expose identical APIs', async (t) => {
	const out = await makeTempDir(t)
	for (const Ctor of [SSG, Wunphile]) {
		const inst = new Ctor(import.meta.url)
		assert.equal(inst.page('/index.html', () => html`<p>x</p>`), undefined)
		assert.equal(inst.pageRaw('/raw.html', 'raw'), undefined)
		assert.equal(inst.redirect('/r.html', '/index.html'), undefined)
		assert.equal(inst.notFoundPage(() => html`404`), undefined)
		assert.equal(inst.staticDir('/assets', './assets'), undefined)
		assert.equal(inst.staticFile('/a.txt', './a.txt'), undefined)
		assert.equal(inst.minifyHtml(false), inst)
		assert.equal(inst.sitemap('https://example.com'), inst)
		assert.equal(inst.overrideRootPath(out), inst)
		assert.equal(inst.overrideOutputPath(out), inst)
		assert.equal(inst.overrideNotFoundPath('/404.html'), inst)
		assert.equal(typeof inst.toProjectPath('x'), 'string')
		assert.equal(typeof inst.toOutputPath('x'), 'string')
		assert.equal(typeof inst.build, 'function')
		assert.equal(typeof inst.serve, 'function')
		assert.equal(typeof inst.cli, 'function')
		assert.equal(typeof inst.preloadBehaviorModule, 'function')
	}
})

test('11b. all legacy exports remain available', () => {
	for (const name of [
		'Wunphile',
		'SSG',
		'html',
		'text',
		'RenderFragment',
		'RenderFragmentType',
		'BehaviorLoader',
		'BehaviorComponent',
		'renderToHtml',
		'sanitizeHtml',
		'copyRecursive',
	]) {
		assert.notEqual(
			{
				Wunphile,
				SSG,
				html,
				text,
				RenderFragment,
				RenderFragmentType,
				BehaviorLoader,
				BehaviorComponent,
				renderToHtml,
				sanitizeHtml,
				copyRecursive,
			}[name],
			undefined,
			name,
		)
	}
	assert.equal(ROOT_PATH_ENV_VAR, 'SSG_ROOT_PATH')
	assert.equal(OUTPUT_PATH_ENV_VAR, 'SSG_OUTPUT_PATH')
	assert.equal(typeof text`plain`, 'object')
	assert.equal(sanitizeHtml('<'), '&lt;')
})

/* --------------------------- integration smoke ------------------------- */

test('12. build() emits pages, loader, behavior module and valid redirect', async (t) => {
	const { out, stderr } = await runFixture(t)
	const files = await fs.readdir(out)
	assert.ok(files.includes('index.html'), stderr)
	assert.ok(files.includes('go.html'), stderr)
	assert.ok(files.includes('sitemap.xml'), stderr)
	const clientFiles = await fs.readdir(pathUtil.join(out, '_wfclient'), {
		recursive: true,
	})
	assert.ok(
		clientFiles.some((f) => String(f).includes('Counter-')),
		JSON.stringify(clientFiles) + stderr,
	)
	// The behavior module's plain import is resolved through a file: URL;
	// on Windows an unwrapped import() would have aborted the build.
	const behaviorFile = pathUtil.join(
		out,
		'_wfclient',
		String(
			clientFiles.find((f) => String(f).includes('Counter-')),
		),
	)
	assert.match(
		await fs.readFile(behaviorFile, 'utf8'),
		/import "\.\.\/lib\/label\.mjs"/,
	)
	const pageHtml = await fs.readFile(pathUtil.join(out, 'index.html'), 'utf8')
	assert.match(pageHtml, /<!--wf-behavior:/)
	assert.match(pageHtml, /<script type="module">/)
	assert.match(pageHtml, /import\("\/_wfclient\//)
	const redirectHtml = await fs.readFile(
		pathUtil.join(out, 'go.html'),
		'utf8',
	)
	const body = scriptBodyOf(redirectHtml)
	assert.ok(!body.includes('[object Object]'))
	assert.doesNotThrow(() => new Function(body))
	const xml = await fs.readFile(pathUtil.join(out, 'sitemap.xml'), 'utf8')
	assert.ok(!xml.includes('/go.html'))
	assert.ok(!xml.includes('_wfclient'))
})

test('12b. copyRecursive still creates nested directories', async (t) => {
	const root = await makeTempDir(t)
	const src = pathUtil.join(root, 'src')
	const dst = pathUtil.join(root, 'dst')
	await fs.mkdir(pathUtil.join(src, 'a', 'b'), { recursive: true })
	await fs.writeFile(pathUtil.join(src, 'a', 'b', 'x.txt'), 'x', 'utf8')
	await copyRecursive(src, dst)
	assert.equal(
		await fs.readFile(pathUtil.join(dst, 'a', 'b', 'x.txt'), 'utf8'),
		'x',
	)
})
