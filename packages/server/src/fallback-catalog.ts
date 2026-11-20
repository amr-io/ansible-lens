import type {
  ModuleMetadataSpec,
  ModuleOptionSpec,
  ModuleReturnFieldSpec,
} from '@ansible-lens/core';

const DOC_BASE = 'https://docs.ansible.com/ansible/latest/collections/ansible/builtin';

function opt(
  name: string,
  type: ModuleOptionSpec['type'],
  description: string,
  extra?: Omit<ModuleOptionSpec, 'name' | 'type' | 'description'>,
): [string, ModuleOptionSpec] {
  return [
    name,
    {
      name,
      type,
      description,
      ...extra,
    },
  ];
}

function ret(
  name: string,
  type: ModuleReturnFieldSpec['type'],
  returned: string,
  description: string,
  extra?: Omit<ModuleReturnFieldSpec, 'name' | 'type' | 'returned' | 'description'>,
): [string, ModuleReturnFieldSpec] {
  return [
    name,
    {
      name,
      type,
      returned,
      description,
      ...extra,
    },
  ];
}

function builtinModule(
  shortName: string,
  shortDescription: string,
  description: string,
  optionsList: ReadonlyArray<readonly [string, ModuleOptionSpec]>,
  returnList: ReadonlyArray<readonly [string, ModuleReturnFieldSpec]>,
): ModuleMetadataSpec {
  const options: Record<string, ModuleOptionSpec> = {};
  for (const [k, v] of optionsList) {
    options[k] = v;
  }
  const returnFields: Record<string, ModuleReturnFieldSpec> = {};
  for (const [k, v] of returnList) {
    returnFields[k] = v;
  }
  return {
    fqcn: `ansible.builtin.${shortName}`,
    shortName,
    collection: 'ansible.builtin',
    shortDescription,
    description,
    docUrl: `${DOC_BASE}/${shortName}_module.html`,
    options,
    returnFields,
  };
}

/**
 * Clean-room fallback catalog of core `ansible.builtin` modules derived from
 * publicly documented module signatures. Loaded automatically if the server's
 * `MetadataRegistry` is empty.
 */
