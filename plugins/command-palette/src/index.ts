import { LunaUnload, Tracer } from "@luna/core";
import { setupPalette } from "./Palette";

export const { trace } = Tracer("[ExamplePlugin]");

// export { Settings } from "./Settings";

// Functions in unloads are called when plugin is unloaded.
// Used to clean up resources, even listener dispose etc should be added here
export const unloads = new Set<LunaUnload>();

// Mount the palette once
const palette = setupPalette(unloads);

const handle = (e: KeyboardEvent) => {
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
		e.preventDefault();
		palette.toggle();
	} else if (e.key === "Escape" && palette.isOpen()) {
		e.preventDefault();
		palette.close();
	}
};

document.addEventListener("keydown", handle);
unloads.add(() => {
	document.removeEventListener("keydown", handle);
});
