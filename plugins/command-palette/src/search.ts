import { ContentBase, TidalApi, redux } from "@luna/lib";

import type { PaletteItemType } from "./PaletteItem";

export interface SearchResult {
    id: string;
    type: PaletteItemType;
    name: string;
    /** Secondary line, like TIDAL's "Album · Artist" suggestion subtitles */
    subtitle?: string;
    artworkUrl?: string;
    /** For "collection" results: the sidebar data-test suffix used to source the icon */
    collectionKey?: string;
}

interface Paged<T> {
    items: T[];
    totalNumberOfItems: number;
}

interface ApiArtist {
    id: string;
    name: string;
    picture?: string;
}

interface ApiSearchResponse {
    artists?: Paged<ApiArtist>;
    albums?: Paged<{ id: string; title: string; cover?: string; artist?: { name?: string } }>;
    playlists?: Paged<{ uuid: string; title: string; squareImage?: string; creator?: { name?: string } }>;
    tracks?: Paged<{ id: string; title: string; album?: { cover?: string }; artist?: { name?: string } }>;
}

/** Reads a loose `artist`/`creator` name off cached/API objects without fighting types */
const personName = (x: unknown): string | undefined => {
    const name = (x as { artist?: { name?: string }; creator?: { name?: string } })?.artist?.name
        ?? (x as { creator?: { name?: string } })?.creator?.name;
    return typeof name === "string" && name ? name : undefined;
};

/** Composes TIDAL-style subtitles: "Album · Artist", falling back to just the label */
const withPerson = (label: string, person?: string): string => (person ? `${label} · ${person}` : label);

/**
 * Queries Tidal's v1 search endpoint using the app's own credentials.
 * Returns `undefined` if the request failed (caller keeps its previous results).
 * @param limit Per-type result limit
 */
export const search = async (query: string, limit = 10): Promise<SearchResult[] | undefined> => {
    const url = `https://api.tidal.com/v1/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=0&${TidalApi.queryArgs()}`;
    const res = await TidalApi.fetch<ApiSearchResponse>(url);
    if (!res) return [];

    const results: SearchResult[] = [];
    for (const a of res.artists?.items ?? []) {
        results.push({ id: `artist:${a.id}`, type: "artist", name: a.name, subtitle: "Artist", artworkUrl: ContentBase.formatCoverUrl(a.picture, { res: "320" }) });
    }
    for (const al of res.albums?.items ?? []) {
        results.push({ id: `album:${al.id}`, type: "album", name: al.title, subtitle: withPerson("Album", al.artist?.name), artworkUrl: ContentBase.formatCoverUrl(al.cover, { res: "80" }) });
    }
    for (const p of res.playlists?.items ?? []) {
        results.push({ id: `playlist:${p.uuid}`, type: "playlist", name: p.title, subtitle: withPerson("Playlist", p.creator?.name), artworkUrl: ContentBase.formatCoverUrl(p.squareImage, { res: "80" }) });
    }
    for (const t of res.tracks?.items ?? []) {
        results.push({ id: `track:${t.id}`, type: "track", name: t.title, subtitle: withPerson("Song", t.artist?.name), artworkUrl: ContentBase.formatCoverUrl(t.album?.cover, { res: "80" }) });
    }
    return results;
};

interface UserPlaylist {
    uuid: string;
    title: string;
    squareImage?: string;
}

/**
 * The user's own collections (Tidal "My Collection" pages).
 */
const UserCollections: Record<string, string> = {
    tracks: "Tracks",
    albums: "Albums",
    artists: "Artists",
    playlists: "Playlists",
    videos: "Videos",
    "mixes-and-radio": "Mixes & Radio",
};

/**
 * Fetches the user's own (and followed) playlists from the API.
 * Cached for the session; call again to refresh.
 */
let userPlaylists: SearchResult[] = [];
let userPlaylistsPromise: Promise<void> | undefined;
export const loadUserPlaylists = (): Promise<void> => {
    userPlaylistsPromise ??= (async () => {
        try {
            const userId = redux.store.getState().user.meta.id;
            const url = `https://api.tidal.com/v1/users/${userId}/playlists?limit=1000&${TidalApi.queryArgs()}`;
            const res = await TidalApi.fetch<UserPlaylist[] | { items: UserPlaylist[] }>(url);
            const items = Array.isArray(res) ? res : res?.items;
            if (!items) return;
            userPlaylists = items.map((p) => ({
                id: `playlist:${p.uuid}`,
                type: "playlist" as const,
                name: p.title,
                subtitle: withPerson("Playlist", personName(p)),
                artworkUrl: ContentBase.formatCoverUrl(p.squareImage, { res: "80" }),
            }));
        } catch {
            // Keep whatever was cached before
        } finally {
            userPlaylistsPromise = undefined; // Allow retry on next call
        }
    })();
    return userPlaylistsPromise;
};

