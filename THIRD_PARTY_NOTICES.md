# Third-Party Notices & License Attribution

**Ansible Lens** is licensed under the [MIT License](./LICENSE).

> _Ansible Lens is an independent, community-built extension and is not affiliated with or endorsed by Red Hat, Inc. Ansible® is a registered trademark of Red Hat, Inc._

## Clean-Room MIT License Guarantee

All parsing, workspace intelligence, static lint rules, and Quick-Fix code actions in Ansible Lens are implemented from scratch in TypeScript using only publicly documented YAML 1.2 and Ansible module/collection specifications. **No GPL-licensed source code** (including `ansible/ansible` or `ansible/ansible-lint`) is copied, translated, or derived anywhere in this repository.

---

## Runtime & Build Dependencies

### `yaml`

- **Author:** Eemeli Aro
- **Repository:** https://github.com/eemeli/yaml
- **License:** ISC (Permissive, MIT-compatible)
- **Usage:** Concrete Syntax Tree (CST) and fault-tolerant YAML 1.2 parsing in `@ansible-lens/core`.

### `vscode-languageserver`, `vscode-languageclient`, `vscode-languageserver-protocol`, `vscode-languageserver-textdocument`, `vscode-uri`

- **Author:** Microsoft Corporation
- **Repository:** https://github.com/microsoft/vscode-languageserver-node
- **License:** MIT
- **Usage:** Language Server Protocol transport, document synchronization, and VS Code client integration in `@ansible-lens/server` and `packages/client`.

---

## Grammar Inspiration & References

### TextMate Jinja2 Injection Grammar Patterns

- **Reference:** `ansible/vscode-ansible` (https://github.com/ansible/vscode-ansible)
- **License:** MIT License
- **Attribution:** The non-invasive `source.yaml` Jinja2 TextMate injection grammar scope conventions (`{{ ... }}`, `{% ... %}`, `{# ... #}`) in `packages/client` follow standard MIT-licensed VS Code YAML/Jinja2 TextMate injection patterns inspired by `ansible/vscode-ansible`.

---

## Metadata Extraction (Build-Time Only)

- Static module `DOCUMENTATION` and `RETURN` metadata schemas distributed in `.json.gz` packs are generated at build time in CI by querying `ansible-doc -t module --metadata-dump` for factual module signatures, parameter types, choices, and return field schemas. No GPL runtime code is bundled with or executed by Ansible Lens.
