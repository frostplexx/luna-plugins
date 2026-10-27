/**
 * AudioStudio — take-over playback engine (renderer process).
 *
 * Owns ALL audio once enabled: fetches the encrypted stream the UI handed to
 * the native player, decrypts it (WebCrypto AES-128-CTR), decodes it
 * (mediabunny + WebCodecs) and runs it through a WebAudio DSP graph
 * (karaoke center-cancellation, 3-band EQ, gapless crossfade).
 *
 * The native player is kept parked (stopped, volume 0) — the UI is kept
 * perfectly in sync by spoofing the player signals it normally receives.
 */
import { ALL_FORMATS, AudioBufferSink, BufferSource, Input } from "mediabunny";

import { deriveKey, fetchStream, spoofSignal } from "./takeover.native";
import { trace } from ".";

export type StudioSettings = {
	enabled: boolean;
	karaoke: boolean;
	/** Amount of low-frequency center channel kept when karaoke is on (0..1) — keeps bass/body. */
	karaokeBleed: number;
	/** dB, -12..12 */
	eqLow: number;
	eqMid: number;
	eqHigh: number;
	/** Crossfade length in seconds (0 = off). */
	crossfade: number;
	volume: number;
};

type LoadedTrack = {
	key: string; // normalized stream url (no token query)
	url: string;
	buffer: AudioBuffer;
	source: AudioBufferSourceNode;
	gain: GainNode;
	/** AudioContext time the source was started at */
	startedAt: number;
	/** Buffer offset playback began from */
	startOffset: number;
	playing: boolean;
};

const trackKey = (url: string) => url.split("?")[0]!;

export class TakeoverEngine {
	private ctx: AudioContext | undefined;
	private dsp: DSPGraph | undefined;

	private current: LoadedTrack | undefined;
	private preloads = new Map<string, Promise<AudioBuffer>>();
	/** Set while a crossfade hands over to a preloaded track; matching loads are ignored. */
	private handingOverTo: string | undefined;
	/** play() called before the take-over track finished decoding. */
	private playPending = false;

	private settings: StudioSettings;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private completedSentFor: string | undefined;
	private onError: (err: unknown) => void;

	constructor(settings: StudioSettings, onError: (err: unknown) => void) {
		this.settings = settings;
		this.onError = onError;
	}

	public updateSettings(next: StudioSettings) {
		const was = this.settings;
		this.settings = next;
		if (this.dsp === undefined) {
			trace.msg.log("Settings saved (engine idle — applied on next track)");
			return;
		}
		this.dsp.setKaraoke(next.karaoke);
		this.dsp.setKaraokeBleed(next.karaokeBleed);
		this.dsp.eqLow.gain.value = next.eqLow;
		this.dsp.eqMid.gain.value = next.eqMid;
		this.dsp.eqHigh.gain.value = next.eqHigh;
		this.dsp.master.gain.value = toGain(next.volume);
		const changed = (Object.keys(next) as (keyof StudioSettings)[]).filter((k) => was[k] !== next[k]);
		if (changed.length > 0) {
			trace.msg.log(
				`Live settings applied (${changed.join(", ")}): eq ${next.eqLow}/${next.eqMid}/${next.eqHigh} dB, karaoke ${next.karaoke ? "on" : "off"}, bleed ${next.karaokeBleed}`,
			);
		}
	}

	// #region AudioContext / DSP graph
	private ensureCtx() {
		if (this.ctx !== undefined) return;
		this.ctx = new AudioContext();
		this.dsp = new DSPGraph(this.ctx, this.settings);
	}
	// #endregion

	// #region Stream pipeline: fetch → decrypt → decode
	private async fetchAudio(url: string): Promise<ArrayBuffer> {
		try {
			// Renderer fetch rides Luna's main-process `https` protocol handler
			// (acts as a CORS-passing proxy for tidal urls).
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.arrayBuffer();
		} catch (err) {
			trace.msg.log(`Renderer fetch failed (${err}) — falling back to main-process fetch`);
			return new Uint8Array(await fetchStream(url)).buffer;
		}
	}

