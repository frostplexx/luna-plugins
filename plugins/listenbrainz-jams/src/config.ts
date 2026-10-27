import { ReactiveStore } from "@luna/core";

export type JamType = "weekly-jams" | "daily-jams" | "weekly-exploration";

export interface FeedDefinition {
	type: JamType;
	label: string;
	playlistTitle: string;
}

export const FEEDS: FeedDefinition[] = [
	{
		type: "weekly-jams",
		label: "Weekly Jams",
		playlistTitle: "ListenBrainz Weekly Jams",
	},
	{
		type: "daily-jams",
		label: "Daily Jams",
		playlistTitle: "ListenBrainz Daily Jams",
	},
	{
		type: "weekly-exploration",
		label: "Weekly Exploration",
		playlistTitle: "ListenBrainz Weekly Exploration",
	},
];

export interface PlaylistState {
	id?: string;
	syncedAt?: number;
	sourceTitle?: string;
	tracks?: number;
	missing?: number;
	error?: string;
}

export interface PluginSettings {
	username: string;
	playlistSize: number;
	autoSync: boolean;
	lastSyncAt: number;
	playlists: Record<JamType, PlaylistState>;
}

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("ListenBrainzJams", {
	username: "Frostplexx",
	playlistSize: 30,
	autoSync: true,
	lastSyncAt: 0,
	playlists: {
		"weekly-jams": {},
		"daily-jams": {},
		"weekly-exploration": {},
	},
});

// Old plugin storage can miss newer feed keys.
for (const feed of FEEDS) settings.playlists[feed.type] ??= {};
