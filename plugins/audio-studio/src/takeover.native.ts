/**
 * AudioStudio — native (main-process) half of the deep playback hook.
 *
 * Runs inside TIDAL's main process via Luna's native plugin loader. It:
 *
 *  1. Requires TIDAL's own modules from `original.asar` (same Node module
 *     instances the running app uses, so prototype patches affect live objects).
 *  2. Monkey-patches `PlayerController.prototype.sendPlayerMessage` — the single
 *     funnel every UI playback command (media.load/play/pause/seek/volume/
 *     preload/...) passes through as a JSON string.
 *  3. Captures the live `PlayerController` instance to reach the native
 *     `TIDALPlayer` child process directly, and to spoof `playerSignal`s back
 *     into the web client (progress bar, queue advance, play state).
 *
 * Cross-platform: the identical controller/dispatcher code runs on macOS,
 * Windows and Linux, so this works wherever Luna + the native player runs.
 */

// #region TIDAL internals (resolved against process.resourcesPath)
type PlayerMessage = {
	command: string;
	url?: string;
	streamFormat?: string;
	encryptionKey?: string;
	time?: number;
	volume?: number;
};

type LoadPayload = {
	url: string;
	streamFormat: string;
	encryptionKey: string;
};

type PlayerSignal = {
	signal: string;
	[k: string]: unknown;
};

const CONTROLLER_PATH = "./original.asar/app/main/playback/player/PlayerController.js";
const DISPATCHER_PATH = "./original.asar/app/main/client/clientDispatcher.js";
const CHANNEL_ENUM_PATH = "./original.asar/app/shared/client/ClientMessageChannelEnum.js";

/** Channel native → renderer events are pushed on (luna.sendToRender = webContents.send). */
const RENDER_CHANNEL = "audioStudio.native";

// Lazy requires — resolved once on first use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PlayerController: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientDispatcher: any;
let PLAYBACK_PLAYER_SIGNAL: string;

// #endregion

// #region Hook state
type Mode = "passthrough" | "takeover";

let mode: Mode = "passthrough";
let patched = false;

/** Live PlayerController instance (captured on first patched call). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let controllerInstance: any;
/** Last media.load the UI issued — used for handback when control is released. */
let lastLoad: LoadPayload | undefined;
/** Last known playback position + volume, for a seamless handback. */
let lastPosition = 0;
let lastVolume = 100;

let origSendPlayerMessage: ((message: string) => void) | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origOnPlayerSignal: ((signal: PlayerSignal) => void) | undefined;
/** Set while entering takeover before a controller instance was captured — parked on first signal/command. */
let pendingPark = false;

const notify = (msg: unknown) => {
	try {
		globalThis.luna.sendToRender(RENDER_CHANNEL, msg);
	} catch {
		/* window may be gone */
	}
};

const ensureRequires = () => {
	if (PlayerController === undefined) {
		// require() here resolves against process.resourcesPath, hitting the SAME
		// module instances the app loaded (Node module cache).
		PlayerController = require(CONTROLLER_PATH).default;
	}
	if (clientDispatcher === undefined) {
		clientDispatcher = require(DISPATCHER_PATH).default;
		PLAYBACK_PLAYER_SIGNAL = require(CHANNEL_ENUM_PATH).default.PLAYBACK_PLAYER_SIGNAL;
	}
};

const parseMessage = (message: string | PlayerMessage): PlayerMessage | undefined => {
	try {
		return typeof message === "string" ? (JSON.parse(message) as PlayerMessage) : message;
	} catch {
		return undefined;
	}
};
// #endregion

// #region UI command interception (MITM)
const onUiCommand = (message: PlayerMessage) => {
	if (!message?.command?.startsWith("media.")) return;

	switch (message.command) {
		case "media.load":
		case "media.preload": {
			const payload: LoadPayload = {
				url: message.url!,
				streamFormat: message.streamFormat ?? "flac",
				encryptionKey: message.encryptionKey ?? "",
			};
			if (message.command === "media.load") lastLoad = payload;
			notify({ type: message.command, payload });
			break;
		}
		case "media.play":
		case "media.pause":
		case "media.stop":
		case "media.cancelpreload":
			notify({ type: message.command });
			break;
		case "media.seek":
			lastPosition = message.time ?? 0;
			notify({ type: "media.seek", time: message.time ?? 0 });
			break;
		case "media.volume":
			lastVolume = message.volume ?? 100;
			notify({ type: "media.volume", volume: message.volume ?? 100 });
			break;
		default:
			// Everything else (device queries etc.) is forwarded untouched below.
			return;
	}
};
// #endregion

// #region Exported — invoked from the renderer over IPC
/** Stop + mute the native player directly (bypassing our own MITM). */
const parkNative = () => {
	if (controllerInstance === undefined || origSendPlayerMessage === undefined) return;
	origSendPlayerMessage.call(controllerInstance, JSON.stringify({ command: "media.stop" }));
	origSendPlayerMessage.call(controllerInstance, JSON.stringify({ command: "media.volume", volume: 0 }));
};

