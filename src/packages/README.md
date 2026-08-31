# Deep modules

Copy this shape when adding a package:

```text
src/packages/<name>/
├── index.ts       entry point
├── client.ts      optional additional entry point
├── lib/           private implementation
└── tests/         tests and fixtures
```

**Entry-point seam.** Import a package only through its entry points: the files at the package root. Anything in a subfolder is private implementation. A package's own implementation may import its internals freely.

**Tests through the interface.** Tests import their package and other packages through root entry points. They may share fixtures inside their own `tests/` folder, but they do not deep-import implementation.

**Flat packages and cycles.** Packages are immediate children of `src/packages`; packages do not nest, and dependency cycles are forbidden. Layering between packages is configured separately.

**Small entry points, not barrels.** Expose several focused root entry points when callers need distinct interfaces. Do not create one giant `index.ts` that re-exports an implementation subtree.

Run `bun run lint:boundaries` to check the seams, or `bun run check` for the complete repository gate. The `example/` package is a starter template to copy or delete.
