# Changelog

All notable changes are recorded here. Dates use America/New_York.

## [Unreleased]

### Added

- `scripts/upstream-smoke.sh` and a weekly Upstream compatibility workflow that run a protocol-only smoke against the latest published T3 Code release and open or update an `upstream-drift` issue on failure.
- `--provider-reply false` for `scripts/live-smoke.mjs`, and support for server versions beyond 0.0.44 and 0.0.45.

### Changed

- README: separate release-ZIP and build-from-source install steps, plus a Troubleshooting section.
- Documented that T3 Code 0.0.46 preview builds use orchestration protocol 2, which Outrigger does not support.

- The packaged accessibility suite now also checks the dark session list (previously only light session list and light/dark conversation views were checked).

### Security

- Enabled Dependabot security updates, dependency vulnerability alerts, secret scanning, and secret scanning push protection for this repository.
- Added `.github/dependabot.yml` for weekly npm and GitHub Actions dependency update PRs.

## [0.1.0] - 2026-10-02

Initial release. See [verification](docs/verification.md) for the checked scope and [live testing](docs/live-testing.md) for the isolated upstream record.
