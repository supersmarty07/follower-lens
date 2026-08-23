# Follower Lens — secure local-first build

Follower Lens is a static Progressive Web App for comparing Instagram follower/following exports. It has no backend and does not require an Instagram password.

## Security model

- Instagram ZIP/JSON parsing happens in the browser on the user's device.
- Snapshot history is encrypted before storage using AES-256-GCM through the Web Crypto API.
- The encryption key is derived from the user's passphrase with PBKDF2-HMAC-SHA-256 using 600,000 iterations and a random 128-bit salt.
- The passphrase is not stored. The derived `CryptoKey` exists only in page memory while the vault is unlocked.
- Encrypted snapshot records are stored in IndexedDB (`follower-lens-db`, object store `vault`).
- A small non-secret encryption configuration (salt, iteration count and encrypted verifier) is stored in IndexedDB (`meta`).
- Existing v1 plaintext snapshots are migrated after the user creates/unlocks the encrypted vault, then the legacy plaintext object store is cleared.
- Encrypted backups copy only encrypted records and their encryption metadata. Restoring requires the backup passphrase.
- CSV and printable/PDF reports are intentionally plaintext exports and the app warns before creating them.
- The page includes a Content Security Policy with `connect-src 'none'`, no third-party scripts, no analytics and no ads.
- `app.js` is pinned from `index.html` with a SHA-384 Subresource Integrity hash for defense in depth. If `app.js` is edited, the hash in `index.html` must be regenerated.
- The service worker blocks cross-origin requests and caches only the app's own static assets.
- The app auto-locks after 10 minutes without interaction and clears decrypted UI state and its key reference when locked.
- “Erase local vault” deletes the entire Follower Lens IndexedDB database rather than only clearing rows.
- ZIP parsing has archive/file/entry size limits to reduce decompression-bomb and memory-exhaustion risk.

## Important limitations

Application-level encryption protects data stored at rest, but it cannot protect data while the vault is unlocked from a compromised browser, malicious browser extension, malware with access to the device, or a malicious replacement of the application itself. Protect the GitHub account that publishes this site with a passkey or strong 2FA. Use a unique, strong passphrase for Follower Lens.

GitHub Pages hosts only the static app files. Normal web hosting logs can include ordinary request metadata such as IP address and requests for `index.html`/`app.js`, but this application does not upload Instagram ZIP contents or follower data.

## Deploy on GitHub Pages

Place all files from this folder at the repository root:

- `index.html`
- `app.js`
- `sw.js`
- `manifest.json`
- `icon.svg`
- `icon-192.png`
- `icon-512.png`
- `README.md`

Then enable GitHub Pages from the `main` branch and `/ (root)`.

If you are replacing an older Follower Lens build, upload/replace **all** application files. The new service worker uses a new cache version and removes older Follower Lens caches when it activates. Reload the Pages site after GitHub finishes deploying; on Android, fully closing and reopening the installed PWA can also help it pick up the update.

## First launch

1. Open the HTTPS GitHub Pages URL.
2. Create a Follower Lens passphrase of at least 12 characters.
3. Keep the passphrase safe; it cannot be recovered by the app.
4. Import the Instagram ZIP or follower/following JSON files.
5. Periodically create an encrypted backup and store it somewhere you trust.

## No build step

This is a static application. There is no npm install, server process, backend, API key or database server required.


## If you already used the older plaintext build

The secure build detects v1 snapshots, encrypts them after you create/unlock the vault, then clears the legacy plaintext object store. Browser databases and phone flash storage do not provide a cryptographic guarantee that deleted bytes are forensically unrecoverable. If you had already imported sensitive real data and want the cleanest practical reset:

1. Deploy the secure build and let it migrate your old snapshots.
2. Create an encrypted Follower Lens backup.
3. Clear Follower Lens site data from Chrome/Android for the GitHub Pages site.
4. Reopen the secure site, create a fresh vault, and restore the encrypted backup using its original backup passphrase.

This removes the old browser database at the logical storage level. Physical flash-remanence behavior is controlled by the browser/OS/device and cannot be guaranteed by a web app.


## Secure relationship intelligence (v3)

This build derives additional relationship events locally from encrypted snapshots:
- recent unfollowers and new followers
- re-followers
- lost mutuals
- account reappearance signals
- possible block / account-unavailable signals (heuristic only, never confirmed)
- per-account relationship timelines
- recent relationship activity history

No new server, API, analytics, Instagram login, or network connection is added. These features are computed in browser memory after the encrypted vault is unlocked. The underlying encrypted snapshot format remains compatible with secure build v2 backups.

### Important block-detection limitation
Instagram follower/following exports do not provide a definitive `blocked_you` field. A user disappearing from both relationship lists may also be caused by account deactivation/deletion, a username change, or both sides changing follow state. Follower Lens labels these cases as possible/unavailable signals only.
