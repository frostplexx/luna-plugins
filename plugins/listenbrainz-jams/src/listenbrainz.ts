import type { JamType } from "./config";

export interface ListenBrainzTrack {
	title: string;
	creator: string;
	album?: string;
	duration?: number;
	identifier?: string[];
}

export interface RecommendationPlaylist {
	playlistId: string;
	title: string;
	tracks: ListenBrainzTrack[];
}

const FEED_BASE = "https://listenbrainz.org/syndication-feed/user";
const API_BASE = "https://api.listenbrainz.org/1";

const feedUrl = (username: string, type: JamType) =>
	`${FEED_BASE}/${encodeURIComponent(username)}/recommendations?recommendation_type=${type}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchText = async (url: string, accept: string) => {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, { headers: { Accept: accept } });
		if (res.ok) return res;
		if (res.status !== 429 || attempt >= 2) return res;

		const retryAfter = Number(res.headers.get("retry-after"));
		await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
	}
};

export const recordingMbid = (track: ListenBrainzTrack) => {
	for (const identifier of track.identifier ?? []) {
		const match = /musicbrainz\.org\/recording\/([0-9a-f-]+)/i.exec(identifier);
		if (match) return match[1];
	}
	return undefined;
};

/** ISRCs for its MusicBrainz recordings, fetched in one request. Optional: failures just fall back to text search. */
export const fetchRecordingIsrcs = async (tracks: ListenBrainzTrack[]) => {
	const mbids = [...new Set(tracks.map(recordingMbid).filter((mbid): mbid is string => !!mbid))];
	const result = new Map<string, string[]>();
	if (mbids.length === 0) return result;

	const res = await fetchText(`${API_BASE}/metadata/recording/?${new URLSearchParams({ recording_mbids: mbids.join(",") })}`, "application/json");
	if (!res.ok) return result;

	const body = (await res.json()) as Record<string, { recording?: { isrcs?: string[] } }>;
	for (const [mbid, metadata] of Object.entries(body)) {
		if (metadata.recording?.isrcs?.length) result.set(mbid, metadata.recording.isrcs);
	}
	return result;
};

export const fetchRecommendationPlaylist = async (username: string, type: JamType): Promise<RecommendationPlaylist> => {
	const feedRes = await fetchText(feedUrl(username, type), "application/atom+xml");
	if (feedRes.status === 404) throw new Error(`ListenBrainz user "${username}" was not found`);
	if (!feedRes.ok) throw new Error(`ListenBrainz feed returned ${feedRes.status} ${feedRes.statusText}`);

	const xml = await feedRes.text();
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	if (doc.getElementsByTagName("parsererror").length > 0) throw new Error(`ListenBrainz returned an invalid feed for ${type}`);

	const feed = doc.documentElement;
	const selfLink = Array.from(feed.children).find(
		(element) => element.localName === "link" && element.getAttribute("rel") === "self",
	);
	const playlistUrl = selfLink?.getAttribute("href");
	if (!playlistUrl) throw new Error(`ListenBrainz feed for ${type} did not contain a playlist link`);

	const playlistId = new URL(playlistUrl).searchParams.get("path");
	if (!playlistId) throw new Error(`ListenBrainz feed for ${type} contained an invalid playlist link`);

	const playlistRes = await fetchText(`${API_BASE}/playlist/${playlistId}`, "application/json");
	if (playlistRes.status === 404) throw new Error(`ListenBrainz playlist ${playlistId} was not found`);
	if (!playlistRes.ok) throw new Error(`ListenBrainz playlist returned ${playlistRes.status} ${playlistRes.statusText}`);

	const body = (await playlistRes.json()) as {
		playlist?: { title?: string; track?: ListenBrainzTrack[] };
	};
	const tracks = body.playlist?.track?.filter((track) => track.title && track.creator) ?? [];
	if (tracks.length === 0) throw new Error(`ListenBrainz playlist for ${type} is empty`);

	return {
		playlistId,
		title: body.playlist?.title ?? type,
		tracks,
	};
};
