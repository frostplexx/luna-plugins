import { redux } from "@luna/lib";

import { FEEDS, settings, type JamType, type PlaylistState } from "./config";
import { mapConcurrent } from "./concurrency";
import { fetchRecommendationPlaylist, fetchRecordingIsrcs } from "./listenbrainz";
import { resolveTracks, resetTidalAuth, writePlaylist } from "./tidal";
import { errSignal, trace } from "./trace";

export interface SyncStatus {
	running: boolean;
	stage: string;
	completed: number;
	total: number;
	error?: string;
}

export interface SyncReport {
	matched: number;
	missing: number;
}

let status: SyncStatus = {
	running: false,
	stage: "Idle",
	completed: 0,
	total: FEEDS.length,
};

const listeners = new Set<(status: SyncStatus) => void>();

const setStatus = (patch: Partial<SyncStatus>) => {
	status = { ...status, ...patch };
	for (const listener of listeners) listener(status);
};

export const getSyncStatus = () => status;

export const onSyncStatus = (listener: (status: SyncStatus) => void) => {
	listeners.add(listener);
	listener(status);
	return () => {
		listeners.delete(listener);
	};
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const getPlaylistState = (type: JamType): PlaylistState => (settings.playlists[type] ??= {});

let inFlight: Promise<SyncReport> | undefined;

const updateFeed = (type: JamType, patch: Partial<PlaylistState>) => {
	settings.playlists[type] = { ...getPlaylistState(type), ...patch };
};

const runSync = async (): Promise<SyncReport> => {
	const username = (settings.username ?? "").trim();
	if (username === "") {
		const message = "Set a ListenBrainz username first";
		setStatus({ running: false, stage: "Sync failed", error: message });
		errSignal!._ = message;
		throw new Error(message);
	}

	setStatus({ running: true, stage: "Starting", completed: 0, error: undefined });
	errSignal!._ = undefined;
	resetTidalAuth();

	let matched = 0;
	let missing = 0;
	let completed = 0;
	let firstError: string | undefined;
	let wrotePlaylist = false;

	await mapConcurrent(FEEDS, FEEDS.length, async (feed) => {
		try {
			updateFeed(feed.type, { error: undefined });
			setStatus({ stage: `Fetching ${feed.label}` });

			const playlist = await fetchRecommendationPlaylist(username, feed.type);
			const wanted = playlist.tracks;
			const isrcs = await fetchRecordingIsrcs(wanted).catch((error) => {
				trace.warn.withContext("Fetching ISRCs")(error);
				return new Map<string, string[]>();
			});

			setStatus({ stage: `Matching ${feed.label} (0/${wanted.length})` });
			const resolved = await resolveTracks(wanted, isrcs, (done, total) => {
				setStatus({ stage: `Matching ${feed.label} (${done}/${total})` });
			});

			if (resolved.ids.length === 0) throw new Error(`No TIDAL matches found for ${feed.label}`);
			if (resolved.missing.length > 0) trace.log(`${feed.label}: ${resolved.missing.length} track(s) had no TIDAL match`);

			setStatus({ stage: `Updating ${feed.label} playlist` });
			const id = await writePlaylist(feed, username, playlist.title, resolved.ids);

			updateFeed(feed.type, {
				id,
				syncedAt: Date.now(),
				sourceTitle: playlist.title,
				tracks: resolved.ids.length,
				missing: resolved.missing.length,
			});
			redux.actions["content/LOAD_PLAYLIST"]({ playlistUUID: id });
			redux.actions["content/LOAD_LIST_ITEMS_PAGE"]({ listName: `playlists/${id}`, listType: "mediaItems", reset: true });
			wrotePlaylist = true;

			matched += resolved.ids.length;
			missing += resolved.missing.length;
			completed++;
			setStatus({ completed });
			trace.log(`${feed.label}: synced ${resolved.ids.length}/${wanted.length} tracks`);
		} catch (error) {
			const message = errorMessage(error);
			firstError ??= message;
			updateFeed(feed.type, { error: message });
			trace.err.withContext(`Syncing ${feed.label}`)(error);
		}
	});

	if (wrotePlaylist) redux.actions["content/LOAD_CREATED_PLAYLISTS"]({ reset: true });

	if (firstError === undefined) {
		settings.lastSyncAt = Date.now();
		const message = `Synced ${matched} track(s)${missing > 0 ? `, skipped ${missing}` : ""}`;
		setStatus({ running: false, stage: message, completed: FEEDS.length });
		return { matched, missing };
	}

	setStatus({
		running: false,
		stage: completed > 0 ? "Synced with errors" : "Sync failed",
		error: firstError,
	});
	errSignal!._ = firstError;
	throw new Error(firstError);
};

export const syncAll = (): Promise<SyncReport> => {
	if (inFlight !== undefined) return inFlight;
	inFlight = runSync().finally(() => {
		inFlight = undefined;
	});
	return inFlight;
};
