import React from "react";

export type PaletteItemType = "album" | "playlist" | "track" | "artist" | "collection";

/** Subtitle fallback, mirroring TIDAL's native item type labels */
const TYPE_LABELS: Record<PaletteItemType, string> = {
	track: "Song",
	album: "Album",
	playlist: "Playlist",
	artist: "Artist",
	collection: "Collection",
};

export interface PaletteItemProps {
	type: PaletteItemType;
	name: string;
	/** Secondary line. Defaults to the item's type label (Song/Album/...) */
	subtitle?: string;
	/** Cover / profile picture URL. Resolved from e.g. `Album.coverUrl()`, `Artist.coverUrl()`, `MediaItem.coverUrl()` */
	artworkUrl?: string;
	/** For "collection" results: the sidebar data-test suffix used to source Tidal's own icon */
	collectionKey?: string;
	/** Highlighted without DOM focus (e.g. the pre-selected first row) */
	selected?: boolean;
	onClick?: (e: React.MouseEvent | React.KeyboardEvent) => void;
}

/**
 * A suggestion row mirroring TIDAL's native search "direct hit": 48px artwork,
 * title (description-demi) + subtitle, highlighted via `:focus-within` — rows
 * are focused (roving tabIndex) rather than class-toggled.
 */
export const PaletteItem = React.memo(({ type, name, subtitle, artworkUrl, collectionKey, selected, onClick }: PaletteItemProps) => {
	const round = type === "artist";
	// Fall back to the placeholder if the image fails to load
	const [broken, setBroken] = React.useState(false);
	React.useEffect(() => setBroken(false), [artworkUrl]);
	const [collectionIcon, setCollectionIcon] = React.useState<string | undefined>();
	React.useEffect(() => {
		if (!collectionKey) return;
		const el = document.querySelector(
			`[data-test="sidebar-collection-${collectionKey}"] svg, [data-test="sidebar-collection-${collectionKey}"] i`,
		);
		setCollectionIcon(el?.outerHTML);
	}, [collectionKey]);

	const itemClass = `luna-command-palette-item${round ? " round" : ""}${selected ? " luna-command-palette-selected" : ""}`;
	return (
		<div
			className={itemClass}
			role="button"
			tabIndex={-1}
			data-luna-palette-focusable=""
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick?.(e);
				}
			}}
		>
			{artworkUrl && !broken ? (
				<img className="luna-command-palette-artwork" src={artworkUrl} loading="lazy" onError={() => setBroken(true)} />
			) : collectionIcon ? (
				<span className="icon-slot" dangerouslySetInnerHTML={{ __html: collectionIcon }} />
			) : type === "collection" ? (
				<svg className="heart" viewBox="0 0 24 24" fill="currentColor">
					<path d="M12 21s-7.5-4.9-10-9.5C.5 8 2 4.5 5.5 4 7.7 3.7 9.7 4.8 12 7c2.3-2.2 4.3-3.3 6.5-3 3.5.5 5 4 3.5 7.5C19.5 16.1 12 21 12 21z" />
				</svg>
			) : (
				<div className="placeholder" />
			)}
			<span className="luna-command-palette-text">
				<span className="luna-command-palette-title">{name}</span>
				<span className="luna-command-palette-subtitle">{subtitle ?? TYPE_LABELS[type]}</span>
			</span>
		</div>
	);
});
