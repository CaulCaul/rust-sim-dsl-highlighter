# Change Log

## 0.3.0

- Synchronize all 46 simulator instructions, including general transpose, GPE fusion/packing, MatMul tails and SP2.
- Validate complete constant expressions, negative floating-point parameters, numeric literals and string escapes; preserve 64-bit integer precision during request expansion.
- Check request-valued arguments and conservatively skip unresolved request names.
- Keep optional parameters out of instruction snippets and select signature help by argument name.
- Preserve parameter completion while editing an unclosed call with trailing whitespace.
- Distinguish named assignment from equality in TextMate highlighting.
- Provide offline language/grammar regression tests.

## 0.2.1

- Validate loop-generated request tags with bounded control-flow evaluation.
- Debounce diagnostics while editing large RDSL documents.

## 0.2.0

- Target the structured RDSL grammar with variables, expressions, named arguments and nested `for` loops.
- Read all instruction signatures from the simulator schema snapshot.
- Add diagnostics, completion, hover, signature help, semantic tokens, navigation, rename, symbols, folding and formatting.
- Add language configuration and schema consistency checks.

## 0.1.0

- Provide basic syntax highlighting and positional-argument inlay hints.
