import { redux } from "@luna/lib";
import { LunaButtonSetting, LunaSettings, LunaSwitchSetting, LunaTextSetting } from "@luna/ui";
import React from "react";

import { FEEDS, settings } from "./config";
import { getSyncStatus, onSyncStatus, syncAll, type SyncStatus } from "./sync";

const statusColor = (status: SyncStatus) => (status.error ? "#ff8a80" : status.running ? "#ffd180" : "#69f0ae");

const StatusLine = () => {
	const [status, setStatus] = React.useState(getSyncStatus);

	React.useEffect(() => onSyncStatus(setStatus), []);

	return (
		<div
			style={{
				padding: "10px 12px",
				borderRadius: 8,
				background: "rgba(255,255,255,0.05)",
				fontSize: 13,
				lineHeight: 1.5,
			}}
		>
			<div style={{ color: statusColor(status) }}>{status.running ? `⏳ ${status.stage}…` : status.stage}</div>
			{status.error && <div style={{ opacity: 0.8 }}>{status.error}</div>}
			{status.running && (
				<div style={{ opacity: 0.7 }}>
					Finished {status.completed} of {status.total}
				</div>
			)}
		</div>
	);
};

export const Settings = () => {
	const [username, setUsername] = React.useState(settings.username);
	const [autoSync, setAutoSync] = React.useState(settings.autoSync);
	const [running, setRunning] = React.useState(getSyncStatus().running);

	React.useEffect(() => onSyncStatus((status) => setRunning(status.running)), []);

	return (
		<LunaSettings>
			<LunaTextSetting
				title="ListenBrainz username"
				desc="Public ListenBrainz account used for the Weekly Jams, Daily Jams and Weekly Exploration feeds."
				value={username}
				placeholder="alice"
				onChange={(event) => {
					setUsername(event.target.value);
					settings.username = event.target.value;
					settings.lastSyncAt = 0;
				}}
			/>
			<LunaSwitchSetting
				title="Sync automatically"
				desc="Refresh the TIDAL playlists when TIDAL starts and at most once every six hours"
				checked={autoSync}
				onChange={(_event, checked) => {
					const next = checked ?? false;
					setAutoSync(next);
					settings.autoSync = next;
				}}
			/>
			<LunaButtonSetting
				title="Sync now"
				desc="Fetch the latest ListenBrainz recommendations and update the TIDAL playlists"
				loading={running}
				onClick={() => void syncAll().catch(() => {})}
			>
				Sync now
			</LunaButtonSetting>

			<StatusLine />

			{FEEDS.map((feed) => {
				const state = settings.playlists[feed.type];
				const synced = state?.syncedAt ? new Date(state.syncedAt).toLocaleString() : "never";
				return (
					<LunaButtonSetting
						key={feed.type}
						title={`Open ${feed.label}`}
						desc={`${state?.tracks ?? 0} track(s) · last synced ${synced}${state?.missing ? ` · ${state.missing} skipped` : ""}`}
						disabled={!state?.id}
						onClick={() => {
							if (state?.id) redux.actions["router/PUSH"]({ pathname: `/playlist/${state.id}`, search: "", replace: false });
						}}
					>
						Open
					</LunaButtonSetting>
				);
			})}
		</LunaSettings>
	);
};
