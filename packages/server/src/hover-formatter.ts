import type {
  InferredRegisteredVariable,
  InferredReturnField,
  ModuleMetadataSpec,
  ModuleOptionSpec,
  ModuleReturnFieldSpec,
  ResolvedVariable,
} from '@ansible-lens/core';

/**
 * Formats a Pylance-style Markdown hover card for an Ansible module.
 * Always keeps the clickable `Open Official Docs` link at the top of the hover card.
 */
export function formatModuleHoverMarkdown(mod: ModuleMetadataSpec): string {
  const lines: string[] = [
    `### \`${mod.fqcn}\` — [Open Official Docs](${mod.docUrl})`,
    `*Collection:* \`${mod.collection}\``,
    '',
    mod.shortDescription,
    '',
    mod.description,
  ];

  const optionEntries = Object.values(mod.options);
  if (optionEntries.length > 0) {
    lines.push('', '#### Parameters', '');
    lines.push('| Name | Type | Required | Default | Description |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const opt of optionEntries.slice(0, 12)) {
      const req = opt.required ? 'yes' : 'no';
      const def = opt.default !== undefined ? `\`${JSON.stringify(opt.default)}\`` : '—';
      const desc = opt.description.replaceAll('\\', '\\\\').replaceAll('|', '\\|');
      lines.push(`| \`${opt.name}\` | \`${opt.type}\` | ${req} | ${def} | ${desc} |`);
    }
    if (optionEntries.length > 12) {
      lines.push(`| _...and ${optionEntries.length - 12} more_ | | | | |`);
    }
  }

  const returnEntries = Object.values(mod.returnFields);
  if (returnEntries.length > 0) {
    lines.push('', '#### Return Values', '');
    for (const ret of returnEntries.slice(0, 8)) {
      lines.push(
        `- \`${ret.name}\` (\`${ret.type}\`, returned: *${ret.returned}*): ${ret.description}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Formats a hover card for a specific module parameter or suboption.
 * Places the clickable `Open Official Docs` deep `#parameter-*` link at the top.
 */
export function formatParameterHoverMarkdown(
  mod: ModuleMetadataSpec,
  opt: ModuleOptionSpec,
): string {
  const paramUrl = `${mod.docUrl}#parameter-${opt.name}`;
  const lines: string[] = [
    `### \`${mod.fqcn}\` — Parameter \`${opt.name}\` ([Open Official Docs](${paramUrl}))`,
    '',
    `- **Type:** \`${opt.type}\`${opt.elements ? ` (elements: \`${opt.elements}\`)` : ''}`,
    `- **Required:** ${opt.required ? 'yes' : 'no'}`,
  ];
  if (opt.default !== undefined) {
    lines.push(`- **Default:** \`${JSON.stringify(opt.default)}\``);
  }
  if (opt.choices && opt.choices.length > 0) {
    lines.push(`- **Choices:** ${opt.choices.map((c) => `\`${String(c)}\``).join(', ')}`);
  }
  if (opt.aliases && opt.aliases.length > 0) {
    lines.push(`- **Aliases:** ${opt.aliases.map((a) => `\`${a}\``).join(', ')}`);
  }
  lines.push('', opt.description);
  return lines.join('\n');
}

/**
 * Formats a hover card for a `register:` variable root.
 * Places the clickable `Open Official Docs` link at the top when module metadata is available.
 */
export function formatRegisteredVarHoverMarkdown(
  reg: InferredRegisteredVariable,
  mod?: ModuleMetadataSpec,
): string {
  const topLink = mod ? ` — [Open Official Docs](${mod.docUrl}#return-values)` : '';
  const lines: string[] = [
    `### Registered Variable \`${reg.name}\`${topLink}`,
    '',
    `- **Source Module:** \`${reg.moduleFqcn}\``,
    ...(reg.taskName ? [`- **Task:** ${reg.taskName}`] : []),
    `- **Loop Task:** ${reg.isLoop ? 'yes (`results` list populated)' : 'no'}`,
    '',
    '#### Available Return Fields',
  ];
  for (const field of Object.values(reg.fields)) {
    lines.push(`- \`${reg.name}.${field.name}\` (\`${field.type}\`): ${field.description}`);
  }
  return lines.join('\n');
}

/**
 * Formats a hover card for a dotted return field on a `register:` variable.
 * Places the clickable `Open Official Docs` deep `#return-*` link at the top.
 */
export function formatReturnFieldHoverMarkdown(
  varPath: string,
  field: InferredReturnField,
  mod?: ModuleMetadataSpec,
): string {
  const docLink = field.docUrl ?? (mod ? `${mod.docUrl}#return-${field.name}` : undefined);
  const topLink = docLink ? ` ([Open Official Docs](${docLink}))` : '';
  const lines: string[] = [
    `### Return Field \`${varPath}\`${topLink}`,
    '',
    `- **Type:** \`${field.type}\``,
    `- **Returned:** *${field.returned}*`,
  ];
  if (field.sample !== undefined) {
    lines.push(`- **Sample:** \`${JSON.stringify(field.sample)}\``);
  }
  lines.push('', field.description);
  return lines.join('\n');
}

/**
 * Formats a Pylance-style Markdown hover card showing 22-level variable precedence
 * and all shadowed definitions across workspace files.
 */
export function formatVariablePrecedenceHoverMarkdown(resolved: ResolvedVariable): string {
  const winner = resolved.winningDefinition;
  const lines: string[] = [
    `### Variable \`${resolved.name}\``,
    '',
    `- **Effective Value:** \`${formatDisplayValue(winner.value, winner.rawValue)}\``,
    `- **Precedence Rank:** **${winner.precedenceLevel} / 22** (${winner.precedenceLabel})`,
    `- **Defined In:** \`${shortUriLabel(winner.uri)}\` (line ${winner.range.start.line + 1})`,
  ];

  if (resolved.shadowedDefinitions.length > 0) {
    lines.push('', '#### Shadowed Definitions (lower precedence)');
    for (const shadow of resolved.shadowedDefinitions) {
      lines.push(
        `- **Rank ${shadow.precedenceLevel}** (${shadow.precedenceLabel}): \`${formatDisplayValue(shadow.value, shadow.rawValue)}\` in \`${shortUriLabel(shadow.uri)}\` (line ${shadow.range.start.line + 1})`,
      );
    }
  }
  return lines.join('\n');
}

function formatDisplayValue(value: unknown, rawValue: string): string {
  if (rawValue.length > 0) {
    return rawValue;
  }
  return JSON.stringify(value);
}

function shortUriLabel(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

function escapeTableCell(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/**
 * Builds the canonical `docs.ansible.com` module URL for an FQCN, used when
 * a module's collection metadata is not loaded locally.
 */
export function buildFallbackModuleDocUrl(fqcn: string): string {
  const parts = fqcn.split('.');
  if (parts.length < 3) {
    return 'https://docs.ansible.com/ansible/latest/collections/index.html';
  }
  const [ns, coll, ...rest] = parts;
  return `https://docs.ansible.com/ansible/latest/collections/${ns ?? ''}/${coll ?? ''}/${rest.join('.')}_module.html`;
}

function appendOptionRows(
  lines: string[],
  docUrl: string,
  options: Readonly<Record<string, ModuleOptionSpec>>,
  prefix: string,
): void {
  for (const opt of Object.values(options)) {
    const fullName = `${prefix}${opt.name}`;
    const anchor = `${docUrl}#parameter-${fullName.replaceAll('.', '/')}`;
    const req = opt.required ? '**yes**' : 'no';
    const def =
      opt.default !== undefined ? `\`${escapeTableCell(JSON.stringify(opt.default))}\`` : '—';
    const choices =
      opt.choices && opt.choices.length > 0
        ? ` Choices: ${opt.choices.map((c) => `\`${escapeTableCell(String(c))}\``).join(', ')}.`
        : '';
    lines.push(
      `| [\`${fullName}\`](${anchor}) | \`${opt.type}\` | ${req} | ${def} | ${escapeTableCell(opt.description)}${choices} |`,
    );
    if (opt.suboptions) {
      appendOptionRows(lines, docUrl, opt.suboptions, `${fullName}.`);
    }
  }
}

function appendReturnItems(
  lines: string[],
  docUrl: string,
  fields: Readonly<Record<string, ModuleReturnFieldSpec>>,
  prefix: string,
  depth: number,
): void {
  const indent = '  '.repeat(depth);
  for (const ret of Object.values(fields)) {
    const fullName = `${prefix}${ret.name}`;
    const anchor = `${docUrl}#return-${fullName.replaceAll('.', '/')}`;
    lines.push(
      `${indent}- [\`${fullName}\`](${anchor}) (\`${ret.type}\`, returned: *${ret.returned}*): ${ret.description.replaceAll('\n', ' ')}`,
    );
    if (ret.contains) {
      appendReturnItems(lines, docUrl, ret.contains, `${fullName}.`, depth + 1);
    }
  }
}

/**
 * Renders a full, read-only Markdown documentation page for a module. Shown in the
 * `ansible-lens-docs:` virtual document when the user Ctrl+Clicks a module name.
 * The clickable `docs.ansible.com` link is always the first line.
 */
export function formatModuleDocsPageMarkdown(mod: ModuleMetadataSpec): string {
  const lines: string[] = [
    `[Open Official Docs on docs.ansible.com](${mod.docUrl})`,
    '',
    `# \`${mod.fqcn}\``,
    '',
    `*Collection:* \`${mod.collection}\` · *Short name:* \`${mod.shortName}\``,
    '',
  ];
  if (mod.deprecated) {
    lines.push('> **Deprecated.** See the official documentation for the replacement.', '');
  }
  lines.push(`**${mod.shortDescription}**`, '', mod.description);

  if (Object.keys(mod.options).length > 0) {
    lines.push('', '## Parameters', '');
    lines.push('| Name | Type | Required | Default | Description |');
    lines.push('| --- | --- | --- | --- | --- |');
    appendOptionRows(lines, mod.docUrl, mod.options, '');
  }

  if (Object.keys(mod.returnFields).length > 0) {
    lines.push('', '## Return Values', '');
    appendReturnItems(lines, mod.docUrl, mod.returnFields, '', 0);
  }

  lines.push(
    '',
    '---',
    '',
    '*Rendered offline by Ansible Lens from static metadata. Ansible® is a registered trademark of Red Hat, Inc.*',
  );
  return lines.join('\n');
}

/**
 * Renders a minimal docs page for a module whose collection metadata is not loaded.
 */
export function formatUnloadedModuleDocsPageMarkdown(fqcn: string): string {
  const url = buildFallbackModuleDocUrl(fqcn);
  return [
    `[Open Official Docs on docs.ansible.com](${url})`,
    '',
    `# \`${fqcn}\``,
    '',
    'Collection metadata for this module is not loaded locally. Run **Ansible Lens: Refresh Metadata** or open the official documentation above.',
  ].join('\n');
}
