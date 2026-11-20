/**
 * Clean-room Ansible & Jinja2 static reference tables for completions and hovers.
 */

export interface KeywordMetadata {
  readonly name: string;
  readonly scope: 'play' | 'task' | 'both';
  readonly description: string;
}

export interface JinjaItemMetadata {
  readonly name: string;
  readonly signature: string;
  readonly description: string;
}

export const PLAY_AND_TASK_KEYWORDS: readonly KeywordMetadata[] = [
  {
    name: 'hosts',
    scope: 'play',
    description:
      'A list of groups, hosts or host pattern that translates to a list of hosts that are the target of the play.',
  },
  {
    name: 'tasks',
    scope: 'play',
    description:
      'Main list of tasks to execute in the play, they run after roles and before post_tasks.',
  },
  {
    name: 'handlers',
    scope: 'play',
    description:
      'A section with tasks that are treated as handlers, these won’t get executed normally, only when notified.',
  },
  { name: 'roles', scope: 'play', description: 'List of roles to be imported into the play.' },
  { name: 'vars', scope: 'both', description: 'Dictionary/map of variables.' },
  {
    name: 'vars_files',
    scope: 'play',
    description: 'List of files that contain vars to include in the play.',
  },
  { name: 'pre_tasks', scope: 'play', description: 'A list of tasks to execute before roles.' },
  {
    name: 'post_tasks',
    scope: 'play',
    description: 'A list of tasks to execute after the tasks section.',
  },
  {
    name: 'name',
    scope: 'both',
    description: 'Identifier. Can be used for documentation, or in tasks/handlers.',
  },
  {
    name: 'become',
    scope: 'both',
    description: 'Boolean that controls if privilege escalation is used or not on Task execution.',
  },
  {
    name: 'register',
    scope: 'task',
    description: 'Name of variable that will contain task status and module return data.',
  },
  {
    name: 'when',
    scope: 'task',
    description: 'Conditional expression, determines if an iteration of a task is run or not.',
  },
  {
    name: 'loop',
    scope: 'task',
    description:
      'Takes a list for the task to iterate over, saving each list element into the item variable.',
  },
  {
    name: 'changed_when',
    scope: 'task',
    description: 'Conditional expression that overrides the normal changed status of a task.',
  },
  {
    name: 'failed_when',
    scope: 'task',
    description: 'Conditional expression that overrides the normal failed status of a task.',
  },
  {
    name: 'notify',
    scope: 'task',
    description: 'List of handlers to notify when the task returns a changed=True status.',
  },
  {
    name: 'tags',
    scope: 'both',
    description:
      'Tags applied to the task or included tasks, this allows selecting subsets of tasks from the command line.',
  },
  { name: 'no_log', scope: 'both', description: 'Boolean that controls information disclosure.' },
  { name: 'block', scope: 'task', description: 'List of tasks in a block.' },
  {
    name: 'rescue',
    scope: 'task',
    description:
      'List of tasks in a block that run if there is a task error in the main block list.',
  },
  {
    name: 'always',
    scope: 'task',
    description:
      'List of tasks, in a block, that execute no matter if there is an error in the block or not.',
  },
];

export const TASK_LEVEL_NON_MODULE_KEYS: ReadonlySet<string> = new Set([
  'name',
  'become',
  'become_user',
  'become_method',
  'become_flags',
  'register',
  'when',
  'loop',
  'loop_control',
  'with_items',
  'with_dict',
  'with_list',
  'with_flattened',
  'with_subelements',
  'with_sequence',
  'changed_when',
  'failed_when',
  'notify',
  'tags',
  'no_log',
  'vars',
  'block',
  'rescue',
  'always',
  'ignore_errors',
  'ignore_unreachable',
  'check_mode',
  'diff',
  'delegate_to',
  'run_once',
  'environment',
  'retries',
  'delay',
  'until',
  'listen',
  'args',
  'collections',
]);

