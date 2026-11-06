// Read by .github/workflows/commitlint.yml. Conventional Commits, with one rule off:
// a subject may start with a name that has capitals (AGENTS.md, README), as several here do.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0],
  },
}
