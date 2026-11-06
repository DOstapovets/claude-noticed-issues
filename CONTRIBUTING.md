# Contributing

Thanks for your interest in noticed-issues.

## Reporting bugs and requesting features

Open an issue with one of the forms: **Bug report** or **Feature request**. Questions,
and ideas you would like to talk through first, go to
[Discussions](https://github.com/DOstapovets/claude-noticed-issues/discussions).
A security problem goes through the **Security** tab, privately; see
[SECURITY.md](./SECURITY.md).

## Pull requests

The plugin is maintained by its author, who reviews and merges every change. Pull
requests are welcome, but please open an issue first for anything beyond a small fix,
so we can agree on the approach before you spend time on it.

Before opening one:

```sh
claude plugin validate .
claude plugin test .
```

Both must pass. Keep the change focused, add or update a test in
`hooks/register.test.tsx` for what it changes, and update the README where behaviour
changes. By contributing you agree that your contribution is licensed under the
[MIT License](./LICENSE).
