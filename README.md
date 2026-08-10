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
- Schema-driven completion, hover and signature help for every simulator instruction.
- Live diagnostics for unknown instructions, missing/duplicate parameters, literal types, brackets, duplicate request tags and undefined dependencies. Request validation follows `let`, nested `for` loops and string interpolation in source order. It uses a 20,000-operation budget and skips request diagnostics when a document would exceed that bound.
- Variable type inlay hints, definition navigation, references and rename.
- Document symbols, loop folding and conservative indentation formatting.

The simulator file `rdsl-schema.json` is the authoritative instruction interface. `npm run sync-schema` refreshes the bundled snapshot and `npm run check-schema` rejects stale snapshots when the simulator repository is available next to this extension.

Settings:

- `rdsl.diagnostics.enable`: enable live diagnostics.
- `rdsl.inlayHints.enable`: show inferred variable types.

Space-separated legacy instructions and `endfor` loops are not supported.
