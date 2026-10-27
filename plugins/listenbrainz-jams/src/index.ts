import type { LunaUnload } from "@luna/core";

import { settings } from "./config";
import { syncAll } from "./sync";
import { trace } from "./trace";

export { Settings } from "./Settings";
export { errSignal, trace } from "./trace";

export const unloads = new Set<LunaUnload>();

const STARTUP_DELAY_MS = 30_000;
const CHECK_EVERY_MS = 60 * 60_000;
const MIN_SYNC_AGE_MS = 6 * 60 * 60_000;

const maybeAutoSync = () => {
	if (!settings.autoSync) return;
	if ((settings.username ?? "").trim() === "") return;
	if (Date.now() - settings.lastSyncAt < MIN_SYNC_AGE_MS) return;

	void syncAll()
		.then(({ matched, missing }) => trace.log(`Automatic sync finished: ${matched} tracks synced, ${missing} skipped`))
		.catch((error) => trace.err.withContext("Automatic sync")(error));
};

const startup = setTimeout(maybeAutoSync, STARTUP_DELAY_MS);
const interval = setInterval(maybeAutoSync, CHECK_EVERY_MS);

unloads.add(() => {
	clearTimeout(startup);
	clearInterval(interval);
});
