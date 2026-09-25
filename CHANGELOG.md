# Changelog

## 1.0.0

First release.

- Blocks chosen devices on a UniFi network while Five More Minutes has the computer locked, or whenever no timer is running.
- Settings page (English and Swedish) protected by an admin token.
- Certificate pinning, CA file or (named-insecure) unchecked TLS for the UniFi console.
- Lets everything back online when anything goes wrong, when stopped, and with `--release`.
- `--check` diagnoses the whole setup without changing anything.
