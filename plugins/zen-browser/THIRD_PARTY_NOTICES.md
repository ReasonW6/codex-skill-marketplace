# Third-party components

The Zen Browser plugin's own source is distributed under the [MIT license](LICENSE).

The Windows x64 package redistributes the unmodified official **Node.js 24.21.0** executable. Node.js is copyright Node.js contributors and distributed under its MIT license, with additional third-party components and notices reproduced in the complete upstream [LICENSE](runtime/LICENSE.node.txt).

- Official distribution: [node-v24.21.0-win-x64.zip](https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip)
- Original archive SHA-256: `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`
- Unmodified node.exe SHA-256: `ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32`
- License SHA-256: `ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9`

The upstream executable retains its OpenJS Foundation Authenticode signature. The plugin ZIP, Firefox XPI and locally compiled Windows helpers are not signed by this project. Node redistribution does not imply endorsement by OpenJS, OpenAI, Mozilla or Zen.

React, React DOM and esbuild are development-only dependencies used by the integration fixtures. Their versions are pinned in package-lock.json; node_modules is excluded from the distributed plugin. The MCP and Native Messaging runtime use Node built-in modules only.
