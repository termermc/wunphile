#!/usr/bin/env node
/**
 * Standalone Wunphile CLI (#27).
 *
 *   wunphile build
 *   wunphile dev
 *   wunphile preview
 *   wunphile build --stats --incremental --precompress
 *
 * Looks for `wunphile.config.mjs` (also .js / .mts / .wunphile.config.mjs)
 * in the current directory. The config may export:
 *   - a Wunphile instance (recommended),
 *   - an (async) function returning a Wunphile instance,
 *   - a plain config object with an `entry` pointing at a module whose
 *     default export is a Wunphile instance.
 */
import process from 'node:process'
import * as fs from 'node:fs/promises'
import * as pathUtil from 'node:path'
import { pathToFileURL } from 'node:url'

const configNames = [
	'wunphile.config.mjs',
	'wunphile.config.js',
	'wunphile.config.mts',
	'.wunphilerc.mjs',
]

/**
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function findConfig(dir) {
	for (const name of configNames) {
		const candidate = pathUtil.join(dir, name)
		try {
			const stat = await fs.stat(candidate)
			if (stat.isFile()) {
				return candidate
			}
		} catch {}
	}
	return null
}

const rawArgs = process.argv.slice(2)
const command = rawArgs.find((arg) => !arg.startsWith('-'))
const rest = rawArgs.filter((arg) => arg !== command || arg.startsWith('-'))
const knownCommands = new Set(['build', 'dev', 'preview'])
const cliArgs = knownCommands.has(String(command))
	? [
			command === 'build' ? '--build' : command === 'dev' ? '--dev' : '--preview',
			...rest,
		]
	: rawArgs

const cwd = process.cwd()
const configPath = await findConfig(cwd)
if (configPath === null) {
	console.error(
		`Could not find a Wunphile config in "${cwd}". Create wunphile.config.mjs exporting a Wunphile instance.`,
	)
	process.exit(1)
}

let exported = (await import(pathToFileURL(configPath).href)).default
if (typeof exported === 'function') {
	exported = await exported()
}

/** @type {any} */
let instance = exported
if (instance == null || typeof instance.cli !== 'function') {
	// Plain config object: apply path overrides before loading the entry.
	const config = instance ?? {}
	if (config.root) {
		process.env.WUNPHILE_ROOT_PATH = pathUtil.resolve(
			pathUtil.dirname(configPath),
			config.root,
		)
	} else {
		process.env.WUNPHILE_ROOT_PATH = pathUtil.dirname(configPath)
	}
	if (config.outDir) {
		process.env.WUNPHILE_OUTPUT_PATH = pathUtil.resolve(
			process.env.WUNPHILE_ROOT_PATH,
			config.outDir,
		)
	}
	if (config.notFoundPath) {
		process.env.WUNPHILE_NOT_FOUND_PATH = config.notFoundPath
	}
	const entry = config.entry ?? './src/index.mjs'
	const entryPath = pathUtil.resolve(pathUtil.dirname(configPath), entry)
	const entryMod = await import(pathToFileURL(entryPath).href)
	instance = entryMod.default ?? entryMod.wunphile
	if (instance == null || typeof instance.cli !== 'function') {
		console.error(
			`The entry module "${entryPath}" must default-export a Wunphile instance.`,
		)
		process.exit(1)
	}
	if (typeof instance.applyConfig === 'function') {
		instance.applyConfig(config)
	}
}

await instance.cli(cliArgs)
