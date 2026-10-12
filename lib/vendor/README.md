# Vendored YAML parser

`yaml.mjs` bundles the parser from [yaml 2.8.1](https://github.com/eemeli/yaml/tree/v2.8.1),
copyright Eemeli Aro, under the [ISC license](yaml.LICENSE). It parses Copilot
agent frontmatter, including quoted strings, escapes, block scalars and aliases.
No npm install or Copilot internal API is needed at runtime.

Build tools: `yaml@2.8.1` and `esbuild@0.25.10`. In a temporary directory install
these exact versions, then create `yaml-entry.mjs` with:

```js
export { parse } from './node_modules/yaml/browser/index.js';
```

Build with:

```bash
node_modules/.bin/esbuild yaml-entry.mjs --bundle --format=esm --platform=neutral \
  --target=es2022 --minify --legal-comments=inline \
  --banner:js='// SPDX-License-Identifier: ISC
// yaml 2.8.1 (Eemeli Aro). Bundled parser; see yaml.LICENSE and README.md.' \
  --outfile=yaml.mjs
```

SHA-256 of the shipped bundle:
`58b11b0969cf51885afeeac4c68f5bd3eaed7a45492562187bcee05c0c7f3c1a`.
