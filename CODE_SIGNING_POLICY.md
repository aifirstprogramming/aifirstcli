# Code signing policy

## Status and signing service

AI First Programming has applied to the SignPath Foundation for open-source
code signing. While the application is pending, published Windows executables
remain unsigned.

After approval, free code signing will be provided by
[SignPath.io](https://about.signpath.io), with a certificate provided by the
[SignPath Foundation](https://signpath.org). Every production signing request
will require approval by a designated project approver.

## Project roles

- Committer and reviewer: [steveonjava](https://github.com/steveonjava)
- Release approver: [steveonjava](https://github.com/steveonjava)

Project members with repository or signing access must use multi-factor
authentication for both GitHub and SignPath.

## Privacy and network access

The `aifirst` CLI does not collect telemetry and does not send source code,
project contents, learner progress, or personal information to AI First
Programming. Progress is stored locally in a plain JSON file controlled by the
learner.

Network access occurs only for an operation requested by the user:

- install and update commands download published files from AI First
  Programming and GitHub Releases;
- dependency installation invokes the selected language package manager after
  confirmation, using the package sources configured on the learner's system;
- local learning and replay commands communicate with an `aifirst` service on
  the loopback interface; and
- commands that launch an installed AI tool may cause that tool to contact its
  provider according to the tool's own configuration and privacy policy.

The CLI does not proxy AI-provider credentials or transmit them to AI First
Programming.

## System changes

The installer places the executable in a user-level application directory and
adds that directory to the user's `PATH`. It does not install a service,
driver, scheduled task, or startup entry, and it does not require administrator
privileges.

When requested, `aifirst init` and `aifirst skill install` write AI First skill
files into the selected AI tools' configuration directories. Optional command
permissions are displayed before confirmation, and `--no-permissions` skips
them. `aifirst skill remove` removes the installed skills and managed permission
entries. Dependency installation is separately confirmed before invoking the
language package manager.

## Build and release integrity

Release binaries are built from tagged public source by GitHub-hosted Actions
runners. The CLI embeds the Apache-2.0-licensed
[`aifirstcontent`](https://github.com/aifirstprogramming/aifirstcontent)
package and the open-source Bun runtime. Release checksums are generated after
all platform-specific processing and published beside the binaries.

After SignPath approval, Windows artifacts will be submitted directly from a
GitHub Actions artifact. SignPath will verify their build origin, apply the
SignPath Foundation Authenticode signature after manual approval, and return
the signed artifact to the release workflow. Only that returned artifact will
be published as a signed Windows release.
