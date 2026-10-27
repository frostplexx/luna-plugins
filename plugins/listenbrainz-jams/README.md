# ListenBrainz Jams

Creates and keeps three unlisted TIDAL playlists in sync with a public [ListenBrainz](https://listenbrainz.org) account:

- **Weekly Jams** — `weekly-jams`
- **Daily Jams** — `daily-jams`
- **Weekly Exploration** — `weekly-exploration`

It reads the recommendations from ListenBrainz's Atom feeds, matches each track against TIDAL, and writes the matches into playlists named `ListenBrainz Weekly Jams`, `ListenBrainz Daily Jams`, and `ListenBrainz Weekly Exploration`.

No ListenBrainz login or token is required: recommendation feeds are public for any username. The playlists are created as unlisted, so they do not appear on your public profile.

## Settings

- **ListenBrainz username** — the account whose recommendations should be imported.
- **Tracks per playlist** — number of tracks taken from the top of each feed (default 30).
- **Sync automatically** — refresh on TIDAL startup and at most once every six hours.
- **Sync now** — run a refresh immediately.

Tracks that cannot be matched confidently on TIDAL are skipped and counted in the sync status instead of being replaced with a wrong track.
