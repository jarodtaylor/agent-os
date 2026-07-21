/**
 * Public surface of the config-write discipline engine (U14).
 * Every installer (U6/U8) and parity action (U10) imports its file-mutation primitives from here.
 */
export { mergeConfig, removeConfigKeys, writeTextFile, deepMerge, MERGE_NOOP, AppliedButUnjournaledError } from "./engine";
export type { MergeOptions, MergeResult } from "./engine";
export { undo, listUndo, UndoEntry } from "./undo";
export { ConfigFormat } from "./internal";
