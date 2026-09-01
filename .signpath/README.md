# SignPath onboarding

The SignPath Foundation application is pending. This directory contains the
artifact definition that will be uploaded to the SignPath project after
approval; the release workflow does not submit signing requests yet.

Expected project settings:

- project slug: `aifirst-cli`
- signing policy slug: `release-signing`
- artifact configuration slug: `windows-release`
- artifact parameter: `version`, using the four-part Windows version such as
  `0.8.0.0`

The future GitHub integration will store the submitter API token as the
`SIGNPATH_API_TOKEN` repository secret and the SignPath organization ID as the
`SIGNPATH_ORGANIZATION_ID` repository variable. No certificate or private key
will be stored in GitHub.

The unsigned GitHub Actions artifact must contain exactly the three Windows
executables named by `artifact-configuration.xml`. After project approval, the
release workflow will submit that artifact with
`signpath/github-action-submit-signing-request`, wait for manual approval, and
publish only the signed artifact returned by SignPath.