export const JINJA_FILTERS: readonly JinjaItemMetadata[] = [
  {
    name: 'default',
    signature: 'default(value, boolean=false)',
    description: 'Provide a default value if the input variable is undefined.',
  },
  {
    name: 'd',
    signature: 'd(value, boolean=false)',
    description: 'Short alias for the default() filter.',
  },
  {
    name: 'mandatory',
    signature: 'mandatory(msg=None)',
    description: 'Make a variable mandatory, failing if it is undefined.',
  },
  {
    name: 'bool',
    signature: 'bool',
    description: 'Convert a string or number representation into a boolean.',
  },
  {
    name: 'int',
    signature: 'int(default=0, base=10)',
    description: 'Convert the value into an integer.',
  },
  {
    name: 'float',
    signature: 'float(default=0.0)',
    description: 'Convert the value into a floating point number.',
  },
  { name: 'string', signature: 'string', description: 'Convert an object to a string.' },
  { name: 'lower', signature: 'lower', description: 'Convert a string to lowercase.' },
  { name: 'upper', signature: 'upper', description: 'Convert a string to uppercase.' },
  {
    name: 'replace',
    signature: 'replace(old, new, count=None)',
    description: 'Return a copy of the value with all occurrences of a substring replaced.',
  },
  {
    name: 'regex_replace',
    signature: 'regex_replace(pattern, replacement)',
    description: 'Replace text matching a regular expression pattern.',
  },
  {
    name: 'regex_search',
    signature: 'regex_search(pattern)',
    description: 'Search a string for the first match of a regular expression.',
  },
  {
    name: 'split',
    signature: 'split(sep=None, maxsplit=-1)',
    description: 'Split a string into a list by separator.',
  },
  {
    name: 'join',
    signature: 'join(d="")',
    description: 'Return a string which is the concatenation of the strings in the sequence.',
  },
  { name: 'first', signature: 'first', description: 'Return the first item of a sequence.' },
  { name: 'last', signature: 'last', description: 'Return the last item of a sequence.' },
  {
    name: 'length',
    signature: 'length',
    description: 'Return the number of items of a container.',
  },
  { name: 'count', signature: 'count', description: 'Alias for length.' },
  {
    name: 'unique',
    signature: 'unique(case_sensitive=False)',
    description: 'Return a list of unique items from the given iterable.',
  },
  { name: 'union', signature: 'union(other)', description: 'Return the union of two lists.' },
  {
    name: 'intersect',
    signature: 'intersect(other)',
    description: 'Return the intersection of two lists.',
  },
  {
    name: 'difference',
    signature: 'difference(other)',
    description: 'Return the difference of two lists.',
  },
  {
    name: 'combine',
    signature: 'combine(*dicts, recursive=False)',
    description: 'Merge two or more dictionaries together.',
  },
  {
    name: 'dict2items',
    signature: 'dict2items(key_name="key", value_name="value")',
    description: 'Convert a dictionary into a list of key/value dictionaries.',
  },
  {
    name: 'items2dict',
    signature: 'items2dict(key_name="key", value_name="value")',
    description: 'Convert a list of key/value dictionaries into a dictionary.',
  },
  { name: 'to_json', signature: 'to_json', description: 'Serialize a value as JSON.' },
  {
    name: 'to_nice_json',
    signature: 'to_nice_json(indent=4)',
    description: 'Serialize a value as human-readable indented JSON.',
  },
  { name: 'to_yaml', signature: 'to_yaml', description: 'Serialize a value as YAML.' },
  {
    name: 'to_nice_yaml',
    signature: 'to_nice_yaml(indent=4)',
    description: 'Serialize a value as human-readable indented YAML.',
  },
  {
    name: 'from_json',
    signature: 'from_json',
    description: 'Parse a JSON string into a data structure.',
  },
  {
    name: 'from_yaml',
    signature: 'from_yaml',
    description: 'Parse a YAML string into a data structure.',
  },
  { name: 'b64encode', signature: 'b64encode', description: 'Encode a string using Base64.' },
  { name: 'b64decode', signature: 'b64decode', description: 'Decode a Base64-encoded string.' },
  {
    name: 'hash',
    signature: 'hash(hashtype="sha1")',
    description: 'Calculate a cryptographic hash of a string.',
  },
  {
    name: 'password_hash',
    signature: 'password_hash(hashtype="sha512")',
    description: 'Generate a password hash suitable for /etc/shadow.',
  },
  {
    name: 'ipaddr',
    signature: 'ipaddr(query="")',
    description: 'Validate and manipulate IP addresses and CIDR networks.',
  },
  {
    name: 'json_query',
    signature: 'json_query(expr)',
    description: 'Filter and extract data using a JMESPath expression.',
  },
  {
    name: 'map',
    signature: 'map(*args, **kwargs)',
    description: 'Apply a filter or look up an attribute on every object in a sequence.',
  },
  {
    name: 'select',
    signature: 'select(*args, **kwargs)',
    description: 'Filter a sequence of objects by applying a test to each object.',
  },
  {
    name: 'selectattr',
    signature: 'selectattr(*args, **kwargs)',
    description: 'Filter a sequence of objects by applying a test to an attribute.',
  },
  {
    name: 'reject',
    signature: 'reject(*args, **kwargs)',
    description: 'Filter a sequence by rejecting objects that pass a test.',
  },
  {
    name: 'rejectattr',
    signature: 'rejectattr(*args, **kwargs)',
    description: 'Filter a sequence by rejecting objects whose attribute passes a test.',
  },
];

