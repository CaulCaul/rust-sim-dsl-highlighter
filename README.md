# RDSL Language Support

VS Code language support for the structured RDSL consumed by `rust-sim`.

The extension targets the current grammar only:

```rdsl
let rows = 2708;
let tile_rows = 128;

CNewMatrix(
    tag = "init_output",
    rq = [],
    matrix = "output",
    shape = [rows, 16],
    fmt = "RHybrid",
);

for row in range(0, rows, tile_rows) {
    CLoadTile(
        tag = "load_${row}",
        rq = ["init_output"],
        matrix = "output",
        tile = [row, min(row + tile_rows, rows), 0, 16],
    );
}
```

Provided language features:

- TextMate and semantic highlighting for declarations, references, instructions and named parameters.
- Schema-driven completion, hover and signature help for all 46 simulator instructions. Instruction snippets include required parameters; optional parameters remain available through parameter completion and use their schema defaults where provided. Signature help follows parameter names, including calls with reordered arguments.
- Live diagnostics for unknown instructions, missing/duplicate parameters, constant-expression types, brackets, invalid string escapes and numeric literals, duplicate request tags and undefined request references (`rq`, `from_request`, `storage_request`). Request validation follows `let`, nested `for` loops and string interpolation in source order. It uses a 20,000-operation budget and skips request diagnostics when expansion exceeds that bound or a request name cannot be evaluated reliably.
- Variable type inlay hints, definition navigation, references and rename.
- Document symbols, loop folding and conservative indentation formatting.

The simulator file `rdsl-schema.json` is the authoritative instruction interface. `npm run sync-schema` refreshes the bundled snapshot and `npm run check-schema` rejects stale snapshots when the simulator repository is available next to this extension.

The instruction interface includes `CTrfTile` and its `CTrfTileD` compatibility alias, the `GPack*` and `GFused*` families, `GMatMulTail`, `GTrace`, and `GSp2UpdateTile`. Operations such as `Reciprocal` are string values of existing GPE instructions, rather than separate RDSL instructions. Parameter names and types come from the schema; runtime operation and matrix-format constraints remain the simulator's responsibility.

Constant-expression analysis distinguishes 64-bit unsigned integers from floating-point values. Integer arithmetic retains full precision and uses integer division; floating-point division and negative floating-point parameters such as `alpha = -1.0` are supported. `min`, `max`, and `ceil_div` take integers. Arrays, builtin calls, and `range` allow trailing commas. Strings support `\\`, `\"`, `\n`, `\r`, `\t`, and scalar `${name}` interpolation.

Editor diagnostics are a bounded, conservative check, not a replacement for the simulator parser or runtime validation. Variable-dependent parameter types, matrix existence and dimensions, supported operation/format combinations, and hardware constraints are not fully checked. Variable navigation and rename currently match names in the document rather than resolving block shadowing; interpolation references are highlighted and evaluated for request checking but are not included in variable rename. Avoid renaming a shadowed variable through this provider.

Settings:

- `rdsl.diagnostics.enable`: enable live diagnostics.
- `rdsl.inlayHints.enable`: show inferred variable types.

Space-separated legacy instructions and `endfor` loops are not supported.

Development checks:

```bash
npm run sync-schema
npm run test:unit
npm run lint
npm test
```

`test:unit` runs the language and grammar regressions without starting or downloading VS Code. `npm test` runs the extension-host tests through `@vscode/test-cli` and may download its VS Code test runtime if no matching installation is available. The packaged extension is `rust-sim-dsl-highlighter-0.3.0.vsix`; install it using **Extensions: Install from VSIX** and reload the VS Code window.
