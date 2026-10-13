import { ContentBase, TidalApi, redux } from "@luna/lib";

import type { PaletteItemType } from "./PaletteItem";

export interface SearchResult {
    id: string;
    type: PaletteItemType;
    name: string;
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
    albums?: Paged<{ id: string; title: string; cover?: string }>;
    playlists?: Paged<{ uuid: string; title: string; squareImage?: string }>;
    tracks?: Paged<{ id: string; title: string; album?: { cover?: string } }>;
}

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
        results.push({ id: `artist:${a.id}`, type: "artist", name: a.name, artworkUrl: ContentBase.formatCoverUrl(a.picture, { res: "320" }) });
    }
    for (const al of res.albums?.items ?? []) {
        results.push({ id: `album:${al.id}`, type: "album", name: al.title, artworkUrl: ContentBase.formatCoverUrl(al.cover, { res: "80" }) });
    }
    for (const p of res.playlists?.items ?? []) {
        results.push({ id: `playlist:${p.uuid}`, type: "playlist", name: p.title, artworkUrl: ContentBase.formatCoverUrl(p.squareImage, { res: "80" }) });
    }
    for (const t of res.tracks?.items ?? []) {
        results.push({ id: `track:${t.id}`, type: "track", name: t.title, artworkUrl: ContentBase.formatCoverUrl(t.album?.cover, { res: "80" }) });
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
            results.push({ id: `playlist:${p.uuid}`, type: "playlist", name: p.title, artworkUrl: ContentBase.formatCoverUrl(p.squareImage, { res: "80" }) });
        }
    }
    for (const id of favorites.albums) {
        const a = content.albums[String(id)];
        if (a?.title && a.title.toLowerCase().includes(q)) {
            results.push({ id: `album:${a.id}`, type: "album", name: a.title, artworkUrl: ContentBase.formatCoverUrl(a.cover, { res: "80" }) });
        }
    }
    for (const id of favorites.artists) {
        const a = content.artists[String(id)];
        if (a?.name && a.name.toLowerCase().includes(q)) {
            results.push({ id: `artist:${a.id}`, type: "artist", name: a.name, artworkUrl: ContentBase.formatCoverUrl(a.picture, { res: "320" }) });
        }
    }
    for (const id of favorites.tracks) {
        const t = content.mediaItems[String(id)]?.item;
        if (t?.title && t.title.toLowerCase().includes(q)) {
            results.push({ id: `track:${t.id}`, type: "track", name: t.title, artworkUrl: ContentBase.formatCoverUrl(t.album?.cover, { res: "80" }) });
        }
    }
    return results;
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
