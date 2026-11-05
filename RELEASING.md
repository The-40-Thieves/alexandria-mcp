# Releasing alexandria-mcp

The org convention (see the organization's CONTRIBUTING): semver tags `vX.Y.Z`, one GitHub Release per tag, and the Release body is the changelog excerpt for that version. The product page at <https://the40thieves.dev/alexandria-mcp/> reads the latest GitHub Release, so a tag without a Release does not appear there.

## Steps

1. Add the `## X.Y.Z - YYYY-MM-DD` section to `CHANGELOG.md` and bump the version in `package.json` (`npm version X.Y.Z --no-git-tag-version`). Land that through a pull request like any other change.
2. Tag the merge commit on `main` and push the tag:

   ```bash
   git tag -s vX.Y.Z -m "alexandria-mcp vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. Publish to npm from the tagged commit (`npm publish --provenance --access public`), then create the GitHub Release for the tag:

   ```bash
   gh release create vX.Y.Z --title "Alexandria X.Y.Z" --notes-file <changelog excerpt>
   ```

4. The Release body is the `CHANGELOG.md` section for this version, nothing else. The hub shows the first paragraph of it.

## What the hub reads

`hub.json` at the repository root (tagline, one measured claim with its source and date, install snippets per client, docs path). Update the claim's `measured_on` date whenever the routing evaluation is re-run; the hub build rejects placeholder copy.
