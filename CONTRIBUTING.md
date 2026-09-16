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

The tag is the release. Pushing a `v*` tag runs the release workflow, which
refuses to publish when the tag and `package.json` disagree, then typechecks,
lints, tests, builds and publishes to npm.

### Once, before the first release

1. **An npm token.** On npmjs.com: _Access Tokens → Generate New Token →
   Classic → Automation_. A classic automation token can publish a package that
   does not exist yet and skips the 2FA prompt, which a CI run cannot answer. A
   granular token works too, but only after the package exists, so it is the
   token to switch to later.
2. **The token as a repository secret.** On GitHub: _Settings → Secrets and
   variables → Actions → New repository secret_, named `NPM_TOKEN`.
3. Nothing else. The package name, licence and files are already set, and
   `pnpm build` runs in the workflow.

### The first release

`package.json` already says `0.1.0` and nothing has been published, so it only
needs the tag:

```bash
git tag v0.1.0
git push --follow-tags
```

Afterwards, two things that only matter once:

```bash
npm owner add taliqs taliqraph          # the org owns the package; the name stays unscoped
npm publish --access public             # in a throwaway @taliqs/taliqraph, to hold the scoped name
```

The second one is a placeholder so nobody else can publish under your own name.

### Every release after

```bash
pnpm version patch      # or minor, or major: bumps package.json, commits, tags
git push --follow-tags
```

Then check it landed:

```bash
npm view taliqraph version
```

## Licence

Contributions are accepted under the Apache License 2.0, the same licence that
covers the project. You keep the copyright in what you write.
