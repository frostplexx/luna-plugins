import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LunaUnload } from "@luna/core";
import { StyleTag } from "@luna/lib";

import paletteStyles from "file://./style.css?minify";

import { PaletteItem } from "./PaletteItem";
import { openResult, playResult, loadUserPlaylists, search, searchUserContent, type SearchResult } from "./search";

export interface PaletteControls {
    open: () => void;
    close: () => void;
    toggle: () => void;
    isOpen: () => boolean;
}

const COMMIT_DEBOUNCE_MS = 75;

export const setupPalette = (unloads: Set<LunaUnload>): PaletteControls => {
    // Inject the stylesheet (self-removes via unloads)
    new StyleTag("luna-command-palette-styles", unloads, paletteStyles);

    const container = document.createElement("div");
    container.className = "luna-command-palette";
    document.body.appendChild(container);

    const root: Root = createRoot(container);
    // Unmount React first, then remove the container from the DOM
    unloads.add(() => root.unmount());
    unloads.add(() => container.remove());

    let openState = false;
    let setVisibleState: (v: boolean) => void = () => { };

    const setOpen = (open: boolean) => {
        openState = open;
        container.classList.toggle("open", open);
        setVisibleState(open);
    };

    const Palette = () => {
        const [visible, onVisibleChange] = useState(false);
        const [query, setQuery] = useState("");
        const [results, setResults] = useState<SearchResult[]>([]);
        const [selected, setSelected] = useState(0);
        const inputRef = useRef<HTMLInputElement>(null);
        const listRef = useRef<HTMLDivElement>(null);

        // Latest fetched results, only committed to state (rendered) after keyup debounce
        const latestResults = useRef<SearchResult[]>([]);
        const latestQuery = useRef("");
        const searchSeq = useRef(0); // Increments per query change so stale fetches are dropped
        const resolvedSeq = useRef(0); // Seq of the latest fetch that returned
        const lastKeyDownAt = useRef(0);
        const lastKeyUpAt = useRef(0);
        const committedQuery = useRef<string | null>(null); // Query the rendered list was last built for
        const commitTimer = useRef<ReturnType<typeof setTimeout>>();

        const commit = () => {
            const user = searchUserContent(latestQuery.current);
            const userKeys = new Set(user.map((r) => r.id));
            setResults([...user, ...latestResults.current.filter((r) => !userKeys.has(r.id))]);
            if (committedQuery.current !== latestQuery.current) {
                setSelected(0);
                committedQuery.current = latestQuery.current;
            }
        };

        // Commit only when no key is being held (last keydown happened before the last keyup).
        const commitIfIdle = () => {
            if (lastKeyDownAt.current <= lastKeyUpAt.current) commit();
        };

        const queryChanged = (value: string) => {
            latestQuery.current = value;
            const seq = ++searchSeq.current;
            if (value === "") {
                // Invalidate any in-flight fetches and clear results immediately
                latestResults.current = [];
                resolvedSeq.current = seq;
                commit();
                return;
            }
            search(value)
                .then((res) => {
                    if (seq !== searchSeq.current) return; // A newer query superseded this fetch
                    if (res !== undefined) latestResults.current = res;
                    resolvedSeq.current = seq;
                    commitIfIdle();
                })
                .catch(() => { });
        };

        useEffect(() => {
            setVisibleState = onVisibleChange;
        }, []);

        useEffect(() => {
            if (visible) {
                inputRef.current?.focus();
                loadUserPlaylists().then(() => {
                    if (latestQuery.current) commit();
                });
            } else {
                setQuery("");
                setResults([]);
                latestResults.current = [];
                latestQuery.current = "";
                searchSeq.current++;
                resolvedSeq.current = searchSeq.current;
                committedQuery.current = null;
            }
        }, [visible]);

        useEffect(() => {
            listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
        }, [selected, results]);

        // Prefetch search on keydown with the predicted query value.
        // Does NOT setQuery, the controlled input's onChange owns the value.
        const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
            // Keyboard navigation
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (results.length === 0) return;
                const dir = e.key === "ArrowDown" ? 1 : -1;
                setSelected((s) => (s + dir + results.length) % results.length);
                return;
            }
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                const r = results[selected];
                if (r) {
                    if (e.shiftKey) {
                        playResult(r);
                    } else {
                        openResult(r);
                    }
                    setOpen(false);
                }
                return;
            }
            // Modifier combos don't type
            if (e.ctrlKey || e.metaKey || e.altKey) return;


            lastKeyDownAt.current = Date.now();
            const input = e.currentTarget;
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? input.value.length;
            let value: string;
            if (e.key.length === 1) value = input.value.slice(0, start) + e.key + input.value.slice(end);
            else if (e.key === "Backspace") value = start !== end ? input.value.slice(0, start) + input.value.slice(end) : input.value.slice(0, Math.max(0, start - 1));
            else if (e.key === "Delete") value = start !== end ? input.value.slice(0, start) + input.value.slice(end) : input.value.slice(start, Math.max(start, input.value.length - 1));
            else return;

            if (value !== latestQuery.current) queryChanged(value);
        };

        // Commit results on keyup after a small debounce, re-syncing from the input's
        // authoritative value in case keydown predicted the wrong query
        const onKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
            lastKeyUpAt.current = Date.now();
            clearTimeout(commitTimer.current);
            commitTimer.current = setTimeout(() => {
                const value = inputRef.current?.value ?? "";
                if (value !== latestQuery.current) {
                    queryChanged(value);
                } else {
                    if (resolvedSeq.current === searchSeq.current) commit();
                }
            }, COMMIT_DEBOUNCE_MS);
        };

        if (!visible) return null;
        return (
            <>
                <input
                    ref={inputRef}
                    className="luna-command-palette-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    onKeyUp={onKeyUp}
                    placeholder="Search Tidal..."
                />
                <div className="luna-command-palette-list-wrap">
                    <div ref={listRef} className="luna-command-palette-list">
                        {results.map((r, i) => (
                            <PaletteItem
                                key={r.id}
                                type={r.type}
                                name={r.name}
                                artworkUrl={r.artworkUrl}
                                collectionKey={r.collectionKey}
                                selected={i === selected}
                                onClick={(e) => {
                                    // If shift key is held play instead of navigating to the result page
                                    if (e.shiftKey) {
                                        playResult(r);
                                    } else {
                                        openResult(r);
                                    }
                                    setOpen(false);
                                }}
                            />
                        ))}
                    </div>
                </div>
            </>
        );
    };

    root.render(<Palette />);

    return {
        open: () => setOpen(true),
        close: () => setOpen(false),
        toggle: () => setOpen(!openState),
        isOpen: () => openState,
    };
};