export const patchHooks = async (): Promise<boolean> => {
	ensureRequires();
	if (patched) return true;
	const proto = PlayerController.prototype;

	// MITM the command funnel. `sendPlayerMessage` receives a JSON string.
	origSendPlayerMessage = proto.sendPlayerMessage;
	proto.sendPlayerMessage = function (this: unknown, message: string) {
		controllerInstance = this;
		const parsed = parseMessage(message);
		if (mode === "takeover") {
			onUiCommand(parsed!);
			return; // swallowed — the take-over engine owns playback
		}
		return origSendPlayerMessage!.call(this, message);
	};

	// Signals from the native player flow through `onPlayerSignal` constantly
	// while it plays (currenttime every ~500ms) — patch it as an eager capture
	// point so takeover parks the player immediately, even mid-track.
	origOnPlayerSignal = proto.onPlayerSignal;
	proto.onPlayerSignal = function (this: unknown, signal: PlayerSignal) {
		controllerInstance = this;
		if (pendingPark) {
			pendingPark = false;
			parkNative();
		}
		// Track the native player's position for a seamless handback.
		if (signal?.signal === "media.currenttime" && typeof signal.time === "number") lastPosition = signal.time;
		return origOnPlayerSignal!.call(this, signal);
	};

	patched = true;
	return true;
};

export const unpatchHooks = async (): Promise<boolean> => {
	if (!patched) return true;
	const proto = PlayerController.prototype;
	if (origOnPlayerSignal !== undefined) {
		proto.onPlayerSignal = origOnPlayerSignal;
		origOnPlayerSignal = undefined;
	}
	pendingPark = false;
	if (origSendPlayerMessage !== undefined) {
		proto.sendPlayerMessage = origSendPlayerMessage;
		origSendPlayerMessage = undefined;
	}
	patched = false;
	return true;
};

/** passthrough → takeover (engine owns audio), or takeover → passthrough (optionally resuming native playback). */
export const setMode = async (
	newMode: Mode,
	resume?: { resumePlayback: boolean; position?: number; playing?: boolean },
): Promise<boolean> => {
	ensureRequires();
	const previous = mode;
	mode = newMode;

	if (newMode === "takeover") {
		// Park the native player: stop current audio so nothing double-plays.
		// Volume is restored on handback. If we haven't captured the live
		// controller instance yet, park on the first signal/command instead.
		if (controllerInstance !== undefined) parkNative();
		else pendingPark = true;
		return true;
	}

	// Handback: re-load the captured stream into the native player at our position.
	if (previous === "takeover" && resume?.resumePlayback && lastLoad !== undefined) {
		const position = resume.position ?? lastPosition;
		sendDirect(
			{ command: "media.load", ...lastLoad },
			false,
		);
		sendDirect({ command: "media.volume", volume: lastVolume }, false);
		if (position > 0) sendDirect({ command: "media.seek", time: position }, false);
		// Preserve paused/playing state across the handback.
		sendDirect({ command: resume.playing === false ? "media.pause" : "media.play" }, false);
	}
	return true;
};

export const getNativeState = async (): Promise<{ mode: Mode; patched: boolean; hasLastLoad: boolean }> => ({
	mode,
	patched,
	hasLastLoad: lastLoad !== undefined,
});

/** Force native player commands straight through (bypasses our own MITM). */
export const playerCommand = async (message: PlayerMessage, _bypass = true): Promise<boolean> => {
	sendDirect(message, false);
	return true;
};

/**
 * Push a synthetic player signal into the web client. The client consumes the
 * exact same channel the native TIDALPlayer reports through, so spoofed
 * `media.currenttime` / `media.state` drive the UI, progress bar and queue
 * advance ("completed" triggers the next track) exactly like real playback.
 */
export const spoofSignal = async (signal: PlayerSignal): Promise<boolean> => {
	ensureRequires();
	// Queue-aware: before the web client reports loaded, real signals are queued
	// by PlayerController. Replicate that behaviour.
	if (controllerInstance?.signalQueue !== null && controllerInstance?.signalQueue !== undefined) {
		controllerInstance.signalQueue.push(signal);
	} else {
		clientDispatcher.send(PLAYBACK_PLAYER_SIGNAL, signal);
	}
	return true;
};

/** Derive the AES-128 stream key/nonce from a manifest keyId (see Luna's lib.native decrypt). */
export const deriveKey = async (keyId: string): Promise<{ key: string; nonce: string }> => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { createDecipheriv } = require("crypto");
	const mastKey = Buffer.from("UIlTTEMmmLfGowo/UC60x2H45W6MdGgTRfo/umg4754=", "base64");

	const keyIdBuffer = Buffer.from(keyId, "base64");
	const iv = keyIdBuffer.subarray(0, 16);
	const keyIdEnc = keyIdBuffer.subarray(16);

	const decryptor = createDecipheriv("aes-256-cbc", Uint8Array.from(mastKey), Uint8Array.from(iv));
	const keyIdDec = decryptor.update(Uint8Array.from(keyIdEnc));

	return {
		key: Buffer.from(keyIdDec.subarray(0, 16)).toString("hex"),
		nonce: Buffer.from(keyIdDec.subarray(16, 24)).toString("hex"),
	};
};

/** Fetch a stream URL in the main process (fallback for renderer CORS issues). */
export const fetchStream = async (url: string): Promise<Uint8Array> => {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Stream fetch failed: ${res.status} ${res.statusText}`);
	return new Uint8Array(await res.arrayBuffer());
};

export const nativeLog = async (...args: unknown[]): Promise<boolean> => {
	console.log("[AudioStudio.native]", ...args);
	return true;
};
// #endregion

// #region Direct player access
/** Send a command directly to the native TIDALPlayer process via the original funnel. */
const sendDirect = (message: PlayerMessage, useHook: boolean) => {
	// Controller not captured yet — the native player isn't running, nothing to control.
	if (controllerInstance === undefined) return;
	const serialized = JSON.stringify(message);
	if (useHook) {
		controllerInstance.sendPlayerMessage(serialized);
		return;
	}
	origSendPlayerMessage!.call(controllerInstance, serialized);
};
// #endregion
