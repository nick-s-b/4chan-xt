/*
 * Pure helpers for finding replies to your posts in other threads.
 * No DOM, no network, no imports, so they can be tested on their own.
 */

/** A post number quoted in a comment, with the board it belongs to. */
export interface QuotedPost {
	boardID: string;
	postID: number;
}

/**
 * Visible quote text in 4chan comment HTML. Normal links, cross-board links and dead quotes all show the same text:
 * `&gt;&gt;123` or `&gt;&gt;&gt;/board/123`. Group 1 = board (missing = the scanned board), group 2 = post number.
 */
const quoteText = /&gt;&gt;(?:&gt;\/([a-z0-9]+)\/)?(\d+)/g;

/** Every post number quoted in a comment (`com` from the 4chan JSON API). */
export function findQuotedPosts(
	com: string | undefined | null,
	scannedBoard: string,
): QuotedPost[] {
	const found: QuotedPost[] = [];
	if (!com) return found;
	for (const match of com.matchAll(quoteText)) {
		found.push({ boardID: match[1] || scannedBoard, postID: +match[2] });
	}
	return found;
}

/** Time between scan cycles, shared by all tabs. */
export const CYCLE_INTERVAL = 120 * 1000;
/** Minimum time between the starts of two requests (4chan API rule: at most one request per second). */
export const REQUEST_GAP = 1000;
/** Most boards scanned per cycle. */
export const MAX_BOARDS = 10;
/** Boards you posted on within this time are scanned when the board list setting is empty. */
export const RECENT_POSTS_WINDOW = 7 * 24 * 60 * 60 * 1000;
/** Most thread JSON fetches per board per cycle for threads still in the catalog. */
export const MAX_THREAD_FETCHES = 30;
/** Most thread JSON fetches per board per cycle for archived threads. */
export const MAX_ARCHIVE_FETCHES = 100;
/** If a board's previous cycle is older than this, threads that left the catalog are looked up in the archive. */
export const AWAY_GAP = 300 * 1000;

/** What the scanner remembers about one thread. */
export interface ThreadScanState {
	/** Reply count from the catalog at the last scan. */
	replies: number;
	/** Highest post number already scanned. */
	lastScannedNo: number;
}

/** The fields of a catalog.json thread the scanner reads. */
export interface CatalogThread {
	no: number;
	replies?: number;
	last_replies?: { no: number }[];
}

/**
 * True when the catalog does not hold all replies posted since the last scan, so the thread JSON must be fetched.
 * A thread with no stored state counts as new: `{ replies: 0, lastScannedNo: 0 }`.
 */
export function needsThreadFetch(
	state: ThreadScanState | undefined,
	catalogThread: CatalogThread,
): boolean {
	const replies = state ? state.replies : 0;
	const delta = (catalogThread.replies || 0) - replies;
	return delta > (catalogThread.last_replies?.length || 0);
}

/** `yourPostsForever` data for one site: board → thread → post → time recorded (ms). */
export type ForeverBoards = Record<
	string,
	Record<string, Record<string, unknown>>
>;

/**
 * Boards to scan this cycle.
 * Setting filled in: exactly those board IDs (lowercased, slashes removed, split on spaces), at most MAX_BOARDS.
 * Setting empty: boards with at least one of your posts recorded within RECENT_POSTS_WINDOW, most recent first,
 * at most MAX_BOARDS.
 */
export function pickBoards(
	foreverBoards: ForeverBoards | undefined | null,
	fieldText: string | undefined | null,
	now: number,
): string[] {
	if (fieldText?.trim()) {
		const boards: string[] = [];
		for (const word of fieldText
			.toLowerCase()
			.replace(/\//g, "")
			.split(/\s+/)) {
			if (/^[a-z0-9]+$/.test(word) && !boards.includes(word)) boards.push(word);
		}
		return boards.slice(0, MAX_BOARDS);
	}
	const recent: { boardID: string; latest: number }[] = [];
	for (const boardID in foreverBoards || {}) {
		let latest = 0;
		const threads = foreverBoards?.[boardID];
		for (const threadID in threads) {
			const posts = threads[threadID];
			for (const postID in posts) {
				const time = posts[postID];
				if (typeof time === "number" && time > latest) latest = time;
			}
		}
		if (latest >= now - RECENT_POSTS_WINDOW) recent.push({ boardID, latest });
	}
	recent.sort((a, b) => b.latest - a.latest);
	return recent.slice(0, MAX_BOARDS).map((board) => board.boardID);
}

/** A board's stored scan state is dropped when the board was not scanned for this long (it then does a first run). */
export const STATE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
/** Most entries kept in `youScannerAdded`. */
export const MAX_ADDED_ENTRIES = 1000;

/** Boards whose stored state was last scanned before `now - STATE_MAX_AGE`. */
export function staleBoards(
	states: Record<string, { lastCycle?: number }> | undefined | null,
	now: number,
): string[] {
	const stale: string[] = [];
	for (const boardID in states || {}) {
		if ((states?.[boardID]?.lastCycle || 0) < now - STATE_MAX_AGE)
			stale.push(boardID);
	}
	return stale;
}

/**
 * Keys of `youScannerAdded` ("board/threadNo") to drop so that at most `max` remain.
 * Thread numbers only compare within a board, so each board's entries are ranked newest thread first, and entries are
 * kept by that rank: every board's newest, then every board's second newest, and so on. The oldest threads of the
 * boards with the most entries are dropped first.
 */
export function addedKeysToDrop(
	added: Record<string, unknown> | undefined | null,
	max: number = MAX_ADDED_ENTRIES,
): string[] {
	const keys = Object.keys(added || {});
	if (keys.length <= max) return [];
	const byBoard = new Map<string, { key: string; threadNo: number }[]>();
	for (const key of keys) {
		const slash = key.lastIndexOf("/");
		const boardID = slash >= 0 ? key.slice(0, slash) : "";
		const threadNo = Number(key.slice(slash + 1));
		const list = byBoard.get(boardID) || [];
		list.push({ key, threadNo: Number.isFinite(threadNo) ? threadNo : 0 });
		byBoard.set(boardID, list);
	}
	const ranked: { key: string; rank: number; boardID: string }[] = [];
	for (const [boardID, list] of byBoard) {
		list.sort((a, b) => b.threadNo - a.threadNo);
		list.forEach((entry, rank) => {
			ranked.push({ key: entry.key, rank, boardID });
		});
	}
	ranked.sort(
		(a, b) =>
			a.rank - b.rank ||
			(a.boardID < b.boardID ? -1 : a.boardID > b.boardID ? 1 : 0),
	);
	return ranked.slice(max).map((entry) => entry.key);
}

/** The scanning tab writes `youScannerLastRun` at most this often (heartbeat). */
export const HEARTBEAT_GAP = 10 * 1000;
/** Without Web Locks, a tab waits a random time up to this long before starting a cycle, then checks again. */
export const START_JITTER = 10 * 1000;

/** True when a new cycle may start: the last run is at least CYCLE_INTERVAL old, or in the future (clock changed). */
export function cycleDue(
	lastRun: number | undefined | null,
	now: number,
): boolean {
	const elapsed = now - (lastRun || 0);
	return elapsed >= CYCLE_INTERVAL || elapsed < 0;
}
