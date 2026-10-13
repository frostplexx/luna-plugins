import React from "react";

export type PaletteItemType = "album" | "playlist" | "track" | "artist" | "collection";

export interface PaletteItemProps {
	type: PaletteItemType;
	name: string;
	/** Cover / profile picture URL. Resolved from e.g. `Album.coverUrl()`, `Artist.coverUrl()`, `MediaItem.coverUrl()` */
	artworkUrl?: string;
	/** For "collection" results: the sidebar data-test suffix used to source Tidal's own icon */
	collectionKey?: string;
	onClick?: (e: React.MouseEvent) => void;
	/** Highlighted via keyboard navigation */
	selected?: boolean;
}

export const PaletteItem = React.memo(({ type, name, artworkUrl, collectionKey, onClick, selected }: PaletteItemProps) => {
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
	}, [collectionKey, selected]);

	const itemClass = `luna-command-palette-item${selected ? " selected" : ""}${round ? " round" : ""}`;
	return (
		<div className={itemClass} onClick={onClick}>
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
			<span className="name">{name}</span>
			<span className="type">{type}</span>
		</div>
	);
});
