import { LunaUnload, Tracer } from "@luna/core";
import { ipcRenderer, MediaItem, PlayState, Quality } from "@luna/lib";

import { TakeoverEngine, type StudioSettings } from "./engine";
import { patchHooks, setMode } from "./takeover.native";

export const { trace } = Tracer("[AudioStudio]");

export const unloads = new Set<LunaUnload>();

export { Settings } from "./Settings";

// #region Settings (persisted in localStorage)
const STORE_KEY = "audio-studio.settings";

const defaultSettings: StudioSettings = {
	enabled: false,
	karaoke: false,
	karaokeBleed: 0.3,
	eqLow: 0,
	eqMid: 0,
	eqHigh: 0,
	crossfade: 4,
	volume: 100,
};

const loadSettings = (): StudioSettings => {
	try {
		return { ...defaultSettings, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") };
	} catch {
		return defaultSettings;
	}
};

let settings = loadSettings();
export const getSettings = () => settings;

export const saveSettings = (next: StudioSettings) => {
	settings = next;
	localStorage.setItem(STORE_KEY, JSON.stringify(next));
	engine.updateSettings(next);
};
// #endregion

// #region Take-over engine
const releaseControl = (err?: unknown) => {
	if (err !== undefined) trace.err(`Releasing control: ${err}`);
	void setMode("passthrough", {
		resumePlayback: true,
		position: engine.currentTime(),
		playing: engine.isPlaying(),
	});
};

const engine = new TakeoverEngine(settings, releaseControl);
unloads.add(() => engine.dispose());
// #endregion

// #region Native event plumbing (main process → renderer)
type NativeEvent =
	| { type: "media.load"; payload: { url: string; streamFormat: string; encryptionKey: string } }
	| { type: "media.preload"; payload: { url: string; streamFormat: string; encryptionKey: string } }
	| { type: "media.play" | "media.pause" | "media.stop" | "media.cancelpreload" }
	| { type: "media.seek"; time: number }
	| { type: "media.volume"; volume: number };

// NOTE: Luna's `__ipcRenderer.on` wrapper strips the Electron event argument,
// so callbacks receive the payload args directly (no leading `event`).
ipcRenderer.on(unloads, "audioStudio.native", (msg?: NativeEvent) => {
	if (msg === undefined || settings.enabled !== true) return;
	switch (msg.type) {
		case "media.load":
			trace.msg.log(`media.load received: ${msg.payload.url.split("?")[0]}`);
			void engine.load(msg.payload.url, msg.payload.streamFormat, msg.payload.encryptionKey);
			break;
		case "media.preload":
			void engine.preload(msg.payload.url, msg.payload.streamFormat, msg.payload.encryptionKey);
			break;
		case "media.cancelpreload":
			engine.cancelPreload();
			break;
		case "media.play":
			engine.play();
			break;
		case "media.pause":
			engine.pause();
			break;
		case "media.stop":
			engine.stop();
			break;
		case "media.seek":
			engine.seek(msg.time);
			break;
		case "media.volume":
			engine.setVolume(msg.volume);
			break;
	}
});
// #endregion

// #region Enable / disable
/**
 * Seamlessly move the CURRENTLY PLAYING native track into the engine: fetch a
 * fresh stream (playbackinfo) for the active queue item and start decoding from
 * the native player's live position (compensated for decode latency). Without
 * this, enabling take-over mid-track would leave the DSP engine silent and all
 * setting changes inaudible until the next track.
 */
const resumeCurrentTrack = async () => {
	try {
		// If nothing has ever played there is no queue item to own.
		if (PlayState.playQueue.elements.length === 0) {
			trace.msg.log("Take-over resume: empty queue, engine idle until next track");
			return;
		}
		// A PAUSED track must also move into the engine — otherwise the parked
		// native player and the UI disagree until the next track is skipped.
		const playing = PlayState.playing;
		const itemId = PlayState.playQueue.elements[PlayState.playQueue.currentIndex]?.mediaItemId;
		const item = await MediaItem.fromId(itemId);
		if (item === undefined) {
			trace.msg.log(`Take-over resume: no MediaItem for id ${String(itemId)}`);
			return;
		}

		const t0 = Date.now();
		const nativePos = PlayState.currentTime;

		// Some tracks only have a DASH (segmented AAC) manifest at certain
		// qualities — cascade until Tidal hands us a plain FLAC stream.
		const qualities = [Quality.Max.audioQuality, Quality.High.audioQuality];
		let info: Awaited<ReturnType<typeof item.playbackInfo>> | undefined;
		for (const quality of qualities) {
			info = await item.playbackInfo(quality);
			if (info?.manifestMimeType === "application/vnd.tidal.bts") break;
		}
		const manifest = info?.manifest;
		if (manifest === undefined || !("urls" in manifest) || manifest.urls[0] === undefined) {
			trace.msg.log(
				`Take-over resume: only DASH manifests available (${info?.manifestMimeType ?? "none"}) — engine will own audio from the next track`,
			);
			return;
		}

		// While playing, compensate for fetch/decode time (~1-2s) so the
		// handover is gapless-ish. While paused, time doesn't advance — use the
		// exact native position.
		const offset = playing ? nativePos + (Date.now() - t0) / 1000 + 1 : nativePos;
		const encryptionKey = manifest.encryptionType === "NONE" ? "" : manifest.keyId;
		await engine.load(manifest.urls[0], manifest.codecs ?? "flac", encryptionKey, offset, !playing);
	} catch (err) {
		trace.err(`Seamless take-over resume failed: ${err}`);
	}
};

export const enable = async () => {
	await patchHooks(); // idempotent, safe to call repeatedly
	await setMode("takeover");
	await resumeCurrentTrack();
	trace.msg.log("Take-over enabled — AudioStudio owns playback");
};

export const disable = async (resumePlayback = true) => {
	await setMode("passthrough", {
		resumePlayback,
		position: engine.currentTime(),
		playing: engine.isPlaying(),
	});
	trace.msg.log(`Take-over disabled${resumePlayback ? " — native playback resumed" : ""}`);
};

// Auto-enable on plugin load if the stored setting says so.
if (settings.enabled) void enable();
// #endregion
