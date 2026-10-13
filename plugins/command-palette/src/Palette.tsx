import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { redux, type LunaUnload } from "@luna/lib";
import { StyleTag } from "@luna/lib";

import paletteStyles from "file://./style.css?minify";

import { PaletteItem } from "./PaletteItem";
import {
    addRecentSearch,
    clearRecentSearches,
    openResult,
    openSearchResults,
    playResult,
    loadUserPlaylists,
    readRecentSearches,
    search,
    searchUserContent,
    type SearchResult,
} from "./search";

export interface PaletteControls {
    open: () => void;
    close: () => void;
    toggle: () => void;
    isOpen: () => boolean;
}

const COMMIT_DEBOUNCE_MS = 75;

/**
 * Class names copied from TIDAL's live search field so the palette input is
 * styled by TIDAL's own stylesheet. TIDAL's class names are hash-suffixed CSS
 * modules (`_searchField_4b7fbda`) whose hashes change between app releases,
 * so they are read from the DOM instead of hardcoded.
 */
interface NativeFieldClasses {
    wrapper: string;
    input: string;
    /** Markup of TIDAL's own search icon (injected as-is) */
    icon: string;
    placeholder: string;
}

const readNativeField = (): NativeFieldClasses | undefined => {
    const input = document.querySelector<HTMLInputElement>(
        "input[data-test='search-input'], input[data-trigger-search]",
    );
    const wrapper = input?.parentElement;
    if (!input || !wrapper) return undefined;
    const icon = wrapper.querySelector("svg");
    return {
        wrapper: wrapper.className,
        input: input.className,
        icon: icon?.outerHTML ?? "",
        placeholder: input.placeholder || "Search TIDAL...",
    };
};

const SearchIconFallback = () => (
    <svg className="luna-command-palette-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M9 3h6a1 1 0 0 1 1 1v2h4a1 1 0 1 1 0 2h-1.1l-.86 12.03A2 2 0 0 1 16.05 22h-8.1a2 2 0 0 1-1.99-1.97L5.1 8H4a1 1 0 0 1 0-2h4V4a1 1 0 0 1 1-1zm1 3h4V5h-4v1zM7.11 8l.84 11.99a.5.5 0 0 1 0 .01h8.1L16.89 8H7.11z" />
    </svg>
);

const CloseIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
    </svg>
);

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
        const [nativeField, setNativeField] = useState<NativeFieldClasses>();
        // Roving focus, like TIDAL's suggestions: -1 = the input is focused,
        // 0..n-1 = result rows, n = the "View all results" footer
        const [focused, setFocused] = useState(-1);
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

        // "View all results" footer, shown whenever a query is present (like TIDAL's)
        const showFooter = query !== "";
        const focusableCount = results.length + (showFooter ? 1 : 0);

        const activate = (result: SearchResult, shift: boolean) => {
            if (shift) {
                playResult(result);
            } else {
                openResult(result);
                // Sync with TIDAL's own "Recent searches"
                addRecentSearch(result, query || result.name);
            }
            setOpen(false);
        };

        const commit = () => {
            const q = latestQuery.current;
            if (q === "") {
                // Empty query: show recent searches (like TIDAL's popover)
                setResults(readRecentSearches());
            } else {
                const user = searchUserContent(q);
                const userKeys = new Set(user.map((r) => r.id));
                setResults([...user, ...latestResults.current.filter((r) => !userKeys.has(r.id))]);
            }
            if (committedQuery.current !== q) {
                setFocused(-1);
                committedQuery.current = q;
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
                // Invalidate any in-flight fetches and show recents immediately
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
                // Copy TIDAL's live search field styling (fresh on every open)
                setNativeField(readNativeField());
                setFocused(-1);
                // Show recent searches right away (query is empty on open)
                commit();
                loadUserPlaylists().then(() => {
                    if (latestQuery.current) commit();
                });
            } else {
                setQuery("");
                setResults([]);
                setFocused(-1);
                latestResults.current = [];
                latestQuery.current = "";
                searchSeq.current++;
                resolvedSeq.current = searchSeq.current;
                committedQuery.current = null;
            }
        }, [visible]);

        // Live sync: re-read TIDAL's recent searches whenever the store changes
        // (e.g. recents added/removed via TIDAL's own search bar)
        useEffect(() => {
            const unsubscribe = redux.store.subscribe(() => {
                if (latestQuery.current === "") commit();
            });
            return unsubscribe;
        }, []);

        // Roving focus: mirror the focused index onto real DOM focus so the
        // native `:focus-within` row highlight applies
        useEffect(() => {
            if (!visible) return;
            if (focused < 0) {
                inputRef.current?.focus();
                return;
            }
            const el = listRef.current?.querySelectorAll<HTMLElement>("[data-luna-palette-focusable]")[focused];
            el?.focus();
            el?.scrollIntoView({ block: "nearest" });
        }, [focused, results, visible]);

        const onKeyDown = (e: React.KeyboardEvent) => {
            const input = inputRef.current;
            if (!input) return;
            const isInput = e.target === input;

            // Keyboard navigation: arrows move DOM focus through rows + footer
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (focusableCount === 0) return;
                const dir = e.key === "ArrowDown" ? 1 : -1;
                setFocused((f) => (f < 0 ? (dir === 1 ? 0 : focusableCount - 1) : (f + dir + focusableCount) % focusableCount));
                return;
            }
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                if (focusableCount === 0) return;
                const idx = focused < 0 ? 0 : Math.min(focused, focusableCount - 1);
                if (showFooter && idx === results.length) {
                    openSearchResults(query);
                    setOpen(false);
                    return;
                }
                const r = results[idx];
                if (r) activate(r, e.shiftKey);
                return;
            }
            // Modifier combos don't type
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            // Typing while a row/footer is focused: return focus to the input;
            // the key's default insertion then lands in the input and the
            // keyup debounce re-commits the query.
            if (!isInput && (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete")) {
                lastKeyDownAt.current = Date.now();
                input.focus();
                return;
            }
            if (!isInput) return;

            lastKeyDownAt.current = Date.now();
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
            <div
                className="luna-command-palette-inner"
                onKeyDown={onKeyDown}
                onClick={(e) => {
                    // Clicking the backdrop closes, like TIDAL's search backdrop
                    if (e.target === e.currentTarget) setOpen(false);
                }}
            >
                <div
                    className={nativeField ? `${nativeField.wrapper} luna-command-palette-input-wrap` : "luna-command-palette-input-wrap"}
                    onClick={() => inputRef.current?.focus()}
                >
                    {nativeField?.icon ? (
                        <span className="luna-command-palette-icon-slot" dangerouslySetInnerHTML={{ __html: nativeField.icon }} />
                    ) : (
                        <SearchIconFallback />
                    )}
                    <input
                        ref={inputRef}
                        type="search"
                        autoComplete="off"
                        spellCheck={false}
                        className={nativeField ? `luna-command-palette-input ${nativeField.input}` : "luna-command-palette-input"}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onKeyDown}
                        onKeyUp={onKeyUp}
                        placeholder={nativeField?.placeholder ?? "Search TIDAL..."}
                    />
                    {query && (
                        <button
                            className="luna-command-palette-clear"
                            onClick={() => {
                                setQuery("");
                                queryChanged("");
                                inputRef.current?.focus();
                            }}
                            aria-label="Clear search"
                        >
                            <CloseIcon />
                        </button>
                    )}
                </div>
                <div className="luna-command-palette-list-wrap">
                    <div ref={listRef} className="luna-command-palette-list">
                        {query === "" && results.length > 0 && (
                            <div className="luna-command-palette-section-header">
                                <span className="luna-command-palette-section-title">Recent searches</span>
                                <button
                                    className="luna-command-palette-section-clear"
                                    onClick={() => {
                                        clearRecentSearches();
                                        commit();
                                    }}
                                    aria-label="Clear recent searches"
                                >
                                    <TrashIcon />
                                </button>
                            </div>
                        )}
                        {results.map((r, i) => (
                            <PaletteItem
                                key={r.id}
                                type={r.type}
                                name={r.name}
                                subtitle={r.subtitle}
                                artworkUrl={r.artworkUrl}
                                collectionKey={r.collectionKey}
                                // Like TIDAL's suggestions, the first row is
                                // pre-selected while the input has focus
                                selected={i === (focused < 0 ? 0 : focused)}
                                onClick={(e) => activate(r, e.shiftKey)}
                            />
                        ))}
                        {query !== "" && results.length === 0 && <div className="luna-command-palette-empty">No results for “{query}”</div>}
                        {showFooter && (
                            <button
                                className="luna-command-palette-footer"
                                tabIndex={-1}
                                data-luna-palette-focusable=""
                                onClick={() => {
                                    openSearchResults(query);
                                    setOpen(false);
                                }}
                            >
                                <span className="luna-command-palette-footer-inner">
                                    <span className="luna-command-palette-footer-label">View all results&nbsp;</span>
                                    <span className="luna-command-palette-footer-phrase">{query}</span>
                                </span>
                            </button>
                        )}
                    </div>
                </div>
            </div>
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
