// Shared search timing constants. Previously every page that wired up a
// search-as-you-type field picked its own debounce — GlobalSearch used 180ms,
// admin.users used 300ms, etc. Inconsistency made the app feel snappy in one
// place and laggy in another. Pin all keystroke-driven searches here so we
// can tune the feel in one spot.
export const SEARCH_DEBOUNCE_MS = 250;
