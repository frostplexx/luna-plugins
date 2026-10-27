import React from "react";

import { LunaNumberSetting, LunaSettings, LunaSwitchSetting } from "@luna/ui";

import { disable, enable, getSettings, saveSettings } from ".";

export const Settings = () => {
	const [settings, setSettings] = React.useState(getSettings());

	const update = React.useCallback((patch: Partial<typeof settings>) => {
		const next = { ...getSettings(), ...patch };
		setSettings(next);
		saveSettings(next);
	}, []);

	const onToggle = React.useCallback(
		async (_: React.ChangeEvent<HTMLInputElement>, checked?: boolean) => {
			update({ enabled: checked ?? false });
			if (checked) await enable();
			else await disable();
		},
		[update],
	);

	return (
		<LunaSettings>
			<LunaSwitchSetting
				title="Take Over Playback"
				desc="Intercept the playback controller and route all audio through a WebAudio DSP engine (decode + modify the stream yourself)"
				checked={settings.enabled}
				onChange={onToggle}
			/>
			<LunaSwitchSetting
				title="Karaoke (Remove Vocals)"
				desc="Center-channel cancellation: vocals are panned to the middle of the mix — this removes them while keeping bass and stereo width"
				checked={settings.karaoke}
				onChange={(_: React.ChangeEvent<HTMLInputElement>, v?: boolean) => update({ karaoke: v ?? false })}
			/>
			<LunaNumberSetting
				title="Karaoke Center Bleed"
				desc="0 = full vocal removal, 1 = keep all center content (bass/body). Type a value 0–1."
				value={settings.karaokeBleed}
				min={0}
				max={1}
				onNumber={(v) => update({ karaokeBleed: v })}
			/>
			<LunaNumberSetting title="EQ Low (dB)" value={settings.eqLow} min={-12} max={12} onNumber={(v) => update({ eqLow: v })} />
			<LunaNumberSetting title="EQ Mid (dB)" value={settings.eqMid} min={-12} max={12} onNumber={(v) => update({ eqMid: v })} />
			<LunaNumberSetting title="EQ High (dB)" value={settings.eqHigh} min={-12} max={12} onNumber={(v) => update({ eqHigh: v })} />
			<LunaNumberSetting
				title="Crossfade (s)"
				desc="Gapless overlapping transition into the next track. Requires the next track to be preloaded (normal queue playback). 0 = off."
				value={settings.crossfade}
				min={0}
				max={12}
				onNumber={(v) => update({ crossfade: v })}
			/>
		</LunaSettings>
	);
};
