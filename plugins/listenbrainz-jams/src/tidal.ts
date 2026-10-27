import { redux, TidalApi } from "@luna/lib";

import { settings, type FeedDefinition } from "./config";
import { createLimiter, mapConcurrent } from "./concurrency";
import { recordingMbid, type ListenBrainzTrack } from "./listenbrainz";
import { trace } from "./trace";

const V1 = "https://api.tidal.com/v1";
const V2 = "https://openapi.tidal.com/v2";
const TIDAL_CONCURRENCY = 8;
const MATCH_CONCURRENCY = 6;
const AUTH_TTL_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const limitTidal = createLimiter(TIDAL_CONCURRENCY);

let authCache: { headers: Record<string, string>; at: number } | undefined;
let authPromise: Promise<Record<string, string>> | undefined;

const getAuthHeaders = async () => {
	const now = Date.now();
	if (authCache !== undefined && now - authCache.at < AUTH_TTL_MS) return authCache.headers;

	authPromise ??= TidalApi.getAuthHeaders()
		.then((headers) => {
			authCache = { headers, at: Date.now() };
			return headers;
		})
		.finally(() => {
			authPromise = undefined;
		});
	return authPromise;
};

export const resetTidalAuth = () => {
	authCache = undefined;
	authPromise = undefined;
};

const request = async (url: string, init: RequestInit = {}) => {
	const headers = new Headers(init.headers);
	const authHeaders = await getAuthHeaders();
	for (const [key, value] of Object.entries(authHeaders)) headers.set(key, value);

	for (let attempt = 0; ; attempt++) {
		const res = await limitTidal(() => fetch(url, { ...init, headers }));
		if ((res.status === 429 || res.status >= 500) && attempt < 3) {
			const retryAfter = Number(res.headers.get("retry-after"));
			await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
			continue;
		}
		return res;
	}
};

const getJson = async <T>(url: string, init?: RequestInit): Promise<T | undefined> => {
	const res = await request(url, init);
	if (res.status === 403 || res.status === 404) return undefined;
	if (!res.ok) throw new Error(`TIDAL returned ${res.status} ${res.statusText} for ${url}`);
	return (await res.json()) as T;
};

const queryString = (params: Record<string, string | number | undefined>) =>
	Object.entries(params)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
		.join("&");

const countryCode = () => redux.store.getState().session.countryCode;

const v1 = <T>(path: string, params: Record<string, string | number | undefined> = {}) =>
	getJson<T>(
		`${V1}/${path}?${queryString({
			...params,
			countryCode: countryCode(),
			deviceType: "DESKTOP",
			locale: redux.store.getState().settings.language,
		})}`,
	);

type Ref = { id: string; type: string; meta?: Record<string, unknown> };
type Resource = Ref & { attributes?: Record<string, unknown> };
type JsonApiDoc = { data?: Resource | Resource[]; links?: { next?: string } };

const takesCountry = (path: string) => !path.startsWith("userCollection");

const v2 = (path: string, params: Record<string, string | number | undefined> = {}) =>
	getJson<JsonApiDoc>(
		`${V2}/${path}?${queryString({ countryCode: takesCountry(path) ? countryCode() : undefined, ...params })}`,
		{ headers: { accept: "application/vnd.api+json" } },
	);

const nextUrl = (next: string) => (next.startsWith("http") ? next : `${V2}/${next.replace(/^\/(v2\/)?/, "")}`);

const v2All = async (path: string, params: Record<string, string | number | undefined> = {}, max = 1000) => {
	const data: Resource[] = [];
	let doc = await v2(path, params);
	while (doc) {
		data.push(...(Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : []));
		if (!doc.links?.next || data.length >= max) break;
		let url = nextUrl(doc.links.next);
		if (takesCountry(path) && !url.includes("countryCode=")) url += `${url.includes("?") ? "&" : "?"}countryCode=${countryCode()}`;
		doc = await getJson<JsonApiDoc>(url, { headers: { accept: "application/vnd.api+json" } });
	}
	return { data };
};

