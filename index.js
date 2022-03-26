#!/usr/bin/node

/* Typedefs */
/**
 * @typedef SsgComponent
 * @type {(props: { [key: string]: any }, content: string | null) => string}
 */
/**
 * @typedef SsgContext
 * @type {{ [key: string]: any }}
 */

/* Constants */
const SSG_NAME = 'simple-js-ssg'
const SSG_VERSION = '1.0.0'

/* Program arguments */
const args = process.argv.slice(2, process.argv.length)

/* Imports */
const fs = require('fs')
const pathUtil = require('path')
const vm = require('vm')

/* Check args */
if(args.length < 1) {
	console.error(`
Usage: ${SSG_NAME} <project directory> [output directory]
If no output directory is given, the input name fill be used with "_out" appended to it.
`.trim())
	process.exit(1)
}

const projPath = pathUtil.resolve(args[0])
const outPath = pathUtil.resolve(args[1] || projPath+'_out')

/* Globals */
/**
 * Globally available components
 * @type {{ [key: string]: SsgComponent }}
 */
const COMPONENTS = {
	ssgInfo: (_props, _content) => `${SSG_NAME} ${SSG_VERSION}`
}
/**
 * Globally available context data
 * @type {SsgContext}
 */
const CONTEXT = {}

/* Utils */
const exists = fs.existsSync
const readdir = fs.readdirSync
const readFile = fs.readFileSync
const writeFile = fs.writeFileSync
const mkdir = fs.mkdirSync
const rm = fs.rmSync
const stat = fs.statSync
const copyFile = fs.copyFileSync
const isDir = path => {
	try {
		return stat(path).isDirectory()
	} catch(err) {
		return false
	}
}
const isFile = path => {
	try {
		return stat(path).isFile()
	} catch(err) {
		return false
	}
}

function copyRecursive(source, target) {
	// Stat to check if it's a directory
	if(!stat(source).isDirectory()) {
		// If it's not a directory, just copy it
		copyFile(source, target)
		return
	}

	// Since the path is a directory, stat target to make sure the function can do what it needs to
	try {
		const targetStat = stat(target)
		if(!targetStat.isDirectory())
			throw new Error(`Cannot copy from source ${source} to non-directory target ${target}`)
	} catch(err) {
		// If not found, just create it
		if(err.code === 'ENOENT')
			mkdir(target, { recursive: true })
		else
			throw err
	}

	const paths = ['']

	// Loop util there are no more paths to crawl
	while(paths.length > 0) {
		const path = paths.shift()

		// List children
		const files = readdir(pathUtil.join(source, path))
		for(const file of files) {
			const childPath = pathUtil.join(path, file)
			const realPath = pathUtil.join(source, childPath)
		
			// Check if path is a directory, adding to paths list if it is, otherwise copying the file
			const targetPath = pathUtil.join(target, childPath)
			if(stat(realPath).isDirectory()) {
				mkdir(targetPath)
				paths.push(childPath)
			} else {
				copyFile(realPath, targetPath)
			}
		}
	}
}

/**
 * Sanitizes the provided HTML by escaping HTML entities
 * @param {string} html The HTML to sanitize
 * @returns {string} The sanitized HTML
 * @since 1.0.0
 */