/**
 * Searches the user's own content from the redux cache + cached user playlists.
 * These results should always be pinned above remote search results.
 */
export const searchUserContent = (query: string): SearchResult[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const results: SearchResult[] = [];

    // Special case: the user's own collections 
    for (const [key, name] of Object.entries(UserCollections)) {
        if (name.toLowerCase().startsWith(q))
            results.push({ id: `collection:${key}`, type: "collection", name, collectionKey: key });
    }

    // User's own/followed playlists
    for (const p of userPlaylists) {
        if (p.name.toLowerCase().includes(q)) results.push(p);
    }

    // Favorited content from the redux store cache
    const { favorites, content } = redux.store.getState();

    for (const uuid of favorites.playlists) {
        const p = content.playlists[uuid];
        if (p?.title && p.title.toLowerCase().includes(q) && !results.some((r) => r.id === `playlist:${p.uuid}`)) {
            results.push({ id: `playlist:${p.uuid}`, type: "playlist", name: p.title, subtitle: withPerson("Playlist", personName(p)), artworkUrl: ContentBase.formatCoverUrl(p.squareImage, { res: "80" }) });
        }
    }
    for (const id of favorites.albums) {
        const a = content.albums[String(id)];
        if (a?.title && a.title.toLowerCase().includes(q)) {
            results.push({ id: `album:${a.id}`, type: "album", name: a.title, subtitle: withPerson("Album", personName(a)), artworkUrl: ContentBase.formatCoverUrl(a.cover, { res: "80" }) });
        }
    }
    for (const id of favorites.artists) {
        const a = content.artists[String(id)];
        if (a?.name && a.name.toLowerCase().includes(q)) {
            results.push({ id: `artist:${a.id}`, type: "artist", name: a.name, subtitle: "Artist", artworkUrl: ContentBase.formatCoverUrl(a.picture, { res: "320" }) });
        }
    }
    for (const id of favorites.tracks) {
        const t = content.mediaItems[String(id)]?.item;
        if (t?.title && t.title.toLowerCase().includes(q)) {
            results.push({ id: `track:${t.id}`, type: "track", name: t.title, subtitle: withPerson("Song", personName(t)), artworkUrl: ContentBase.formatCoverUrl(t.album?.cover, { res: "80" }) });
        }
    }
    return results;
};

/**
 * TIDAL's own "Recent searches" entries (`state.search.recentSearches`). Only
 * item entries are shown (`albums`/`artists`/`playlists`/`tracks`); the rest
 * (`search` phrases, `videos`, ...) are skipped.
 */
interface RecentSearchEntry {
    created: number;
    id: string | number;
    kind: string;
    text?: string;
}

const RECENTS_KIND_TO_TYPE: Record<string, PaletteItemType> = {
    albums: "album",
    artists: "artist",
    playlists: "playlist",
    tracks: "track",
};
const RECENTS_TYPE_TO_KIND: Record<string, string> = {
    album: "albums",
    artist: "artists",
    playlist: "playlists",
    track: "tracks",
};

/**
 * TIDAL's recent searches, mapped to palette results. Item entries are resolved
 * from the redux content caches (and skipped if missing, like TIDAL's own
 * restore saga does); phrase entries become `search` rows that re-run the query.
 */
export const readRecentSearches = (): SearchResult[] => {
    const state = redux.store.getState();
    const entries = state.search?.recentSearches ?? [];
    const { content } = state;

    const results: SearchResult[] = [];
    for (const entry of entries) {
        const type = RECENTS_KIND_TO_TYPE[entry.kind];
        if (!type) continue; // phrases ("search"), videos, etc. — not shown
        switch (type) {
            case "album": {
                const a = content.albums[String(entry.id)];
                if (a?.title)
                    results.push({ id: `album:${entry.id}`, type, name: a.title, subtitle: withPerson("Album", personName(a)), artworkUrl: ContentBase.formatCoverUrl(a.cover, { res: "80" }) });
                break;
            }
            case "artist": {
                const a = content.artists[String(entry.id)];
                if (a?.name)
                    results.push({ id: `artist:${entry.id}`, type, name: a.name, subtitle: "Artist", artworkUrl: ContentBase.formatCoverUrl(a.picture, { res: "320" }) });
                break;
            }
            case "playlist": {
                const p = content.playlists[String(entry.id)];
                if (p?.title)
                    results.push({ id: `playlist:${entry.id}`, type, name: p.title, subtitle: withPerson("Playlist", personName(p)), artworkUrl: ContentBase.formatCoverUrl(p.squareImage, { res: "80" }) });
                break;
            }
            case "track": {
                const t = content.mediaItems[String(entry.id)]?.item;
                if (t?.title)
                    results.push({ id: `track:${entry.id}`, type, name: t.title, subtitle: withPerson("Song", personName(t)), artworkUrl: ContentBase.formatCoverUrl(t.album?.cover, { res: "80" }) });
                break;
            }
        }
    }
    return results;
};

