# Contributing

Issues and pull requests are welcome.

## Before you open a pull request

```bash
corepack enable
pnpm install
pnpm verify        # typecheck, lint, tests, build
```

Keep the change focused, and add a test beside the behaviour you change. The
runner has no home folder, no stores and no git: whatever a run needs arrives as
an option to `runWorkflow`. Anything that belongs to a host, such as a library of
packages, a task history or worktrees, lives in the host, not here.

## Sign your commits

This project uses the [Developer Certificate of Origin](https://developercertificate.org/).
Add a sign-off line to each commit, which `git commit -s` does for you:

```
Signed-off-by: Your Name <you@example.com>
```

By signing off you state that you wrote the change, or have the right to submit
it, under this project's licence.

## Releasing

The tag is the release. One command bumps the version, commits it and tags it:

```bash
pnpm version patch      # or minor, or major
git push --follow-tags
```

The push of a `v*` tag runs the release workflow, which refuses to publish if
the tag and `package.json` disagree, then typechecks, lints, tests, builds and
publishes to npm. The first release is the version already in `package.json`:

```bash
git tag v0.1.0 && git push --follow-tags
```

## Licence

Contributions are accepted under the Apache License 2.0, the same licence that
covers the project. You keep the copyright in what you write.
