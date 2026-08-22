# Follower Lens

A local-first, static PWA for comparing Instagram follower/following exports.

## What it does
- Imports Instagram JSON data exports, either as a ZIP or individual JSON files.
- Stores snapshots locally in IndexedDB.
- Calculates new followers, unfollowers, mutuals, not-following-back, and you-don't-follow-back.
- Exports CSV reports, printable/PDF reports, and local backup JSON.
- Does not request Instagram passwords or session cookies.

## Important limitation
This app only knows what is present in the snapshots you import. A missing account does not prove a block; it can also mean deactivation, deletion, username changes, or export differences.

## Run locally
Serve this directory over HTTP, for example:

    python3 -m http.server 8080

Then open http://localhost:8080.

For phone installation as a PWA, host the folder over HTTPS and use the browser's “Add to Home screen” / “Install app” option.
