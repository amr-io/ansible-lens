module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'ci', 'build', 'chore'],
    ],
    'scope-empty': [2, 'never'],
    'header-max-length': [2, 'always', 120],
  },
};
