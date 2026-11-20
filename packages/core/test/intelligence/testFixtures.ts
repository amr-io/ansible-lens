import type {
  AnsibleDocumentAst,
  AnsibleDocumentKind,
  CollectionMetadataPack,
  ModuleMetadataSpec,
  PlayNode,
  SourceRange,
  TaskNode,
  TaskParamNode,
  VariableDeclNode,
} from '../../src/contracts/types.js';
import { MetadataRegistry } from '../../src/metadata/index.js';

export function makeRange(
  startLine = 0,
  startCol = 0,
  startOffset = 0,
  endLine = startLine,
  endCol = startCol + 10,
  endOffset = startOffset + 10,
): SourceRange {
  return {
    start: { line: startLine, column: startCol, offset: startOffset },
    end: { line: endLine, column: endCol, offset: endOffset },
  };
}

export function makeParam(
  name: string,
  value: unknown,
  overrides: Partial<TaskParamNode> = {},
): TaskParamNode {
  return {
    name,
    keyRange: overrides.keyRange ?? makeRange(1, 4, 20, 1, 4 + name.length, 20 + name.length),
    valueRange: overrides.valueRange ?? makeRange(1, 10, 26, 1, 20, 36),
    rawText: overrides.rawText ?? String(value),
    value,
    jinjaBlocks: overrides.jinjaBlocks ?? [],
    ...(overrides.suboptions !== undefined ? { suboptions: overrides.suboptions } : {}),
  };
}

export function makeTask(moduleName: string, overrides: Partial<TaskNode> = {}): TaskNode {
  const isFqcn = overrides.isFqcn ?? moduleName.includes('.');
  return {
    moduleName,
    moduleRange:
      overrides.moduleRange ??
      makeRange(2, 4, 30, 2, 4 + moduleName.length, 30 + moduleName.length),
    isFqcn,
    params: overrides.params ?? [],
    duplicateKeys: overrides.duplicateKeys ?? [],
    rawTruthyKeys: overrides.rawTruthyKeys ?? [],
    range: overrides.range ?? makeRange(2, 2, 28, 4, 20, 60),
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    ...(overrides.nameRange !== undefined ? { nameRange: overrides.nameRange } : {}),
    ...(overrides.freeFormArg !== undefined ? { freeFormArg: overrides.freeFormArg } : {}),
    ...(overrides.register !== undefined ? { register: overrides.register } : {}),
    ...(overrides.registerRange !== undefined ? { registerRange: overrides.registerRange } : {}),
    ...(overrides.loop !== undefined ? { loop: overrides.loop } : {}),
    ...(overrides.loopKind !== undefined ? { loopKind: overrides.loopKind } : {}),
    ...(overrides.when !== undefined ? { when: overrides.when } : {}),
    ...(overrides.whenRange !== undefined ? { whenRange: overrides.whenRange } : {}),
    ...(overrides.changedWhen !== undefined ? { changedWhen: overrides.changedWhen } : {}),
    ...(overrides.changedWhenRange !== undefined
      ? { changedWhenRange: overrides.changedWhenRange }
      : {}),
    ...(overrides.failedWhen !== undefined ? { failedWhen: overrides.failedWhen } : {}),
    ...(overrides.failedWhenRange !== undefined
      ? { failedWhenRange: overrides.failedWhenRange }
      : {}),
    ...(overrides.notify !== undefined ? { notify: overrides.notify } : {}),
    ...(overrides.notifyRange !== undefined ? { notifyRange: overrides.notifyRange } : {}),
    ...(overrides.noLog !== undefined ? { noLog: overrides.noLog } : {}),
    ...(overrides.become !== undefined ? { become: overrides.become } : {}),
    ...(overrides.tags !== undefined ? { tags: overrides.tags } : {}),
    ...(overrides.vars !== undefined ? { vars: overrides.vars } : {}),
  };
}

