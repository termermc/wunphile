# Wunphile

Simple, imperative JavaScript-based static site generator, compatible with Node.js, Deno (2.0+), and Bun.

## About

Wunphile (pronounced "one file") allows you to build your site as if it was an Express-like app, but generate a nice, static bundle.

Below is what a simple blog site might look like:

```js
import config from './config.js'

import { Wunphile, html } from 'wunphile'
import { getAllBlogPosts } from './util/blog.js'

import IndexPage from './component/page/IndexPage.js'
import BlogPostPage from './component/page/BlogPostPage.js'

const ssg = new Wunphile(import.meta.url)

// We use the `page` to register components for pages.
ssg.page('/index.html', IndexPage)

// Components are simply functions that return HTML using the "html" template function.
// Similarly to React, strings interpolated into the template function will be sanitized.
// The "html" template function takes in a template string and returns React-style RenderFragments.
// No JSX needed!
ssg.page('/test.html', () => html`<h1>Hello from ${config.siteName}!</h1>`)

// We can write any logic we want to drive site generation.
// The "getAllBlogPosts" function could be reading markdown files from a directory,
// pulling from a database, or even fetching data from an API.
for (const post of await getAllBlogPosts()) {
    ssg.page(`/blog/${post.slug}/index.html`, () => new BlogPostPage({ post }))
}

// We mount static files from a local "assets" directory to the "/static" path.
// So if there is a file named "logo.png" in the "assets" directory, it will be served at "/static/logo.png".
ssg.staticDir('/static', './assets')

// We can also mount individual static files.
// The line below will mount the local file "./metadata-files/favicon.ico" to the "/favicon.ico" path.
ssg.staticFile('/favicon.ico', './metadata-files/favicon.ico')

// Runs the site generator CLI.
// The CLI can build the site or serve it on a local HTTP server for development.
await ssg.cli()
```

The above code will look very familiar to anyone who has used Express or a similar imperative-style web framework.
Paths are mapped to functions that return HTML, static directories are mounted, etc.

Unlike backend frameworks, however, Wunphile generates all the HTML and files at build time. It writes everything to an output directory,
ready to be served by a traditional webserver such as Nginx or Caddy.

Its goal is to live up to the following qualities:

### Simple

Unlike a framework such as Astro or Next.js, this library does not perform any magic or postprocessing on the HTML.
Instead, it simply acts as a wrapper around your own logic that handles all the filesystem operations for you and provides an
abstraction for paths, components and static files. Because it does not do any postprocessing, what you write is what you get,
even down to whitespace and indentation.

Since it does not perform any transformations on input, it does not rely on a build system or transpiler.
This means that it can avoid the weight and headache of a core dependency on a tool like Webpack.
Sites made with this library are likely to work many years down the road due to it using almost entirely standard JavaScript APIs,
along with a handful of Node.js APIs for interacting with the filesystem.

### Pure JavaScript

This library consists of a single pure JavaScript file, and building<sup>1</sup> has no dependencies other than Node.js APIs.
Instead of using JSX, it takes advantage of the JavaScript template literal syntax to provide a simple, safe API for writing HTML.

While it is not written in TypeScript, the library is fully typed and documented using JSDoc.

Because it is written in JavaScript, it can be used in any non-browser environment, including Deno (2.0+) and Bun.
In fact, due to it only being a single file with no external build dependencies, it can be used in projects without even needing a package manager!

<sup>1</sup> While building has no external dependencies, development mode has some minimal dependencies to handle MIME resolution and filesystem watching.

### Static

Instead of trying to be a full-stack framework, this library is designed only with static site generation in mind.
It is not a framework for building web apps, and does not provide any dynamic routing or middleware.

More complicated frontend integration is out of the scope of this library, but there is nothing stopping developers
from using it as a basis for a framework that does provide such features.

## Development Mode and Hot Reloading

When the `cli` method is called with the `--dev` or `-d` option, a development server will be started.

The development server will watch the project root directory for changes and hot reload the site when changes are detected.

While in development mode, the site will not be built and the filesystem will not be touched.
Instead, the site will be served from an embedded HTTP server.

Whenever the site is hot reloaded, pages open in the browser will be automatically reloaded through a small script injected into pages in development mode.
This can be disabled by setting the `SSG_DEV_NO_INJECT` environment variable to `1`.

To disable hot reloading entirely, set the `SSG_DEV_NO_HOT_RELOAD` environment variable to `1`.

Note that whenever the site is hot reloaded, the main module will be re-run in a worker thread.
This means that the main module should not contain any extra code besides what is necessary to build the site.

## Installation

<details>
<summary>Using NPM</summary>
<code lang="shell">npm install --save-dev wunphile</code>
</details>

<details>
<summary>Using PNPM</summary>
<code lang="shell">pnpm add --save-dev wunphile</code>
</details>

<details>
<summary>Using Yarn</summary>
<code lang="shell">yarn add --dev wunphile</code>
</details>

<details>
<summary>Without a package manager</summary>
To use this library without a package manager, copy the library `index.mjs` file to your project and import it.

Note that the development mode CLI is not available in this case, because required dependencies for it are not included.

</details>

Note that your project must support ESM (ES2022 modules) to import the library.

## CLI Usage

If your project calls the `cli` method, it will act as a CLI for building and serving the site.

If run with no arguments, it will build the site.

If run with `--dev` or `-d`, it will start a development server.

See the `--help` option for more information about the CLI and environment variables that can be used to configure it.

## Example Project

You can look at an example project that implements a simple blog site [here](https://git.termer.net/termer/wunphile-template).

## IDE Integration

Wunphile uses ES6 template literals for composing HTML.
Different IDEs need different configuration to provide syntax highlighting and intellisense for HTML inside template literals.

### VS Code

Install the [es6-string-html](https://marketplace.visualstudio.com/items?itemName=Tobermory.es6-string-html) extension.

### JetBrains IDEs

Recent versions of JetBrains IDEs should support syntax highlighting and intellisense for HTML inside template literals out of the box.
