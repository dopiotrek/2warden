# Security

2warden handles secrets, so security reports are welcome.

## Reporting a problem

Please do **not** open a public issue for a security problem.
Use GitHub's private reporting instead: **Security → Report a vulnerability**
on this repository.

Include what you did, what you expected, and what happened. Never include real
secret values or access tokens in a report.

## Scope

In scope: anything where 2warden itself leaks a value or a token that the
README says it protects. For example: a value in an error message, in `find`
output, in unmasked `run` output, or in a command-line argument that 2warden
creates (apart from the documented `bws secret create` case).

Out of scope: the limits listed under "What it does not do" in the README.
For example: an agent that reads the Keychain directly, or a child process that
sends its own environment somewhere. Problems in Bitwarden or `bws` themselves
belong to [Bitwarden](https://bitwarden.com/help/vulnerability-disclosure/).