export const JINJA_TESTS: readonly JinjaItemMetadata[] = [
  {
    name: 'defined',
    signature: 'is defined',
    description: 'Return true if the variable is defined.',
  },
  {
    name: 'undefined',
    signature: 'is undefined',
    description: 'Return true if the variable is undefined.',
  },
  { name: 'none', signature: 'is none', description: 'Return true if the variable is None/null.' },
  {
    name: 'truthy',
    signature: 'is truthy',
    description: 'Return true if the value evaluates as truthy.',
  },
  {
    name: 'falsy',
    signature: 'is falsy',
    description: 'Return true if the value evaluates as falsy.',
  },
  {
    name: 'match',
    signature: 'is match(pattern)',
    description: 'Return true if the string matches the regex from the start.',
  },
  {
    name: 'search',
    signature: 'is search(pattern)',
    description: 'Return true if the regex matches anywhere in the string.',
  },
  {
    name: 'regex',
    signature: 'is regex(pattern)',
    description: 'Alias for match/search regex testing.',
  },
  {
    name: 'version',
    signature: 'is version(other, operator="==")',
    description: 'Compare two software version strings.',
  },
  {
    name: 'file',
    signature: 'is file',
    description: 'Return true if the path on the controller is a regular file.',
  },
  {
    name: 'directory',
    signature: 'is directory',
    description: 'Return true if the path on the controller is a directory.',
  },
  {
    name: 'exists',
    signature: 'is exists',
    description: 'Return true if the path on the controller exists.',
  },
  {
    name: 'changed',
    signature: 'is changed',
    description: 'Return true if a registered task result reported changed.',
  },
  {
    name: 'failed',
    signature: 'is failed',
    description: 'Return true if a registered task result failed.',
  },
  {
    name: 'succeeded',
    signature: 'is succeeded',
    description: 'Return true if a registered task result succeeded.',
  },
  {
    name: 'skipped',
    signature: 'is skipped',
    description: 'Return true if a registered task result was skipped.',
  },
];

export const ANSIBLE_MAGIC_VARS: readonly JinjaItemMetadata[] = [
  {
    name: 'hostvars',
    signature: 'dict',
    description: 'Dictionary of all host variables keyed by inventory hostname.',
  },
  {
    name: 'groups',
    signature: 'dict',
    description: 'Dictionary of all inventory groups and their member host lists.',
  },
  {
    name: 'group_names',
    signature: 'list[str]',
    description: 'List of groups the current host belongs to.',
  },
  {
    name: 'inventory_hostname',
    signature: 'str',
    description: 'The inventory name for the current host being iterated over.',
  },
  {
    name: 'inventory_hostname_short',
    signature: 'str',
    description: 'The first part of inventory_hostname before the first dot.',
  },
  {
    name: 'play_hosts',
    signature: 'list[str]',
    description: 'Deprecated alias for ansible_play_hosts.',
  },
  {
    name: 'ansible_play_hosts',
    signature: 'list[str]',
    description: 'List of active hosts in the current play run.',
  },
  {
    name: 'ansible_play_batch',
    signature: 'list[str]',
    description: 'List of active hosts in the current serial batch.',
  },
  {
    name: 'playbook_dir',
    signature: 'str',
    description: 'The directory path of the top-level playbook.',
  },
  {
    name: 'role_path',
    signature: 'str',
    description: 'The directory path of the currently executing role.',
  },
  {
    name: 'ansible_check_mode',
    signature: 'bool',
    description: 'Boolean indicating whether Ansible is running in --check mode.',
  },
  {
    name: 'ansible_diff_mode',
    signature: 'bool',
    description: 'Boolean indicating whether Ansible is running in --diff mode.',
  },
  {
    name: 'ansible_version',
    signature: 'dict',
    description: 'Dictionary describing the active Ansible version.',
  },
  {
    name: 'ansible_facts',
    signature: 'dict',
    description: 'Dictionary containing gathered host facts.',
  },
];