export const FALLBACK_BUILTIN_MODULES: readonly ModuleMetadataSpec[] = [
  builtinModule(
    'copy',
    'Copy files to remote locations',
    'The copy module copies a file or a directory structure from the local or remote machine to a location on the remote machine.',
    [
      opt('src', 'path', 'Local path to a file to copy to the remote server.'),
      opt('dest', 'path', 'Remote absolute path where the file should be copied to.', {
        required: true,
      }),
      opt(
        'content',
        'str',
        'When used instead of src, sets the contents of a file directly to the specified value.',
      ),
      opt('owner', 'str', 'Name of the user that should own the filesystem object.'),
      opt('group', 'str', 'Name of the group that should own the filesystem object.'),
      opt(
        'mode',
        'raw',
        'The permissions the resulting filesystem object should have (e.g. "0644").',
      ),
      opt('backup', 'bool', 'Create a backup file including the timestamp information.', {
        default: false,
      }),
      opt('force', 'bool', 'Influence whether the remote file must always be replaced.', {
        default: true,
      }),
      opt(
        'validate',
        'str',
        'The validation command to run before copying the updated file into the final destination.',
      ),
    ],
    [
      ret('dest', 'str', 'success', 'Destination file/path.', { sample: '/path/to/file.txt' }),
      ret('src', 'str', 'success', 'Source file used for the copy on the target machine.', {
        sample: '/home/httpd/.ansible/tmp/ansible-tmp/source',
      }),
      ret('md5sum', 'str', 'when supported', 'MD5 checksum of the file after running copy.'),
      ret('checksum', 'str', 'success', 'SHA1 checksum of the file after running copy.'),
      ret('size', 'int', 'success', 'Size of the target, after execution.', { sample: 1220 }),
      ret('state', 'str', 'success', 'State of the target, after execution.', { sample: 'file' }),
      ret('uid', 'int', 'success', 'Owner id of the file, after execution.', { sample: 100 }),
      ret('gid', 'int', 'success', 'Group id of the file, after execution.', { sample: 100 }),
      ret('mode', 'str', 'success', 'Permissions of the target, after execution.', {
        sample: '0644',
      }),
    ],
  ),
  builtinModule(
    'template',
    'Template a file out to a target host',
    'Templates are processed by the Jinja2 templating language and copied to the target host.',
    [
      opt('src', 'path', 'Path of a Jinja2 formatted template on the Ansible controller.', {
        required: true,
      }),
      opt('dest', 'path', 'Location to render the template to on the remote machine.', {
        required: true,
      }),
      opt('owner', 'str', 'Name of the user that should own the filesystem object.'),
      opt('group', 'str', 'Name of the group that should own the filesystem object.'),
      opt('mode', 'raw', 'The permissions the resulting filesystem object should have.'),
      opt('backup', 'bool', 'Create a backup file including the timestamp information.', {
        default: false,
      }),
      opt(
        'force',
        'bool',
        'Determine when the file is being transferred if the destination already exists.',
        {
          default: true,
        },
      ),
      opt(
        'validate',
        'str',
        'The validation command to run before copying the updated file into the final destination.',
      ),
      opt(
        'lstrip_blocks',
        'bool',
        'Strip leading spaces and tabs from the start of a line to a block.',
        {
          default: false,
        },
      ),
      opt('trim_blocks', 'bool', 'Strip the first newline after a block.', {
        default: true,
      }),
    ],
    [
      ret('dest', 'str', 'success', 'Destination file/path.', { sample: '/etc/nginx/nginx.conf' }),
      ret('src', 'str', 'success', 'Source template path on the controller.'),
      ret('checksum', 'str', 'success', 'SHA1 checksum of the rendered file.'),
      ret('size', 'int', 'success', 'Size of the rendered file in bytes.', { sample: 512 }),
      ret('mode', 'str', 'success', 'Permissions of the target after execution.', {
        sample: '0644',
      }),
    ],
  ),
  builtinModule(
    'apt',
    'Manages apt-packages',
    'Manages apt packages (such as for Debian/Ubuntu).',
    [
      opt('name', 'list', 'A list of package names or package specifier.', {
        elements: 'str',
        aliases: ['pkg', 'package'],
      }),
      opt('state', 'str', 'Indicates the desired package state.', {
        default: 'present',
        choices: ['absent', 'build-dep', 'latest', 'present', 'fixed'],
      }),
      opt('update_cache', 'bool', 'Run the equivalent of apt-get update before the operation.', {
        default: false,
        aliases: ['update-cache'],
      }),
      opt(
        'cache_valid_time',
        'int',
        'Update the apt cache if it is older than the cache_valid_time (in seconds).',
        {
          default: 0,
        },
      ),
      opt('upgrade', 'str', 'If yes or safe, performs an aptitude safe-upgrade.', {
        default: 'no',
        choices: ['dist', 'full', 'no', 'safe', 'yes'],
      }),
      opt('purge', 'bool', 'Will force purging of configuration files if state=absent.', {
        default: false,
      }),
      opt('autoremove', 'bool', 'Remove unused dependency packages.', {
        default: false,
      }),
    ],
    [
      ret(
        'cache_updated',
        'bool',
        'when apt cache is updated',
        'Whether the apt cache was updated.',
        {
          sample: true,
        },
      ),
      ret(
        'cache_update_time',
        'int',
        'when apt cache is updated',
        'Time of the last cache update.',
        {
          sample: 1505824000,
        },
      ),
      ret('stdout', 'str', 'when apt runs', 'Output from apt.'),
      ret('stderr', 'str', 'when apt runs', 'Error output from apt.'),
    ],
  ),
  builtinModule(
    'yum',
    'Manages packages with the yum package manager',
    'Installs, upgrades, downgrades, removes, and lists packages and groups with the yum package manager.',
    [
      opt('name', 'list', 'A package name or package specifier with version.', {
        elements: 'str',
        aliases: ['pkg'],
      }),
      opt('state', 'str', 'Whether to install or remove a package.', {
        default: 'present',
        choices: ['absent', 'installed', 'latest', 'present', 'removed'],
      }),
      opt(
        'enablerepo',
        'list',
        'Repoid of repositories to enable for the install/update operation.',
        {
          elements: 'str',
        },
      ),
      opt(
        'disablerepo',
        'list',
        'Repoid of repositories to disable for the install/update operation.',
        {
          elements: 'str',
        },
      ),
      opt(
        'update_cache',
        'bool',
        'Force yum to check if cache is out of date and redownload if needed.',
        {
          default: false,
        },
      ),
    ],
    [
      ret('msg', 'str', 'always', 'Status message returned by yum.'),
      ret('rc', 'int', 'always', 'Return code from yum command.', { sample: 0 }),
      ret('results', 'list', 'always', 'List of package actions performed.'),
    ],
  ),
  builtinModule(
    'dnf',
    'Manages packages with the dnf package manager',
    'Installs, upgrades, removes, and lists packages and groups with the dnf package manager.',
    [
      opt('name', 'list', 'A package name or package specifier with version.', {
        elements: 'str',
        aliases: ['pkg'],
      }),
      opt('state', 'str', 'Whether to install or remove a package.', {
        default: 'present',
        choices: ['absent', 'installed', 'latest', 'present', 'removed'],
      }),
      opt('enablerepo', 'list', 'Repoid of repositories to enable.', { elements: 'str' }),
      opt('disablerepo', 'list', 'Repoid of repositories to disable.', { elements: 'str' }),
      opt('update_cache', 'bool', 'Force dnf to check if cache is out of date.', {
        default: false,
      }),
      opt('allowerasing', 'bool', 'Allow erasing of installed packages to resolve dependencies.', {
        default: false,
      }),
    ],
    [
      ret('msg', 'str', 'always', 'Status message returned by dnf.'),
      ret('rc', 'int', 'always', 'Return code from dnf.', { sample: 0 }),
      ret('results', 'list', 'always', 'List of package changes.'),
    ],
  ),
  builtinModule(
    'service',
    'Manage services',
    'Controls services on remote hosts using supported init systems.',
    [
      opt('name', 'str', 'Name of the service.', { required: true }),
      opt('state', 'str', 'Target state of the service.', {
        choices: ['reloaded', 'restarted', 'started', 'stopped'],
      }),
      opt('enabled', 'bool', 'Whether the service should start on boot.'),
      opt(
        'pattern',
        'str',
        'Substring to look for as would be found in the output of the ps command.',
      ),
      opt('sleep', 'int', 'Seconds to sleep between stop and start when restarting.'),
    ],
    [
      ret('name', 'str', 'always', 'Name of the managed service.', { sample: 'nginx' }),
      ret('state', 'str', 'always', 'Resulting state of the service.', { sample: 'started' }),
      ret(
        'enabled',
        'bool',
        'when enabled is specified',
        'Whether the service is enabled on boot.',
        {
          sample: true,
        },
      ),
    ],
  ),
  builtinModule(
    'systemd',
    'Manage systemd units',
    'Controls systemd units (services, sockets, timers) on remote hosts.',
    [
      opt('name', 'str', 'Name of the unit.', { aliases: ['service', 'unit'] }),
      opt('state', 'str', 'Target state of the unit.', {
        choices: ['reloaded', 'restarted', 'started', 'stopped'],
      }),
      opt('enabled', 'bool', 'Whether the unit should start on boot.'),
      opt('daemon_reload', 'bool', 'Run daemon-reload before doing any other operations.', {
        default: false,
        aliases: ['daemon-reload'],
      }),
      opt('daemon_reexec', 'bool', 'Run daemon_reexec command before doing any other operations.', {
        default: false,
      }),
      opt('masked', 'bool', 'Whether the unit should be masked or not.'),
      opt('scope', 'str', 'Run systemctl within a given service manager scope.', {
        default: 'system',
        choices: ['system', 'user', 'global'],
      }),
    ],
    [
      ret('name', 'str', 'always', 'Name of the unit.', { sample: 'nginx' }),
      ret('state', 'str', 'when state is set', 'Resulting state of the unit.', {
        sample: 'started',
      }),
      ret(
        'status',
        'dict',
        'success',
        'A dictionary with the key=value pairs returned from systemctl show.',
      ),
    ],
  ),
  builtinModule(
    'command',
    'Execute commands on targets',
    'The command module takes the command name followed by a list of space-delimited arguments without a shell.',
    [
      opt('cmd', 'str', 'The command to run.'),
      opt('argv', 'list', 'Passes the command as a list rather than a string.', {
        elements: 'str',
      }),
      opt('chdir', 'path', 'Change into this directory before running the command.'),
      opt(
        'creates',
        'path',
        'A filename or glob pattern. If a matching file already exists, this step will not be run.',
      ),
      opt(
        'removes',
        'path',
        'A filename or glob pattern. If a matching file exists, this step will be run.',
      ),
      opt('stdin', 'str', 'Set the stdin of the command directly to the specified value.'),
    ],
    [
      ret('cmd', 'list', 'always', 'The command executed by the task.', {
        sample: ['systemctl', 'status', 'nginx'],
      }),
      ret('rc', 'int', 'always', 'The command return code (0 means success).', { sample: 0 }),
      ret('stdout', 'str', 'always', 'The command standard output.', {
        sample: 'active (running)',
      }),
      ret('stdout_lines', 'list', 'always', 'The command standard output split in lines.', {
        sample: ['active (running)'],
      }),
      ret('stderr', 'str', 'always', 'The command standard error.', { sample: '' }),
      ret('stderr_lines', 'list', 'always', 'The command standard error split in lines.', {
        sample: [],
      }),
      ret('delta', 'str', 'always', 'The command execution delta time.', {
        sample: '0:00:00.012345',
      }),
    ],
  ),
  builtinModule(
    'shell',
    'Execute shell commands on targets',
    'The shell module takes the command name followed by a list of space-delimited arguments and runs it through /bin/sh.',
    [
      opt('cmd', 'str', 'The command to run followed by optional arguments.'),
      opt('chdir', 'path', 'Change into this directory before running the command.'),
      opt('creates', 'path', 'A filename; if it already exists, this step will not be run.'),
      opt('removes', 'path', 'A filename; if it exists, this step will be run.'),
      opt('executable', 'path', 'Change the shell used to execute the command (e.g. /bin/bash).'),
      opt('stdin', 'str', 'Set the stdin of the command directly to the specified value.'),
    ],
    [
      ret('cmd', 'str', 'always', 'The shell command executed by the task.'),
      ret('rc', 'int', 'always', 'The command return code (0 means success).', { sample: 0 }),
      ret('stdout', 'str', 'always', 'The command standard output.'),
      ret('stdout_lines', 'list', 'always', 'The command standard output split in lines.'),
      ret('stderr', 'str', 'always', 'The command standard error.'),
      ret('stderr_lines', 'list', 'always', 'The command standard error split in lines.'),
    ],
  ),
  builtinModule(
    'file',
    'Manage files and file properties',
    'Set attributes of files, directories, or symlinks and their targets, or remove them.',
    [
      opt('path', 'path', 'Path to the file being managed.', {
        required: true,
        aliases: ['dest', 'name'],
      }),
      opt('state', 'str', 'Desired state of the filesystem path.', {
        choices: ['absent', 'directory', 'file', 'hard', 'link', 'touch'],
      }),
      opt('src', 'path', 'Path of the file to link to (used with state=link or state=hard).'),
      opt('owner', 'str', 'Name of the user that should own the filesystem object.'),
      opt('group', 'str', 'Name of the group that should own the filesystem object.'),
      opt('mode', 'raw', 'The permissions the resulting filesystem object should have.'),
      opt(
        'recurse',
        'bool',
        'Recursively set the specified file attributes on directory contents.',
        {
          default: false,
        },
      ),
      opt('force', 'bool', 'Force the creation of the symlinks in two cases.', {
        default: false,
      }),
    ],
    [
      ret('path', 'str', 'always', 'Destination file/directory path.', { sample: '/var/www/html' }),
      ret('state', 'str', 'always', 'State of the target after execution.', {
        sample: 'directory',
      }),
      ret('owner', 'str', 'always', 'Owner of the file after execution.', { sample: 'www-data' }),
      ret('group', 'str', 'always', 'Group of the file after execution.', { sample: 'www-data' }),
      ret('mode', 'str', 'always', 'Permissions of the target after execution.', {
        sample: '0755',
      }),
    ],
  ),
  builtinModule(
    'lineinfile',
    'Manage lines in text files',
    'Ensures a particular line is in a file, or replaces an existing line using a back-referenced regular expression.',
    [
      opt('path', 'path', 'The file to modify.', { required: true, aliases: ['dest', 'name'] }),
      opt('line', 'str', 'The line to insert/replace into the file.'),
      opt('regexp', 'str', 'The regular expression to look for in every line of the file.'),
      opt('state', 'str', 'Whether the line should be there or not.', {
        default: 'present',
        choices: ['absent', 'present'],
      }),
      opt(
        'insertafter',
        'str',
        'Insert line after the last match of specified regular expression.',
        {
          default: 'EOF',
        },
      ),
      opt(
        'insertbefore',
        'str',
        'Insert line before the last match of specified regular expression.',
      ),
      opt('create', 'bool', 'Create the file if it does not exist.', { default: false }),
      opt('backup', 'bool', 'Create a backup file before modifying.', { default: false }),
      opt('mode', 'raw', 'The permissions the resulting filesystem object should have.'),
    ],
    [
      ret('msg', 'str', 'always', 'Status message describing the line change.', {
        sample: 'line replaced',
      }),
      ret('backup', 'str', 'when backup is true', 'Path to the created backup file.'),
    ],
  ),
  builtinModule(
    'stat',
    'Retrieve file or file system status',
    'Retrieves facts for a file similar to the Linux/Unix stat command.',
    [
      opt('path', 'path', 'The full path of the file/object to get the facts of.', {
        required: true,
      }),
      opt('follow', 'bool', 'Whether to follow symlinks.', { default: false }),
      opt('get_checksum', 'bool', 'Whether to return a checksum of the file.', { default: true }),
      opt('checksum_algorithm', 'str', 'Algorithm to determine checksum of file.', {
        default: 'sha1',
        choices: ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'],
      }),
      opt('get_mime', 'bool', 'Use file magic and return data about the nature of the file.', {
        default: true,
      }),
      opt('get_attributes', 'bool', 'Get file attributes using lsattr tool if present.', {
        default: true,
      }),
    ],
    [
      ret(
        'stat',
        'dict',
        'success',
        'Dictionary containing all the stat data for the target path.',
        {
          contains: {
            exists: {
              name: 'exists',
              type: 'bool',
              returned: 'success',
              description: 'If the destination path actually exists or not.',
              sample: true,
            },
            isdir: {
              name: 'isdir',
              type: 'bool',
              returned: 'success, path exists',
              description: 'Tells you if the path is a directory.',
              sample: false,
            },
            isreg: {
              name: 'isreg',
              type: 'bool',
              returned: 'success, path exists',
              description: 'Tells you if the path is a regular file.',
              sample: true,
            },
            islnk: {
              name: 'islnk',
              type: 'bool',
              returned: 'success, path exists',
              description: 'Tells you if the path is a symbolic link.',
              sample: false,
            },
            mode: {
              name: 'mode',
              type: 'str',
              returned: 'success, path exists',
              description: 'Unix permissions of the file in octal.',
              sample: '0644',
            },
            size: {
              name: 'size',
              type: 'int',
              returned: 'success, path exists',
              description: 'Size in bytes for a plain file.',
              sample: 2048,
            },
            checksum: {
              name: 'checksum',
              type: 'str',
              returned: 'success, path exists, get_checksum=true',
              description: 'Hash of the file.',
            },
            pw_name: {
              name: 'pw_name',
              type: 'str',
              returned: 'success, path exists',
              description: 'User name of owner.',
              sample: 'root',
            },
          },
        },
      ),
    ],
  ),
  builtinModule(
    'debug',
    'Print statements during execution',
    'Prints statements during execution and can be useful for debugging variables or expressions.',
    [
      opt('msg', 'raw', 'The customized message that is printed.', { default: 'Hello world!' }),
      opt('var', 'str', 'A variable name to debug. Mutually exclusive with the msg option.'),
      opt('verbosity', 'int', 'A number that controls when the debug is run.', { default: 0 }),
    ],
    [ret('msg', 'str', 'when msg is set', 'The debug message printed to output.')],
  ),
  builtinModule(
    'set_fact',
    'Set host variable(s) and fact(s)',
    'Allows setting new variables. Variables are set on a host-by-host basis just like facts.',
    [
      opt(
        'cacheable',
        'bool',
        'This boolean converts the variable into an actual fact if fact caching is enabled.',
        {
          default: false,
        },
      ),
    ],
    [ret('ansible_facts', 'dict', 'always', 'Dictionary of facts/variables set by the task.')],
  ),
  builtinModule(
    'uri',
    'Interacts with webservices',
    'Interacts with HTTP and HTTPS web services and supports Digest, Basic and WSSE HTTP authentication mechanisms.',
    [
      opt('url', 'str', 'HTTP or HTTPS URL in the form (http|https)://host.domain[:port]/path.', {
        required: true,
      }),
      opt('method', 'str', 'The HTTP method of the request or response.', {
        default: 'GET',
        choices: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'],
      }),
      opt('body', 'raw', 'The body of the HTTP request/response to the web service.'),
      opt('body_format', 'str', 'The serialization format of the body.', {
        default: 'raw',
        choices: ['form-multipart', 'form-urlencoded', 'json', 'raw'],
      }),
      opt('headers', 'dict', 'Add custom HTTP headers to a request in the format of a YAML hash.'),
      opt('status_code', 'list', 'A valid, numeric, HTTP status code that signifies success.', {
        elements: 'int',
        default: [200],
      }),
      opt(
        'return_content',
        'bool',
        'Whether or not to return the body of the response as a content key.',
        {
          default: false,
        },
      ),
      opt('validate_certs', 'bool', 'If false, SSL certificates will not be validated.', {
        default: true,
      }),
      opt('timeout', 'int', 'The socket level timeout in seconds.', { default: 30 }),
    ],
    [
      ret('status', 'int', 'always', 'The HTTP status code from the request.', { sample: 200 }),
      ret('url', 'str', 'always', 'The actual URL used for the request.', {
        sample: 'https://example.com',
      }),
      ret('content', 'str', 'when return_content is true', 'The response body.'),
      ret(
        'json',
        'dict',
        'when return_content is true and response is JSON',
        'The parsed JSON response body.',
      ),
      ret('msg', 'str', 'always', 'The HTTP message from the request.', {
        sample: 'OK (unknown bytes)',
      }),
    ],
  ),
  builtinModule(
    'user',
    'Manage user accounts',
    'Manage user accounts and user attributes.',
    [
      opt('name', 'str', 'Name of the user to create, remove or modify.', { required: true }),
      opt('state', 'str', 'Whether the account should exist or not.', {
        default: 'present',
        choices: ['absent', 'present'],
      }),
      opt('uid', 'int', 'Optionally sets the UID of the user.'),
      opt('group', 'str', 'Optionally sets the user primary group.'),
      opt('groups', 'list', 'List of supplementary groups.', { elements: 'str' }),
      opt('shell', 'str', 'Optionally set the user shell.'),
      opt('home', 'path', 'Optionally set the user home directory.'),
      opt('create_home', 'bool', 'Create the home directory if it does not exist.', {
        default: true,
      }),
      opt('system', 'bool', 'Create a system account.', { default: false }),
    ],
    [
      ret('name', 'str', 'always', 'User name.', { sample: 'deploy' }),
      ret('uid', 'int', 'when state=present', 'User ID.', { sample: 1001 }),
      ret('group', 'int', 'when state=present', 'Primary group ID.', { sample: 1001 }),
      ret('home', 'str', 'when state=present', 'User home directory.', { sample: '/home/deploy' }),
      ret('shell', 'str', 'when state=present', 'User login shell.', { sample: '/bin/bash' }),
    ],
  ),
  builtinModule(
    'group',
    'Add or remove groups',
    'Manage presence of groups on a host.',
    [
      opt('name', 'str', 'Name of the group to manage.', { required: true }),
      opt('state', 'str', 'Whether the group should be present or not on the remote host.', {
        default: 'present',
        choices: ['absent', 'present'],
      }),
      opt('gid', 'int', 'Optional GID to set for the group.'),
      opt('system', 'bool', 'If yes, indicates that the group created is a system group.', {
        default: false,
      }),
    ],
    [
      ret('name', 'str', 'always', 'Group name.', { sample: 'www-data' }),
      ret('gid', 'int', 'when state=present', 'Group ID.', { sample: 33 }),
      ret('state', 'str', 'always', 'Group state.', { sample: 'present' }),
    ],
  ),
  builtinModule(
    'git',
    'Deploy software (or files) from git checkouts',
    'Manage git checkouts of repositories to deploy files or software.',
    [
      opt('repo', 'str', 'git, SSH, or HTTP(S) protocol address of the git repository.', {
        required: true,
        aliases: ['name'],
      }),
      opt('dest', 'path', 'The path of where the repository should be checked out.', {
        required: true,
      }),
      opt('version', 'str', 'What version of the repository to check out (branch, tag, or SHA).', {
        default: 'HEAD',
      }),
      opt(
        'depth',
        'int',
        'Create a shallow clone with a history truncated to the specified number of revisions.',
      ),
      opt('force', 'bool', 'Discard any modified files in the destination working tree.', {
        default: false,
      }),
      opt('update', 'bool', 'Retrieve new revisions from the already checked out repository.', {
        default: true,
      }),
    ],
    [
      ret(
        'after',
        'str',
        'success',
        'Last commit revision of the repository retrieved during the update.',
      ),
      ret(
        'before',
        'str',
        'success',
        'Last commit revision of the repository prior to the update.',
      ),
      ret(
        'remote_url_changed',
        'bool',
        'always',
        'Contains true or false depending on whether the remote URL changed.',
      ),
    ],
  ),
  builtinModule(
    'package',
    'Generic OS package manager',
    'This module manages packages on a target without specifying a package manager module.',
    [
      opt('name', 'list', 'Package name, or package specifier with version.', {
        required: true,
        elements: 'str',
        aliases: ['pkg'],
      }),
      opt('state', 'str', 'Whether to install or remove a package.', {
        required: true,
        choices: ['absent', 'latest', 'present'],
      }),
      opt('use', 'str', 'The required package manager module to use.', { default: 'auto' }),
    ],
    [ret('results', 'list', 'always', 'Package manager execution results.')],
  ),
  builtinModule(
    'include_tasks',
    'Dynamically include a task list',
    'Includes a file with a list of tasks to be executed in the current playbook.',
    [
      opt(
        'file',
        'path',
        'The name of the imported file is specified directly without any other option.',
      ),
      opt(
        'apply',
        'dict',
        'Accepts a hash of task keywords (e.g. tags, become) that will be applied to the tasks within the include.',
      ),
    ],
    [],
  ),
  builtinModule(
    'import_tasks',
    'Import a task list',
    'Imports a list of tasks to be added to the current playbook for subsequent execution.',
    [
      opt(
        'file',
        'path',
        'The name of the imported file is specified directly without any other option.',
      ),
    ],
    [],
  ),
  builtinModule(
    'wait_for',
    'Waits for a condition before continuing',
    'You can wait for a set amount of time, wait for a port to become available, or wait for a file to exist.',
    [
      opt('host', 'str', 'A resolvable hostname or IP address to wait for.', {
        default: '127.0.0.1',
      }),
      opt('port', 'int', 'Port number to poll.'),
      opt('state', 'str', 'Either present, started, stopped, absent, or drained.', {
        default: 'started',
        choices: ['absent', 'drained', 'present', 'started', 'stopped'],
      }),
      opt('timeout', 'int', 'Maximum number of seconds to wait for.', { default: 300 }),
      opt('delay', 'int', 'Number of seconds to wait before starting to poll.', { default: 0 }),
      opt('path', 'path', 'Path to a file on the filesystem that must exist before continuing.'),
    ],
    [
      ret('elapsed', 'int', 'always', 'The number of seconds that elapsed while waiting.', {
        sample: 1,
      }),
      ret('match_groups', 'list', 'when search_regex is used', 'List of matched regex groups.'),
    ],
  ),
];

/**
 * Ensures the given registry contains at least the fallback `ansible.builtin`
 * module catalog when no external pack has been loaded yet.
 */
export function ensureFallbackModulesLoaded(registry: {
  listModules(): readonly ModuleMetadataSpec[];
  registerModule(mod: ModuleMetadataSpec): void;
}): void {
  if (registry.listModules().length > 0) {
    return;
  }
  for (const mod of FALLBACK_BUILTIN_MODULES) {
    registry.registerModule(mod);
  }
}