	private async decode(url: string, keyId: string | undefined): Promise<AudioBuffer> {
		this.ensureCtx();
		const ctx = this.ctx!;

		let data = await this.fetchAudio(url);
		if (keyId !== undefined && keyId !== "") {
			// OLD_AES: keyId is the security token — unwrap the stream key in the
			// main process, then AES-128-CTR decipher here (nonce(8) + zero counter(8)).
			const { key, nonce } = await deriveKey(keyId);
			const cryptoKey = await crypto.subtle.importKey("raw", hexToBytes(key), "AES-CTR", false, ["decrypt"]);
			const counter = new Uint8Array(16);
			counter.set(hexToBytes(nonce));
			data = await crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 64 }, cryptoKey, data);
		}

		const input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		if (track === null) throw new Error("No audio track in stream");

		const sink = new AudioBufferSink(track);
		const chunks: AudioBuffer[] = [];
		let total = 0;
		for await (const { buffer } of sink.buffers()) {
			chunks.push(buffer);
			total += buffer.length;
		}
		if (chunks.length === 0) throw new Error("Decoded zero buffers");

		const first = chunks[0]!;
		const out = ctx.createBuffer(Math.max(2, first.numberOfChannels), total, first.sampleRate);
		let offset = 0;
		for (const chunk of chunks) {
			for (let ch = 0; ch < first.numberOfChannels; ch++) {
				out.getChannelData(ch).set(chunk.getChannelData(ch), offset);
			}
			offset += chunk.length;
		}
		sink.close?.();
		return out;
	}
	// #endregion

	// #region Transport
	public async load(url: string, streamFormat: string, encryptionKey: string, startOffset = 0, paused = false) {
		const key = trackKey(url);
		if (this.current !== undefined && this.current.key === key) return; // already playing (crossfade hand-over)
		if (this.handingOverTo === key) {
			this.handingOverTo = undefined; // UI confirmed the track we already started
			return;
		}

		try {
			const buffer = await this.takeOrDecode(key, () => this.decode(url, encryptionKey || undefined));
			if (this.current !== undefined && this.current.key === key) return; // raced
			const offset = Math.max(0, Math.min(startOffset, buffer.duration - 0.05));
			const hold = paused && !this.playPending; // stay paused unless play was pressed during decode
			this.startTrack(buffer, offset, url, key, hold);
			this.spoofState(hold ? "paused" : "active", url);
			this.spoofDuration(buffer.duration, url);
			this.spoofFormat(url);
			trace.msg.log(`Engine ${paused ? "loaded (paused)" : "playing"} ${key}${offset > 0.5 ? ` from ${offset.toFixed(1)}s` : ""}`);
		} catch (err) {
			trace.err(`Take-over load failed: ${err}`);
			this.onError(err);
		}
	}

	public async preload(url: string, streamFormat: string, encryptionKey: string) {
		const key = trackKey(url);
		if (this.preloads.has(key)) return;
		trace.msg.log(`Preloading next track for crossfade: ${key}`);
		this.preloads.set(
			key,
			this.decode(url, encryptionKey || undefined).catch((err) => {
				trace.err(`Preload decode failed: ${err}`);
				this.preloads.delete(key);
				throw err;
			}),
		);
	}

	public cancelPreload() {
		this.preloads.clear();
	}

	public play() {
		if (this.current === undefined) {
			// Play pressed while the take-over track is still decoding — remember
			// it so playback starts the instant decode finishes.
			this.playPending = true;
			void this.ctx?.resume();
			return;
		}
		this.playPending = false;
		if (this.ctx?.state === "suspended") void this.ctx.resume();
		if (!this.current.playing) {
			this.current.playing = true;
			this.spoofState("active", this.current.url);
		}
	}

	public pause() {
		this.playPending = false;
		if (this.ctx?.state === "running") void this.ctx.suspend();
		if (this.current !== undefined) {
			this.current.playing = false;
			this.spoofState("paused", this.current.url);
		}
	}

	public stop() {
		if (this.current !== undefined) {
			try {
				this.current.source.stop();
			} catch {
				/* already stopped */
			}
			this.current.source.disconnect();
			this.current = undefined;
		}
		this.spoofState("stopped");
	}

	public seek(time: number) {
		const cur = this.current;
		if (cur === undefined) return;
		// Native TIDAL semantics: seeking while paused keeps the player paused.
		const wasPlaying = cur.playing;
		cur.source.stop();
		cur.source.disconnect();
		const buffer = cur.buffer;
		this.startTrack(buffer, Math.max(0, Math.min(time, buffer.duration - 0.05)), cur.url, cur.key, !wasPlaying);
		this.spoofState(wasPlaying ? "active" : "paused", cur.url);
	}

	/** True while a track is actually playing through the engine (not paused). */
	public isPlaying(): boolean {
		return this.current?.playing === true;
	}

	public setVolume(volume: number) {
		this.dsp?.setVolume(volume);
	}

	public currentTime(): number {
		const cur = this.current;
		if (cur === undefined || this.ctx === undefined) return 0;
		return Math.min(cur.buffer.duration, cur.startOffset + (this.ctx.currentTime - cur.startedAt));
	}

	public dispose() {
		this.stop();
		this.cancelPreload();
		this.stopTicker();
		void this.ctx?.close();
		this.ctx = undefined;
		this.dsp = undefined;
	}
	// #endregion

	// #region Internals
	private takeOrDecode(key: string, decode: () => Promise<AudioBuffer>) {
		const pre = this.preloads.get(key);
		this.preloads.delete(key);
		return pre !== undefined ? pre : decode();
	}

	private startTrack(buffer: AudioBuffer, offset: number, url: string, key: string, paused = false) {
		this.ensureCtx();
		const ctx = this.ctx!;
		if (!paused) void ctx.resume();

		if (this.current !== undefined) {
			try {
				this.current.source.stop();
			} catch {
				/* noop */
			}
			this.current.source.disconnect();
			this.current.gain.disconnect();
		}

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		const gain = ctx.createGain();
		source.connect(gain);
		gain.connect(this.dsp!.input);
		const startedAt = ctx.currentTime + 0.02;
		source.start(startedAt, offset);

		this.current = { key, url, buffer, source, gain, startedAt, startOffset: offset, playing: !paused };
		this.completedSentFor = undefined;
		this.startTicker();
	}

	private startTicker() {
		if (this.ticker !== undefined) return;
		this.ticker = setInterval(() => void this.tick(), 250);
	}

	private stopTicker() {
		if (this.ticker !== undefined) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private async tick() {
		const cur = this.current;
		if (cur === undefined || !cur.playing) return;
		const pos = this.currentTime();

		// Keep the UI progress bar moving.
		await spoofSignal({ signal: "media.currenttime", time: pos, url: cur.url });

		// Natural end.
		if (pos >= cur.buffer.duration - 0.15) {
			if (this.completedSentFor !== cur.key) {
				this.completedSentFor = cur.key;
				this.spoofState("completed", cur.url); // UI advances the queue → media.load for next track
			}
			return;
		}

		// Crossfade: next track preloaded and close enough to the end.
		const fade = this.settings.crossfade;
		if (fade > 0 && this.handingOverTo === undefined && this.current !== undefined && pos > cur.buffer.duration - fade) {
			for (const [key, pending] of this.preloads) {
				if (pos < cur.buffer.duration - fade) break;
				if (pending === undefined) continue;
				void this.beginCrossfade(key, pending, fade);
				break;
			}
		}
	}

	private async beginCrossfade(nextKey: string, pending: Promise<AudioBuffer>, fade: number) {
		const cur = this.current;
		if (cur === undefined || this.handingOverTo !== undefined) return;
		let buffer: AudioBuffer;
		try {
			buffer = await pending;
		} catch {
			return; // preload failed — natural end path will still fire
		}
		if (this.current !== cur || this.handingOverTo !== undefined) return;

		this.handingOverTo = nextKey;
		this.preloads.delete(nextKey);

		// Tell the UI the current track finished → it advances the queue and
		// sends media.load for the next track, which we'll recognise by url.
		this.completedSentFor = cur.key;
		this.spoofState("completed", cur.url);

		this.ensureCtx();
		const ctx = this.ctx!;
		void ctx.resume();

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(0.0001, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(1, ctx.currentTime + fade);
		source.connect(gain);
		gain.connect(this.dsp!.input);

		const startedAt = ctx.currentTime + 0.02;
		source.start(startedAt, 0);

		// Fade the old track out under the new one.
		cur.gain.gain.setValueAtTime(cur.gain.gain.value, ctx.currentTime);
		cur.gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + fade);
		const old = cur;
		setTimeout(() => {
			try {
				old.source.stop();
			} catch {
				/* noop */
			}
			old.source.disconnect();
			old.gain.disconnect();
		}, fade * 1000 + 150);

		this.current = { key: nextKey, url: nextKey, buffer, source, gain, startedAt, startOffset: 0, playing: true };
		this.spoofState("active", nextKey);
		this.spoofDuration(buffer.duration, nextKey);
		this.spoofFormat(nextKey);
		trace.msg.log(`Crossfading into ${nextKey}`);
	}
	// #endregion

	// #region Signal spoofing
	private spoofState(state: string, url?: string) {
		void spoofSignal({ signal: "media.state", state, ...(url !== undefined ? { url } : {}) }).catch(() => {});
	}
	private spoofDuration(duration: number, url: string) {
		void spoofSignal({ signal: "media.duration", duration, url }).catch(() => {});
	}
	private spoofFormat(url: string) {
		void spoofSignal({
			signal: "media.format",
			url,
			format: { codec: "flac", sampleRate: this.current?.buffer.sampleRate ?? 44100, bitDepth: 16 },
		}).catch(() => {});
	}
	// #endregion
}

