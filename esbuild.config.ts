import { mkdir, readFile, readdir, writeFile } from "fs/promises";

import { listen, pluginBuildOptions } from "luna/build";

// Per-plugin build overrides.
const optsByFolder: Record<string, Parameters<typeof pluginBuildOptions>[1]> = {
	// "audio-studio" bundles its own mediabunny (the running @luna/lib bundle has
	// another copy inline, which sets `Symbol.for("mediabunny loaded")` at eval
	// time). Our copy is fully independent, so clear the stale flag in a banner
	// before our bundled mediabunny evaluates — silences the false-positive
	// "Mediabunny was loaded twice" warning.
	"audio-studio": { banner: { js: `delete globalThis[Symbol.for("mediabunny loaded")];` } },
};

const pluginFolders = await readdir("./plugins");
const buildConfigs = await Promise.all(
	pluginFolders.map((name) => pluginBuildOptions(`./plugins/${name}`, optsByFolder[name])),
);
listen(buildConfigs);

// Store manifest served at /store.json so TidaLuna's plugin store can list these plugins.
const storePackage = JSON.parse(await readFile("./package.json", "utf8"));
storePackage.plugins ??= buildConfigs.map((config) => config.outfile?.replace("./dist/", ""));
await mkdir("./dist", { recursive: true });
await writeFile("./dist/store.json", JSON.stringify(storePackage));