const v2Write = async (method: "POST" | "PATCH" | "DELETE", path: string, body: unknown) => {
	const url = `${V2}/${path}`;
	const res = await request(url, {
		method,
		body: JSON.stringify(body),
		headers: {
			"content-type": "application/vnd.api+json",
			accept: "application/vnd.api+json",
			"Idempotency-Key": crypto.randomUUID(),
		},
	});
	if (!res.ok) throw new Error(`TIDAL ${method} ${path} returned ${res.status} ${res.statusText}`);
	const text = await res.text();
	return text ? (JSON.parse(text) as JsonApiDoc) : undefined;
};

const asArray = <T>(value: T | T[] | undefined): T[] => (Array.isArray(value) ? value : value ? [value] : []);

interface TidalTrack {
	id: number | string;
	title?: string;
	duration?: number;
	isrc?: string;
	streamReady?: boolean;
	allowStreaming?: boolean;
	artist?: { id?: number | string; name?: string };
	artists?: { id?: number | string; name?: string }[];
	album?: { id?: number | string; title?: string };
}

interface SearchResponse {
	tracks?: { items?: TidalTrack[] };
}

const searchTracks = async (query: string) => {
	const res = await v1<SearchResponse>("search", { query, limit: 10, offset: 0 });
	return res?.tracks?.items ?? [];
};

interface IsrcSearchResponse {
	data?: { id: string; attributes?: { title?: string; availability?: string[] } }[];
}

const findTrackByIsrc = async (isrc: string) => {
	const query = queryString({
		countryCode: countryCode(),
		deviceType: "DESKTOP",
		locale: redux.store.getState().settings.language,
	});
	const res = await getJson<IsrcSearchResponse>(`${V2}/tracks?${query}&filter[isrc]=${encodeURIComponent(isrc)}`, {
		headers: { accept: "application/vnd.api+json" },
	});
	const tracks = res?.data?.filter((track) => !track.attributes?.availability || track.attributes.availability.length > 0) ?? [];
	const track = tracks[0];
	if (track === undefined) return undefined;
	return { id: String(track.id), score: 1, title: track.attributes?.title };
};

