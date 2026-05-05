# Changelog

All notable changes to klar.

## Unreleased

### Added
- Splash / intro screen — single-shot, session-scoped, editorial cover layout (`css/welcome.css`)
- Journal v2 — conversational AI tutor chat that extracts profile facts and generates a personalised teaching plan (`css/journal.css`)
- `docs/ARCHITECTURE.md`, `docs/CHANGELOG.md`, `LICENSE`, `.editorconfig`

### Changed
- Settings modal slimmed to a single Reading pane; profile / family moved to the dedicated Journal view
- Profile inputs are now AI-driven: instead of empty textareas, the user chats with a tutor who silently extracts the same fields
- `weakAreas` migrated from preset-chip array to free-form string (one-time, automatic)

### Removed
- Old welcome screen with redundant level picker
- Legacy "You" + "Family" tabs inside Settings
