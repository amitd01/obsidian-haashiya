# CLAUDE.md — Haashiya for Obsidian

## What this project is
Obsidian plugin that opens a note in Haashiya's editor (inline alternates, ghosted
text, version history, AI Lab) inside an Obsidian tab. Desktop only; Obsidian ≥1.11.4.
GPL-3.0. Installable via BRAT; community-plugin submission pending.

## Relationship to Margin-Jason
The editor core is built from `../Margin-Jason/obsidian/` (FR-02, AD-034). Fix
editor bugs there, rebuild with `obsidian/build.sh`, then copy `obsidian/dist/*`
here. This repo holds the published plugin, not the source of truth for the editor.

## Release steps
Bump `manifest.json` + `versions.json`, rebuild (`build.sh`), commit `main.js`,
`styles.css`, tag the version. Keep the README's names and icon reservation intact.

## Rules
- Never add network calls beyond the user's chosen AI provider.
- The API key stays in Obsidian secret storage; never in the vault.