function $(html) {
	return (html || '').toString()
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/* Main functions */
/**
 * Registers a new component
 * @param {string} name The component name
 * @param {SsgComponent} component The component to register
 * @since 1.0.0
 */
function registerComponent(name, component) {
	COMPONENTS[name] = component
}

/**
 * Gets the component with the specified name, if any
 * @param name
 * @return {SsgComponent | undefined}
 */
function getComponent(name) {
	return COMPONENTS[name]
}

/**
 * Assigns some new data to the global context data object
 * @param {string} key The key
 * @param {any} value The value
 * @since 1.0.0
 */
function setContext(key, value) {
	CONTEXT[key] = value
}

/**
 * Gets the value with the specified key from the global context data object, if any
 * @param {string} key The key
 * @return {any | undefined}
 * @since 1.0.0
 */
function getContext(key) {
	return CONTEXT[key]
}

/**
 * Creates a function from a template
 * @param {string} template The template to process
 * @param {Context} context Additional context data to make available to the template
 * @param {SsgComponent[]} components Additional components to make available to the template
 * @returns {() => string} The template function
 * @since 1.0.0
 */
function createTemplateFunction(template, context = {}, components = []) {
	return vm.runInNewContext('(() => `'+template+'`)', vm.createContext({ ...CONTEXT, ...COMPONENTS, ...context, $ }))
}

/**
 * Processes a template and returns its output
 * @param {string} template The template to process
 * @param {Context} context Additional context data to make available to the template
 * @param {SsgComponent[]} components Additional components to make available to the template
 * @returns {string} The template output
 * @since 1.0.0
 */
function template(template, context = {}, components = []) {
	return createTemplateFunction(template, context, components)()
}

function page(path, content) {
	const out = pathUtil.join(outPath, path)
	const dir = pathUtil.dirname(out)

	// Create dir if it doesn't exist
	if(!exists(dir))
		mkdir(dir, { recursive: true })

	// Write content
	writeFile(out, content)
}

/**
 * Renders a template file
 * @param {string} path The path to the template file
 * @return {string} The rendered template file
 * @since 1.0.0
 */
function fromTemplate(path) {
	return template(readFile(path).toString('utf8'))
}

/**
 * Loads and executes a script, then returns its exported value
 * @param {string} path The path to the script
 * @return {string} The script's exported value
 * @since 1.0.0
 */
function fromScript(path) {
	return require(path)
}

/**
 * Creates a component from a template file
 * @param {string} path The path to the template file
 * @return {SsgComponent} The newly created component
 * @since 1.0.0
 */
function componentFromTemplate(path) {
	return (props, content) => template(readFile(path).toString('utf8'), { ...props, content })
}

/**
 * Copies a file (or directory) from a path in the project to a path in the output directory
 * @param {string} inFile The input path
 * @param {string} outFile The output path
 * @since 1.0.0
 */
function copy(inFile, outFile) {
	const realIn = pathUtil.join(projPath, inFile)
	const realOut = pathUtil.join(outPath, outFile)

	copyRecursive(realIn, realOut)
}

/**
 * Sets the specified directory as the static directory
 * @param {string} dir The static directory
 * @since 1.0.0
 */
function staticDir(dir) {
	const path = pathUtil.join(projPath, dir)
	readdir(path).forEach(file => {
		copyRecursive(pathUtil.join(path, file), pathUtil.join(outPath, file))
	})
}

/**
 * Returns the real path on disk of the specified project path
 * @param {string} path The relative project path
 * @return {string} The real path on disk
 */
function toProjectPath(path) {
	return pathUtil.join(projPath, path)
}

/**
 * Returns the real path on disk of the specified output path
 * @param {string} path The relative output path
 * @return {string} The real path on disk
 */
function toOutputPath(path) {
	return pathUtil.join(outPath, path)
}

/* Main program */
// Check for index.js
const indexPath = pathUtil.join(projPath, 'index.js')
if(!isFile(indexPath)) {
	console.error(`No index.js file found in ${projPath}, you need to create one first`)
	process.exit(1)
}

// Change paths
process.chdir(projPath)
delete require.cache[Object.keys(require.cache)[0]]

// Create require cache entry
const ssgPath = pathUtil.join(projPath, 'ssg.js')
writeFile(ssgPath, '')
require(ssgPath)
require.cache[ssgPath].exports = {
	SSG_NAME,
	SSG_VERSION,
	PROJECT_PATH: projPath,
	OUTPUT_PATH: outPath,
	CONTEXT,
	COMPONENTS,
	getContext,
	getComponent,
	registerComponent,
	setContext,
	template,
	createTemplateFunction,
	componentFromTemplate,
	page,
	copy,
	staticDir,
	fromTemplate,
	fromScript,
	$,
	toProjectPath,
	toOutputPath
}
rm(ssgPath)

// Create output directory
if(!exists(outPath))
	mkdir(outPath)

// Require index.js
require(indexPath)
