# ADR 0002: Fault-Tolerant YAML CST + Jinja2 Tokenizer Architecture

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

During interactive editing in VS Code, Ansible files are frequently in a half-typed, syntactically invalid state (e.g., trailing colons, unclosed Jinja2 `{{ ` braces, or unquoted Jinja2 expressions inside YAML mapping values). Standard YAML parsers throw fatal exceptions on malformed input, causing autocomplete and hover to stop working exactly when the user needs them most.

## Decision

1. We use the `yaml` npm package's Concrete Syntax Tree (`Parser` + `Composer` with `keepSourceTokens: true` and `prettyErrors: false`) so that syntax errors are collected as non-fatal diagnostics while preserving a partial AST with exact source offsets and 0-indexed line/column positions.
2. We pair the YAML CST/AST pass with a fault-tolerant Jinja2 lexical scanner that extracts:
   - Expression blocks (`{{ ... }}`)
   - Statement tags (`{% ... %}`)
   - Comment tags (`{# ... #}`)
   - Implicit Jinja expressions inside conditional keys (`when`, `changed_when`, `failed_when`, `until`, `assert.that`)
3. Every Jinja2 expression is tokenized into variable references (including dotted/bracketed paths like `res.results[0].item`), filter applications (`| default(...)`), test applications (`is defined`), and literals, even if closing delimiters are missing while typing.

## Consequences

- **Positive:** Autocomplete (`res.` or `{{ my_var`), hover tooltips, and diagnostics remain responsive on broken or incomplete lines and never crash the LSP server.
- **Negative:** Requires custom cursor-context recovery logic when a line ends with an incomplete `key:` or unclosed `{{`.
