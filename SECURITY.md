# Security Policy

## Supported versions

This project is a browser extension released as a rolling latest version. Only
the most recent release on the `main` branch is supported with security fixes.

| Version | Supported |
| --- | --- |
| latest (`main`) | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [**Security** tab](https://github.com/elad12390/group-gh-pr-files/security)
   of this repository.
2. Click **Report a vulnerability** to open a private advisory.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal PR URL or DOM sample helps).
- The browser and extension version affected.

You can expect an initial response within a few days. Once the issue is
confirmed and fixed, we'll coordinate disclosure and credit you if you'd like.

## Scope

This extension runs only on `https://github.com/*`, stores data locally via the
browser's `storage` API, and makes no network requests of its own. Reports that
involve those boundaries — content-script injection, local data handling, or
permission scope — are especially relevant.