export function makePlay(overrides: Partial<PlayNode> = {}): PlayNode {
  return {
    varsFiles: overrides.varsFiles ?? [],
    roles: overrides.roles ?? [],
    preTasks: overrides.preTasks ?? [],
    tasks: overrides.tasks ?? [],
    postTasks: overrides.postTasks ?? [],
    handlers: overrides.handlers ?? [],
    range: overrides.range ?? makeRange(0, 0, 0, 10, 0, 200),
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    ...(overrides.hosts !== undefined ? { hosts: overrides.hosts } : {}),
    ...(overrides.hostsRange !== undefined ? { hostsRange: overrides.hostsRange } : {}),
    ...(overrides.become !== undefined ? { become: overrides.become } : {}),
    ...(overrides.vars !== undefined ? { vars: overrides.vars } : {}),
  };
}

export function makeVariableDecl(
  name: string,
  value: unknown,
  sourceKind: VariableDeclNode['sourceKind'] = 'play-vars',
  overrides: Partial<VariableDeclNode> = {},
): VariableDeclNode {
  return {
    name,
    value,
    rawValue: overrides.rawValue ?? String(value),
    keyRange: overrides.keyRange ?? makeRange(1, 2, 10, 1, 2 + name.length, 10 + name.length),
    valueRange: overrides.valueRange ?? makeRange(1, 10, 18, 1, 18, 26),
    sourceKind,
  };
}

export function makeAst(
  uri = 'file:///workspace/site.yml',
  kind: AnsibleDocumentKind = 'playbook',
  overrides: Partial<AnsibleDocumentAst> = {},
): AnsibleDocumentAst {
  return {
    uri,
    kind,
    text: overrides.text ?? '',
    plays: overrides.plays ?? [],
    tasks: overrides.tasks ?? [],
    handlers: overrides.handlers ?? [],
    variables: overrides.variables ?? [],
    jinjaBlocks: overrides.jinjaBlocks ?? [],
    duplicateKeys: overrides.duplicateKeys ?? [],
    rawTruthyValues: overrides.rawTruthyValues ?? [],
    syntaxErrors: overrides.syntaxErrors ?? [],
  };
}