/**
 * Records an activation in TIDAL's own recent searches, so the entry also shows
 * up in TIDAL's search bar (TIDAL's saga persists it to its storage).
 */
export const addRecentSearch = (result: SearchResult, text: string): void => {
    const kind = RECENTS_TYPE_TO_KIND[result.type];
    if (!kind) return; // collections/phrases aren't item recents
    // Luna's generated action types mark this as `void` payload, but the runtime
    // action creator (patched from TIDAL's own bundle) takes the entry payload.
    const addToRecents = redux.actions["search/ADD_TO_RECENT_SEARCHES"] as unknown as (payload: RecentSearchEntry) => void;
    addToRecents({ created: Date.now(), id: result.id.split(":")[1], kind, text });
};

/** Clears TIDAL's recent searches (same as the trashcan in its search popover) */
export const clearRecentSearches = (): void => {
    redux.actions["search/CLEAR_RECENT_SEARCHES"]();
};

/**
 * Navigates to the full search results page for a query (TIDAL's "View all results").
 */
export const openSearchResults = (query: string): void => {
    redux.actions["router/PUSH"]({ pathname: "/search", search: `?q=${encodeURIComponent(query)}`, replace: false });
};

/**
 * Navigates to a search result (album/playlist/artist) or plays it (track).
 */
export const openResult = (result: SearchResult): void => {
    const id = result.id.split(":")[1];
    switch (result.type) {
        case "collection": {
            const sidebar = document.querySelector<HTMLElement>(`[data-test="sidebar-collection-${id}"]`);
            if (sidebar) sidebar.click();
            else redux.actions["router/PUSH"]({ pathname: `/my-collection/${id}`, search: "", replace: false });
            break;
        }
        case "album":
            redux.actions["router/PUSH"]({ pathname: `/album/${id}`, search: "", replace: false });
            break;
        case "playlist":
            redux.actions["router/PUSH"]({ pathname: `/playlist/${id}`, search: "", replace: false });
            break;
        case "artist":
            redux.actions["router/PUSH"]({ pathname: `/artist/${id}`, search: "", replace: false });
            break;
        case "track":
            redux.actions["content/FETCH_AND_PLAY_MEDIA_ITEM"]({
                itemId: Number(id),
                itemType: "track",
                sourceContext: { type: "search" },
            });
            break;
    }
};


/**
 * Replaces the play queue with the given media item ids and starts playback from the first one.
 * `sourceContext` tells the queue saga which RTK Query endpoint to use for hydrating the items.
 */
type AddMediaItemsPayload = Parameters<(typeof redux.actions)["playQueue/ADD_MEDIA_ITEMS_TO_QUEUE"]>[0];
const playMediaItems = (mediaItemIds: redux.ItemId[], sourceContext: AddMediaItemsPayload["sourceContext"]): void => {
	if (mediaItemIds.length === 0) return;
	redux.actions["playQueue/ADD_MEDIA_ITEMS_TO_QUEUE"]({
		mediaItemIds,
		position: "now",
		sourceContext,
		options: { fromRemote: true, overwritePlayQueue: true },
	});
	redux.actions["playbackControls/PLAY"]();
};

export const playResult = (result: SearchResult): void => {
	const id = result.id.split(":")[1];

	switch (result.type) {
		case "track": {
			redux.actions["content/FETCH_AND_PLAY_MEDIA_ITEM"]({
				itemId: Number(id),
				itemType: "track",
				sourceContext: { type: "search" },
			});
			break;
		}
		// `content/FETCH_AND_PLAY_MEDIA_ITEM` only supports track/video item types, so
		// collections are played by fetching their media item ids and queueing them.
		case "album": {
			void TidalApi.albumItems(Number(id)).then((items) =>
				playMediaItems(
					items?.map((mi) => mi.item.id) ?? [],
					{ type: "album", id: Number(id) },
				),
			);
			break;
		}
		case "playlist": {
			void TidalApi.playlistItems(id).then((res) =>
				playMediaItems(res?.items.map((mi) => mi.item.id) ?? [], { type: "playlist", id }),
			);
			break;
		}
		case "artist": {
			// Play the artist's top tracks
			void TidalApi.fetch<{ items: { id: number }[] }>(
				`https://api.tidal.com/v1/artists/${id}/toptracks?limit=25&offset=0&${TidalApi.queryArgs()}`,
			).then((res) => playMediaItems(res?.items.map((t) => t.id) ?? [], { type: "artist", id: Number(id) }));
			break;
		}
		case "collection": {
			// Only the "tracks" collection maps to a playable list (the user's favorited tracks);
			// other collections (albums/artists/playlists/...) contain no tracks, so navigate instead.
			if (id === "tracks") {
				playMediaItems(redux.store.getState().favorites.tracks, { type: "MY_TRACKS" });
			} else {
				openResult(result);
			}
			break;
		}
	}
};