class DSPGraph {
	public input: GainNode;
	public eqLow: BiquadFilterNode;
	public eqMid: BiquadFilterNode;
	public eqHigh: BiquadFilterNode;
	public master: GainNode;

	private directGain: GainNode;
	private karaokeGain: GainNode;
	private bleedGain: GainNode;

	constructor(ctx: AudioContext, settings: StudioSettings) {
		this.input = ctx.createGain();
		this.master = ctx.createGain();
		this.master.gain.value = toGain(settings.volume);

		// EQ chain
		this.eqLow = ctx.createBiquadFilter();
		this.eqLow.type = "lowshelf";
		this.eqLow.frequency.value = 150;
		this.eqMid = ctx.createBiquadFilter();
		this.eqMid.type = "peaking";
		this.eqMid.frequency.value = 1000;
		this.eqMid.Q.value = 0.8;
		this.eqHigh = ctx.createBiquadFilter();
		this.eqHigh.type = "highshelf";
		this.eqHigh.frequency.value = 5500;

		this.input.connect(this.eqLow);
		this.eqLow.connect(this.eqMid);
		this.eqMid.connect(this.eqHigh);

		// Direct path (karaoke off)
		this.directGain = ctx.createGain();
		this.directGain.gain.value = settings.karaoke ? 0 : 1;
		this.eqHigh.connect(this.directGain);
		this.directGain.connect(this.master);

		// Karaoke path: out_L = side + bleed, out_R = -side + bleed
		// where mid = (L+R)/2 (vocals), side = (L-R)/2 (stereo content).
		this.karaokeGain = ctx.createGain();
		this.karaokeGain.gain.value = settings.karaoke ? 1 : 0;
		this.eqHigh.connect(this.karaokeGain);

		const splitter = ctx.createChannelSplitter(2);
		this.karaokeGain.connect(splitter);

		const midSum = ctx.createGain();
		const gL = ctx.createGain();
		gL.gain.value = 0.5;
		const gR = ctx.createGain();
		gR.gain.value = 0.5;
		splitter.connect(gL, 0);
		splitter.connect(gR, 1);
		gL.connect(midSum);
		gR.connect(midSum);

		const sideSum = ctx.createGain();
		const sL = ctx.createGain();
		sL.gain.value = 0.5;
		const sR = ctx.createGain();
		sR.gain.value = -0.5;
		splitter.connect(sL, 0);
		splitter.connect(sR, 1);
		sL.connect(sideSum);
		sR.connect(sideSum);

		// Keep some low/mid "center" energy (bass, body) with vocals largely removed.
		const lowpass = ctx.createBiquadFilter();
		lowpass.type = "lowpass";
		lowpass.frequency.value = 180;
		this.bleedGain = ctx.createGain();
		this.bleedGain.gain.value = settings.karaokeBleed;
		midSum.connect(lowpass);
		lowpass.connect(this.bleedGain);

		// out_L = +side + bleed, out_R = -side + bleed
		const merger = ctx.createChannelMerger(2);
		const sidePlus = ctx.createGain();
		sidePlus.gain.value = 1;
		const sideMinus = ctx.createGain();
		sideMinus.gain.value = -1;
		sideSum.connect(sidePlus);
		sideSum.connect(sideMinus);
		sidePlus.connect(merger, 0, 0);
		sideMinus.connect(merger, 0, 1);
		this.bleedGain.connect(merger, 0, 0);
		this.bleedGain.connect(merger, 0, 1);

		merger.connect(this.master);
		this.master.connect(ctx.destination);

		this.setKaraoke(settings.karaoke);
	}

	public setKaraoke(on: boolean) {
		this.directGain.gain.value = on ? 0 : 1;
		this.karaokeGain.gain.value = on ? 1 : 0;
	}

	public setKaraokeBleed(amount: number) {
		this.bleedGain.gain.value = amount;
	}

	public setVolume(volume: number) {
		this.master.gain.value = toGain(volume);
	}
}

const toGain = (volumePercent: number) => Math.pow(Math.max(0, Math.min(100, volumePercent)) / 100, 2);

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}