const normalize = (value: string) =>
	value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[’'`]/g, "")
		.replace(/&/g, " and ")
		.replace(/\b(?:feat\.?|ft\.?|featuring)\b.*$/i, " ")
		.replace(/[^a-z0-9]+/gi, " ")
		.trim()
		.toLowerCase();

const normalizeArtist = (value: string) =>
	normalize(value)
		.replace(/\b(?:and|the)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const variants = (value: string) => {
	const result = new Set<string>();
	const full = normalize(value);
	if (full) result.add(full);

	const withoutBrackets = normalize(value.replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
	if (withoutBrackets) result.add(withoutBrackets);
	return result;
};

const tokenOverlap = (a: string, b: string) => {
	const aTokens = new Set(a.split(" ").filter(Boolean));
	const bTokens = new Set(b.split(" ").filter(Boolean));
	if (aTokens.size === 0 || bTokens.size === 0) return 0;
	let shared = 0;
	for (const token of aTokens) if (bTokens.has(token)) shared++;
	return shared / Math.max(aTokens.size, bTokens.size);
};

const textScore = (aValue: string, bValue: string) => {
	let best = 0;
	for (const a of variants(aValue)) {
		for (const b of variants(bValue)) {
			if (a === b) return 1;

			const shorter = a.length <= b.length ? a : b;
			const longer = a.length <= b.length ? b : a;
			const ratio = longer.length === 0 ? 0 : shorter.length / longer.length;
			if (shorter.length >= 4 && longer.includes(shorter) && ratio >= 0.55) {
				best = Math.max(best, 0.8 + 0.2 * ratio);
			}

			best = Math.max(best, tokenOverlap(a, b) * 0.8);
		}
	}
	return best;
};

const artistScore = (creator: string, track: TidalTrack) => {
	const names = [...(track.artists ?? []).map((artist) => artist.name), track.artist?.name].filter((name): name is string => !!name);
	if (names.length === 0) return 0;

	const normalizedCreator = normalizeArtist(creator);
	const creatorTokens = new Set(normalizedCreator.split(" ").filter(Boolean));

	let best = 0;
	for (const name of [...names, names.join(" ")]) {
		const normalizedName = normalizeArtist(name);
		const nameTokens = normalizedName.split(" ").filter(Boolean);
		if (nameTokens.length > 0 && nameTokens.every((token) => creatorTokens.has(token))) {
			best = Math.max(best, 0.9 + 0.1 * (nameTokens.length / Math.max(creatorTokens.size, nameTokens.length)));
		}
		best = Math.max(best, textScore(normalizedCreator, normalizedName));
	}
	return best;
};

const durationScore = (listenBrainzMs?: number, tidalSeconds?: number) => {
	if (!listenBrainzMs || !tidalSeconds) return 0.6;
	const delta = Math.abs(listenBrainzMs / 1000 - tidalSeconds);
	if (delta <= 2) return 1;
	if (delta <= 8) return 0.9;
	if (delta <= 15) return 0.7;
	if (delta <= 25) return 0.4;
	return 0;
};

export interface TrackMatch {
	id: string;
	score: number;
	title?: string;
	artist?: string;
}

const matchTrack = (track: ListenBrainzTrack, candidates: TidalTrack[]): TrackMatch | undefined => {
	let best: TrackMatch | undefined;
	let bestTitle = 0;
	let bestArtist = 0;
	let bestDelta: number | undefined;

	for (const candidate of candidates) {
		if (candidate.streamReady === false || candidate.allowStreaming === false) continue;
		if (!candidate.title) continue;

		const title = textScore(track.title, candidate.title);
		const artist = artistScore(track.creator, candidate);
		const album = track.album && candidate.album?.title ? textScore(track.album, candidate.album.title) : 0.5;
		const duration = durationScore(track.duration, candidate.duration);
		const delta =
			track.duration !== undefined && candidate.duration !== undefined ? Math.abs(track.duration / 1000 - candidate.duration) : undefined;
		const score = title * 0.55 + artist * 0.3 + duration * 0.1 + album * 0.05;

		if (best === undefined || score > best.score) {
			best = {
				id: String(candidate.id),
				score,
				title: candidate.title,
				artist: candidate.artists?.[0]?.name ?? candidate.artist?.name,
			};
			bestTitle = title;
			bestArtist = artist;
			bestDelta = delta;
		}
	}

	if (best === undefined) return undefined;
	if (bestTitle < 0.78 || bestArtist < 0.55 || best.score < 0.72) return undefined;
	if (bestDelta !== undefined && bestDelta > 30) return undefined;
	return best;
};

const findTrack = async (track: ListenBrainzTrack) => {
	const candidates = await searchTracks(`${track.title} ${track.creator}`);
	return matchTrack(track, candidates);
};

export interface ResolvedTracks {
	ids: string[];
	missing: ListenBrainzTrack[];
}

export const resolveTracks = async (
	tracks: ListenBrainzTrack[],
	isrcsByMbid: Map<string, string[]> = new Map(),
	onProgress?: (done: number, total: number) => void,
): Promise<ResolvedTracks> => {
	let done = 0;

	const matches = await mapConcurrent(tracks, MATCH_CONCURRENCY, async (track) => {
		let match: TrackMatch | undefined;

		const mbid = recordingMbid(track);
		const isrcs = mbid ? (isrcsByMbid.get(mbid) ?? []) : [];
		for (const isrc of isrcs.slice(0, 3)) {
			match = await findTrackByIsrc(isrc).catch((err) => {
				trace.err.withContext(`Looking up ISRC ${isrc}`)(err);
				return undefined;
			});
			if (match !== undefined) break;
		}

		match ??= await findTrack(track).catch((err) => {
			trace.err.withContext(`Searching for ${track.creator} - ${track.title}`)(err);
			return undefined;
		});

		done++;
		onProgress?.(done, tracks.length);
		return match;
	});

	const ids: string[] = [];
	const seen = new Set<string>();
	const missing: ListenBrainzTrack[] = [];

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		if (match === undefined || seen.has(match.id)) {
			missing.push(tracks[index]);
			continue;
		}
		seen.add(match.id);
		ids.push(match.id);
	}

	return { ids, missing };
};

interface UserPlaylist {
	uuid?: string;
	title?: string;
	playlist?: UserPlaylist;
	item?: UserPlaylist;
}

const myPlaylists = async () => {
	const userId = redux.store.getState().session.userId;
	const playlists: UserPlaylist[] = [];
	for (let offset = 0; offset < 2000; offset += 100) {
		const page = await v1<{ items?: UserPlaylist[]; totalNumberOfItems?: number }>(`users/${userId}/playlists`, {
			limit: 100,
			offset,
		});
		playlists.push(...(page?.items ?? []));
		if (!page?.items?.length || offset + 100 >= (page.totalNumberOfItems ?? 0)) break;
	}
	return playlists.map((entry) => entry.item ?? entry.playlist ?? entry).filter((playlist): playlist is UserPlaylist => !!playlist.uuid);
};

const findPlaylistByTitle = async (title: string) => (await myPlaylists()).find((playlist) => playlist.title === title)?.uuid;

const playlistExists = async (id: string) => !!(await v2(`playlists/${id}`));

const createPlaylist = async (name: string, description: string) => {
	const doc = await v2Write("POST", "playlists", {
		data: { type: "playlists", attributes: { name, description, accessType: "UNLISTED" } },
	});
	const playlist = asArray(doc?.data)[0];
	if (playlist?.id === undefined) throw new Error("TIDAL created a playlist but returned no id");
	return String(playlist.id);
};

const updatePlaylist = (id: string, attributes: { name?: string; description?: string }) =>
	v2Write("PATCH", `playlists/${id}`, { data: { id, type: "playlists", attributes } });

const getPlaylistItems = async (id: string) =>
	(await v2All(`playlists/${id}/relationships/items`, {}, 1000)).data.map((item) => ({
		id: String(item.id),
		type: item.type,
		itemId: String(item.meta?.itemId ?? ""),
	}));

const removePlaylistItems = async (id: string, items: { id: string; type: string; itemId: string }[]) => {
	for (let index = 0; index < items.length; index += 20) {
		await v2Write("DELETE", `playlists/${id}/relationships/items`, {
			data: items.slice(index, index + 20).map((item) => ({ id: item.id, type: item.type, meta: { itemId: item.itemId } })),
		});
	}
};

const addPlaylistTracks = async (id: string, trackIds: string[]) => {
	for (let index = 0; index < trackIds.length; index += 20) {
		await v2Write("POST", `playlists/${id}/relationships/items`, {
			data: trackIds.slice(index, index + 20).map((trackId) => ({ id: trackId, type: "tracks" })),
			meta: { onDuplicates: "ADD" },
		});
	}
};

export const writePlaylist = async (feed: FeedDefinition, username: string, sourceTitle: string, trackIds: string[]) => {
	const title = feed.playlistTitle;
	const description = `ListenBrainz ${feed.label} for ${username} · ${sourceTitle} · synced ${new Date().toISOString().slice(0, 10)}`;

	let id = settings.playlists[feed.type]?.id;
	if (id !== undefined && !(await playlistExists(id))) id = undefined;
	if (id === undefined) id = await findPlaylistByTitle(title);

	if (id === undefined) {
		id = await createPlaylist(title, description);
	} else {
		await updatePlaylist(id, { name: title, description });
	}

	const oldItems = await getPlaylistItems(id);
	if (oldItems.length > 0) await removePlaylistItems(id, oldItems);
	if (trackIds.length > 0) await addPlaylistTracks(id, trackIds);

	return id;
};