export const ANSIBLE_FACTS_FIELDS: readonly JinjaItemMetadata[] = [
  {
    name: 'os_family',
    signature: 'str',
    description: 'Operating system family (e.g. Debian, RedHat, Darwin).',
  },
  {
    name: 'distribution',
    signature: 'str',
    description: 'Operating system distribution name (e.g. Ubuntu, Rocky).',
  },
  {
    name: 'distribution_version',
    signature: 'str',
    description: 'Distribution version string (e.g. 24.04).',
  },
  {
    name: 'architecture',
    signature: 'str',
    description: 'Hardware CPU architecture (e.g. x86_64, aarch64).',
  },
  { name: 'hostname', signature: 'str', description: 'Short system hostname.' },
  {
    name: 'fqdn',
    signature: 'str',
    description: 'Fully qualified domain name of the target host.',
  },
  {
    name: 'default_ipv4',
    signature: 'dict',
    description: 'Default IPv4 interface details (address, gateway, interface).',
  },
  {
    name: 'interfaces',
    signature: 'list[str]',
    description: 'List of network interface names on the host.',
  },
  { name: 'memtotal_mb', signature: 'int', description: 'Total physical memory in megabytes.' },
  { name: 'processor_vcpus', signature: 'int', description: 'Total number of virtual CPUs.' },
  { name: 'env', signature: 'dict', description: 'Environment variables on the target host.' },
  {
    name: 'pkg_mgr',
    signature: 'str',
    description: 'Detected system package manager (e.g. apt, dnf).',
  },
  {
    name: 'service_mgr',
    signature: 'str',
    description: 'Detected service/init manager (e.g. systemd).',
  },
];

export interface CommonReturnFieldInfo {
  readonly name: string;
  readonly type: 'bool' | 'int' | 'str' | 'list';
  readonly returned: string;
  readonly description: string;
  readonly sample?: unknown;
}

export const COMMON_REGISTER_RETURN_FIELDS: readonly CommonReturnFieldInfo[] = [
  {
    name: 'changed',
    type: 'bool',
    returned: 'always',
    description: 'Whether the task made changes on the target.',
    sample: true,
  },
  {
    name: 'failed',
    type: 'bool',
    returned: 'always',
    description: 'Whether the task failed.',
    sample: false,
  },
  {
    name: 'skipped',
    type: 'bool',
    returned: 'always',
    description: 'Whether the task was skipped.',
    sample: false,
  },
  {
    name: 'rc',
    type: 'int',
    returned: 'when command runs',
    description: 'Command exit return code.',
    sample: 0,
  },
  {
    name: 'stdout',
    type: 'str',
    returned: 'when command runs',
    description: 'Standard output text.',
    sample: '',
  },
  {
    name: 'stdout_lines',
    type: 'list',
    returned: 'when command runs',
    description: 'Standard output split into lines.',
    sample: [],
  },
  {
    name: 'stderr',
    type: 'str',
    returned: 'when command runs',
    description: 'Standard error text.',
    sample: '',
  },
  {
    name: 'stderr_lines',
    type: 'list',
    returned: 'when command runs',
    description: 'Standard error split into lines.',
    sample: [],
  },
  {
    name: 'msg',
    type: 'str',
    returned: 'on message/error',
    description: 'Human-readable status or error message.',
    sample: '',
  },
];