export function createTestMetadataRegistry(): MetadataRegistry {
  const registry = new MetadataRegistry();

  const modules: Record<string, ModuleMetadataSpec> = {
    'ansible.builtin.stat': {
      fqcn: 'ansible.builtin.stat',
      shortName: 'stat',
      collection: 'ansible.builtin',
      shortDescription: 'Retrieve file or file system status',
      description: 'Retrieves facts for a file similar to the Linux/Unix stat command.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/stat_module.html',
      options: {
        path: {
          name: 'path',
          type: 'path',
          required: true,
          aliases: ['dest', 'name'],
          description: 'The full path of the file/object to get the facts of.',
        },
        follow: {
          name: 'follow',
          type: 'bool',
          default: false,
          description: 'Whether to follow symlinks.',
        },
        checksum_algorithm: {
          name: 'checksum_algorithm',
          type: 'str',
          choices: ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'],
          default: 'sha1',
          description: 'Algorithm to determine checksum of file.',
        },
      },
      returnFields: {
        stat: {
          name: 'stat',
          type: 'dict',
          returned: 'success, path exists',
          description: 'Dictionary containing all the stat data.',
          contains: {
            exists: {
              name: 'exists',
              type: 'bool',
              returned: 'always',
              description: 'If the destination path actually exists or not.',
              sample: true,
            },
            isdir: {
              name: 'isdir',
              type: 'bool',
              returned: 'success, path exists',
              description: 'Tells you if the path is a directory.',
            },
            size: {
              name: 'size',
              type: 'int',
              returned: 'success, path exists',
              description: 'Size in bytes for a plain file.',
            },
          },
        },
      },
    },
    'ansible.builtin.copy': {
      fqcn: 'ansible.builtin.copy',
      shortName: 'copy',
      collection: 'ansible.builtin',
      shortDescription: 'Copy files to remote locations',
      description: 'Copies a file from the local machine to remote locations.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/copy_module.html',
      options: {
        src: {
          name: 'src',
          type: 'path',
          description: 'Local path to a file to copy to the remote server.',
        },
        dest: {
          name: 'dest',
          type: 'path',
          required: true,
          description: 'Remote absolute path where the file should be copied to.',
        },
        mode: {
          name: 'mode',
          type: 'raw',
          description: 'The permissions of the destination file or directory.',
        },
        backup: {
          name: 'backup',
          type: 'bool',
          default: false,
          description: 'Create a backup file including the timestamp information.',
        },
        attributes: {
          name: 'attributes',
          type: 'str',
          aliases: ['attr'],
          description: 'The attributes the resulting filesystem object should have.',
        },
      },
      returnFields: {
        dest: {
          name: 'dest',
          type: 'str',
          returned: 'success',
          description: 'Destination file/path.',
        },
        checksum: {
          name: 'checksum',
          type: 'str',
          returned: 'success',
          description: 'SHA1 checksum of the file after running copy.',
        },
      },
    },
    'ansible.builtin.template': {
      fqcn: 'ansible.builtin.template',
      shortName: 'template',
      collection: 'ansible.builtin',
      shortDescription: 'Template a file out to a target host',
      description: 'Templates a Jinja2 file to a remote host.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/template_module.html',
      options: {
        src: {
          name: 'src',
          type: 'path',
          required: true,
          description: 'Path of a Jinja2 formatted template on the Ansible controller.',
        },
        dest: {
          name: 'dest',
          type: 'path',
          required: true,
          description: 'Location to render the template to on the remote machine.',
        },
        mode: {
          name: 'mode',
          type: 'raw',
          description: 'The permissions of the destination file.',
        },
      },
      returnFields: {},
    },
    'ansible.builtin.file': {
      fqcn: 'ansible.builtin.file',
      shortName: 'file',
      collection: 'ansible.builtin',
      shortDescription: 'Manage files and file properties',
      description: 'Set attributes of files, symlinks or directories.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/file_module.html',
      options: {
        path: {
          name: 'path',
          type: 'path',
          required: true,
          aliases: ['dest', 'name'],
          description: 'Path to the file being managed.',
        },
        state: {
          name: 'state',
          type: 'str',
          choices: ['absent', 'directory', 'file', 'hard', 'link', 'touch'],
          description: 'Desired state of the file.',
        },
        mode: {
          name: 'mode',
          type: 'raw',
          description: 'Permissions of the resulting filesystem object.',
        },
      },
      returnFields: {},
    },
    'ansible.builtin.command': {
      fqcn: 'ansible.builtin.command',
      shortName: 'command',
      collection: 'ansible.builtin',
      shortDescription: 'Execute commands on targets',
      description: 'Takes a command name followed by arguments.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/command_module.html',
      options: {
        cmd: {
          name: 'cmd',
          type: 'str',
          description: 'The command to run.',
        },
        creates: {
          name: 'creates',
          type: 'path',
          description:
            'A filename or glob pattern; if it already exists, this step will not be run.',
        },
        removes: {
          name: 'removes',
          type: 'path',
          description: 'A filename or glob pattern; if it exists, this step will be run.',
        },
      },
      returnFields: {
        cmd: {
          name: 'cmd',
          type: 'list',
          returned: 'always',
          description: 'The command executed by the task.',
        },
      },
    },
    'ansible.builtin.shell': {
      fqcn: 'ansible.builtin.shell',
      shortName: 'shell',
      collection: 'ansible.builtin',
      shortDescription: 'Execute shell commands on targets',
      description: 'Executes commands through a shell.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/shell_module.html',
      options: {
        cmd: {
          name: 'cmd',
          type: 'str',
          description: 'Shell command to execute.',
        },
        creates: {
          name: 'creates',
          type: 'path',
          description: 'Filename guard.',
        },
        removes: {
          name: 'removes',
          type: 'path',
          description: 'Filename guard.',
        },
      },
      returnFields: {},
    },
    'ansible.builtin.apt': {
      fqcn: 'ansible.builtin.apt',
      shortName: 'apt',
      collection: 'ansible.builtin',
      shortDescription: 'Manages apt-packages',
      description: 'Manages apt packages on Debian/Ubuntu.',
      docUrl: 'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/apt_module.html',
      options: {
        name: {
          name: 'name',
          type: 'list',
          aliases: ['pkg', 'package'],
          description: 'A list of package names.',
        },
        state: {
          name: 'state',
          type: 'str',
          choices: ['absent', 'build-dep', 'latest', 'present', 'fixed'],
          description: 'Indicates the desired package state.',
        },
        update_cache: {
          name: 'update_cache',
          type: 'bool',
          description: 'Run the equivalent of apt-get update before the operation.',
        },
      },
      returnFields: {},
    },
    'ansible.builtin.user': {
      fqcn: 'ansible.builtin.user',
      shortName: 'user',
      collection: 'ansible.builtin',
      shortDescription: 'Manage user accounts',
      description: 'Manage user accounts and user attributes.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/user_module.html',
      options: {
        name: {
          name: 'name',
          type: 'str',
          required: true,
          description: 'Name of the user to create, remove or modify.',
        },
        password: {
          name: 'password',
          type: 'str',
          description: 'Optionally set the user password.',
        },
        password_lock: {
          name: 'password_lock',
          type: 'bool',
          description: 'Lock the password.',
        },
        uid: {
          name: 'uid',
          type: 'int',
          description: 'Optionally sets the UID of the user.',
        },
      },
      returnFields: {},
    },
    'ansible.builtin.uri': {
      fqcn: 'ansible.builtin.uri',
      shortName: 'uri',
      collection: 'ansible.builtin',
      shortDescription: 'Interacts with webservices',
      description: 'Interacts with HTTP and HTTPS web services.',
      docUrl: 'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/uri_module.html',
      options: {
        url: {
          name: 'url',
          type: 'str',
          required: true,
          description: 'HTTP or HTTPS URL.',
        },
        headers: {
          name: 'headers',
          type: 'dict',
          description: 'Add custom HTTP headers.',
          suboptions: {
            Authorization: {
              name: 'Authorization',
              type: 'str',
              description: 'Auth header.',
            },
            timeout_ms: {
              name: 'timeout_ms',
              type: 'int',
              required: true,
              description: 'Header timeout.',
            },
          },
        },
      },
      returnFields: {},
    },
    'ansible.builtin.debug': {
      fqcn: 'ansible.builtin.debug',
      shortName: 'debug',
      collection: 'ansible.builtin',
      shortDescription: 'Print statements during execution',
      description: 'Prints statements during execution.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/debug_module.html',
      options: {
        msg: {
          name: 'msg',
          type: 'raw',
          description: 'The customized message that is printed.',
        },
        var: {
          name: 'var',
          type: 'str',
          description: 'A variable name to debug.',
        },
        verbosity: {
          name: 'verbosity',
          type: 'int',
          description: 'A number that controls when the debug is run.',
        },
      },
      returnFields: {},
    },
    'ansible.builtin.legacy_mod': {
      fqcn: 'ansible.builtin.legacy_mod',
      shortName: 'legacy_mod',
      collection: 'ansible.builtin',
      shortDescription: 'Legacy module',
      description: 'Deprecated test module.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/legacy_mod_module.html',
      deprecated: {
        removedIn: '2.20',
        why: 'Replaced by ansible.builtin.debug',
        alternative: 'ansible.builtin.debug',
      },
      options: {},
      returnFields: {},
    },
  };

  const pack: CollectionMetadataPack = {
    schemaVersion: 1,
    collection: 'ansible.builtin',
    version: '2.16.3',
    generatedAt: '2026-11-20T00:00:00Z',
    modules,
  };
  registry.loadPack(pack);
  return registry;
}
