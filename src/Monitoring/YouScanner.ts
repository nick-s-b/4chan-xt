import { Conf, c, d, g } from "../globals/globals";
import $ from "../platform/$";
import { dict, MINUTE } from "../platform/helpers";
import QuoteYou from "../Quotelinks/QuoteYou";
import ThreadWatcher from "./ThreadWatcher";
import {
	AWAY_GAP,
	addedKeysToDrop,
	CYCLE_INTERVAL,
	findQuotedPosts,
	MAX_ADDED_ENTRIES,
	MAX_ARCHIVE_FETCHES,
	MAX_THREAD_FETCHES,
	needsThreadFetch,
	pickBoards,
	REQUEST_GAP,
	staleBoards,
	type ThreadScanState,
} from "./YouScannerLogic";

/*
 * Finds replies to your posts in threads you never opened, and adds those threads to the thread watcher.
 * Every CYCLE_INTERVAL one tab reads the catalog of a few boards and scans the posts that are new since the last
 * cycle. The thread watcher then marks the thread as quoting you through its own status check.
 */

/** Stored per board under `youScannerState`. */
interface BoardScanState {
	/** Time of this board's last cycle (ms). */
	lastCycle: number;
	/** Highest thread number seen in this board's catalog. */
	maxThreadNoSeen: number;
	threads: Record<string, ThreadScanState>;
}

/** The fields of a 4chan API post the scanner reads. */
interface ApiPost {
	no: number;
	com?: string;
	sub?: string;
	filename?: string;
	ext?: string;
	archived?: number;
}

interface ApiCatalogThread extends ApiPost {
	replies?: number;
	last_replies?: ApiPost[];
}

const ENABLED = "Find replies to you in other threads";
const BOARDS = "Reply scan boards";

/** Highest post number in `posts`, or `from` if that is higher. */
const highestNo = (posts: ApiPost[], from: number) => {
	let highest = from;
	for (const post of posts) {
		if (post.no > highest) highest = post.no;
	}
	return highest;
};

const YouScanner = {
	running: false,
	timeout: undefined as ReturnType<typeof setTimeout> | undefined,
	queue: [] as (() => void)[],
	pumping: false,
	lastRequestStart: 0,
	/** Boards whose last pass in this tab left threads unscanned (fetch cap reached or a fetch failed). */
	pending: new Set<string>(),

	init() {
		if (g.SITE.software !== "yotsuba") return;
		if (
			!Conf["Remember Your Posts"] ||
			!Conf["Thread Watcher"] ||
			!Conf[ENABLED]
		)
			return;
		$.sync(ENABLED, (enabled) => {
			Conf[ENABLED] = enabled;
		});
		$.sync(BOARDS, (text) => {
			Conf[BOARDS] = text;
		});
		$.one(d, "4chanXInitFinished", YouScanner.tick);
	},

	isEnabled() {
		return !!(
			Conf["Remember Your Posts"] &&
			Conf[ENABLED] &&
			QuoteYou.dbForever &&
			ThreadWatcher.db
		);
	},

	schedule(delay: number) {
		clearTimeout(YouScanner.timeout);
		YouScanner.timeout = setTimeout(YouScanner.tick, delay);
	},

	/**
	 * Runs a cycle if no tab sent a scanner request in the last CYCLE_INTERVAL. The running tab refreshes
	 * `youScannerLastRun` at every request start, so other tabs wait while it is mid-cycle.
	 */
	tick() {
		if (!YouScanner.isEnabled() || YouScanner.running) {
			YouScanner.schedule(CYCLE_INTERVAL);
			return;
		}
		$.get("youScannerLastRun", 0, ({ youScannerLastRun }) => {
			const now = Date.now();
			const elapsed = now - (youScannerLastRun || 0);
			if (elapsed >= CYCLE_INTERVAL || elapsed < 0) {
				$.set("youScannerLastRun", now);
				YouScanner.schedule(CYCLE_INTERVAL);
				YouScanner.runCycle();
			} else {
				YouScanner.schedule(CYCLE_INTERVAL - elapsed);
			}
		});
	},

	async runCycle() {
		YouScanner.running = true;
		try {
			const forever = QuoteYou.dbForever.data[g.SITE.ID]?.boards;
			const boards = pickBoards(forever, Conf[BOARDS], Date.now());
			for (const boardID of boards) {
				if (!YouScanner.isEnabled()) break;
				await YouScanner.scanBoard(boardID);
			}
			await YouScanner.prune(Date.now());
		} catch (err) {
			c.error(err);
		} finally {
			YouScanner.running = false;
		}
	},

	async scanBoard(boardID: string) {
		const siteID = g.SITE.ID;
		const catalogURL = g.SITE.urls.catalogJSON({ siteID, boardID });
		// Work left over from the previous pass: ask for the full catalog instead of a possible 304.
		if (YouScanner.pending.has(boardID))
			delete $.lastModified.YouScanner?.[catalogURL];
		const catalogReq = await YouScanner.request(catalogURL, true);
		const now = Date.now();
		if (catalogReq?.status === 304) {
			await YouScanner.saveBoard(
				boardID,
				(state) => state && { ...state, lastCycle: now },
			);
			return;
		}
		const pages = catalogReq?.status === 200 ? catalogReq.response : null;
		if (!Array.isArray(pages)) return;

		YouScanner.pending.add(boardID);
		const prev: BoardScanState | undefined = (await YouScanner.loadState())[
			boardID
		];
		const oldThreads = prev?.threads || {};
		const threads: Record<string, ThreadScanState> = dict();
		const inCatalog = new Set<string>();
		let maxThreadNoSeen = prev?.maxThreadNoSeen || 0;
		let fetches = 0;
		let leftover = false;

		for (const page of pages) {
			for (const thread of (page?.threads || []) as ApiCatalogThread[]) {
				const key = `${thread.no}`;
				inCatalog.add(key);
				if (thread.no > maxThreadNoSeen) maxThreadNoSeen = thread.no;
				const old: ThreadScanState | undefined = oldThreads[key];
				const from = old?.lastScannedNo || 0;
				const replies = thread.replies || 0;
				const catalogPosts = [thread, ...(thread.last_replies || [])];

				// The watcher checks watched threads itself; only keep the state current.
				if (ThreadWatcher.isWatchedRaw(boardID, thread.no)) {
					threads[key] = {
						replies,
						lastScannedNo: highestNo(catalogPosts, from),
					};
					continue;
				}

				// The catalog holds every new reply: scan the OP and last replies, no extra request.
				if (!needsThreadFetch(old, thread)) {
					await YouScanner.scanPosts(
						boardID,
						thread.no,
						catalogPosts,
						from,
						thread,
						false,
					);
					threads[key] = {
						replies,
						lastScannedNo: highestNo(catalogPosts, from),
					};
					continue;
				}

				// Over the cap or failed: keep the old state, done next cycle.
				if (fetches >= MAX_THREAD_FETCHES) {
					if (old) threads[key] = old;
					leftover = true;
					continue;
				}
				fetches++;
				const posts = await YouScanner.fetchThreadPosts(boardID, thread.no);
				if (!posts) {
					if (old) threads[key] = old;
					leftover = true;
					continue;
				}
				await YouScanner.scanPosts(
					boardID,
					thread.no,
					posts,
					from,
					posts[0],
					!!posts[0].archived,
				);
				threads[key] = { replies, lastScannedNo: highestNo(posts, from) };
			}
		}

		// Threads that left the catalog while this browser was away (closed or asleep): look in the archive.
		const missing = new Set(
			Object.keys(oldThreads).filter((key) => !inCatalog.has(key)),
		);
		const archiveURL = g.SITE.urls.archiveListJSON?.({ siteID, boardID });
		if (
			prev &&
			missing.size > 0 &&
			now - (prev.lastCycle || 0) > AWAY_GAP &&
			archiveURL
		) {
			const archiveReq = await YouScanner.request(archiveURL, false);
			const archive: number[] =
				archiveReq?.status === 200 && Array.isArray(archiveReq.response)
					? archiveReq.response
					: [];
			let archiveFetches = 0;
			for (const threadNo of archive) {
				const key = `${threadNo}`;
				let from: number;
				if (missing.has(key)) {
					from = oldThreads[key].lastScannedNo || 0;
				} else if (
					threadNo > (prev.maxThreadNoSeen || 0) &&
					!(key in oldThreads) &&
					!inCatalog.has(key)
				) {
					// Created and archived while away: scan it fully.
					from = 0;
				} else {
					continue;
				}
				if (ThreadWatcher.isWatchedRaw(boardID, threadNo)) continue;
				if (archiveFetches >= MAX_ARCHIVE_FETCHES) break;
				archiveFetches++;
				const posts = await YouScanner.fetchThreadPosts(boardID, threadNo);
				if (posts)
					await YouScanner.scanPosts(
						boardID,
						threadNo,
						posts,
						from,
						posts[0],
						true,
					);
			}
		}

		// Threads that left the catalog are not carried over into the new state.
		await YouScanner.saveBoard(boardID, () => ({
			lastCycle: now,
			maxThreadNoSeen,
			threads,
		}));
		if (!leftover) YouScanner.pending.delete(boardID);
	},

	/** Scans posts newer than `from`; if any of them quotes one of your posts, adds the thread to the watcher. */
	async scanPosts(
		boardID: string,
		threadNo: number,
		posts: ApiPost[],
		from: number,
		op: ApiPost,
		archived: boolean,
	) {
		const siteID = g.SITE.ID;
		let quotingNo = 0;
		for (const post of posts) {
			if (!(post.no > from) || post.no <= quotingNo) continue;
			if (QuoteYou.isYouPostID(siteID, boardID, post.no)) continue;
			const quotesYou = findQuotedPosts(post.com, boardID).some((quote) =>
				QuoteYou.isYouPostID(siteID, quote.boardID, quote.postID),
			);
			if (quotesYou) quotingNo = post.no;
		}
		if (quotingNo)
			await YouScanner.addToWatcher(boardID, threadNo, quotingNo, op, archived);
	},

	async addToWatcher(
		boardID: string,
		threadNo: number,
		quotingNo: number,
		op: ApiPost,
		archived: boolean,
	) {
		// Remember the highest quoting post handled per thread, so a thread you removed from the watcher only
		// comes back for a new quote.
		const key = `${boardID}/${threadNo}`;
		const added: Record<string, number> = await YouScanner.getStored(
			"youScannerAdded",
			dict(),
		);
		if (quotingNo <= (added[key] || 0)) return;
		added[key] = quotingNo;
		await YouScanner.setStored("youScannerAdded", added);
		if (ThreadWatcher.isWatchedRaw(boardID, threadNo)) return;
		const data: { excerpt: string; isDead?: boolean } = {
			excerpt: YouScanner.excerpt(boardID, op),
		};
		if (archived) data.isDead = true;
		// Same path as the watch button; it also starts the watcher's status fetch for the thread.
		ThreadWatcher.addRaw(boardID, threadNo, data);
	},

	/** Same text as Get.threadExcerpt, built from API JSON instead of a parsed thread. */
	excerpt(boardID: string, op: ApiPost) {
		const text =
			$.unescape(op.sub)?.trim() ||
			(op.com
				? g.SITE.Build.parseCommentDisplay(op.com).replace(/\n+/g, " // ")
				: "") ||
			(op.ext ? `${$.unescape(op.filename)}${op.ext}` : "") ||
			`No.${op.no}`;
		const excerpt = `/${decodeURIComponent(boardID)}/ - ${text}`;
		return excerpt.length > 73 ? `${excerpt.slice(0, 70)}...` : excerpt;
	},

	async fetchThreadPosts(
		boardID: string,
		threadNo: number,
	): Promise<ApiPost[] | null> {
		const url = g.SITE.urls.threadJSON({
			siteID: g.SITE.ID,
			boardID,
			threadID: threadNo,
		});
		const req = await YouScanner.request(url, false);
		const posts = req?.status === 200 ? req.response?.posts : null;
		return Array.isArray(posts) && posts.length > 0 ? posts : null;
	},

	/**
	 * Queues a GET request. Request starts are at least REQUEST_GAP apart.
	 * `ifModified` sends If-Modified-Since like the thread watcher does. Resolves with the finished request, or null.
	 */
	request(url: string, ifModified: boolean): Promise<XMLHttpRequest | null> {
		return new Promise((resolve) => {
			YouScanner.queue.push(() => {
				const onloadend = function (this: XMLHttpRequest) {
					resolve(this);
				};
				try {
					if (ifModified) {
						$.whenModified(url, "YouScanner", onloadend, { timeout: MINUTE });
					} else {
						$.ajax(url, { onloadend, timeout: MINUTE });
					}
				} catch (err) {
					c.error(err);
					resolve(null);
				}
			});
			if (!YouScanner.pumping) YouScanner.pump();
		});
	},

	pump() {
		const start = YouScanner.queue.shift();
		if (!start) {
			YouScanner.pumping = false;
			return;
		}
		YouScanner.pumping = true;
		const wait = Math.max(
			0,
			YouScanner.lastRequestStart + REQUEST_GAP - Date.now(),
		);
		setTimeout(() => {
			YouScanner.lastRequestStart = Date.now();
			// Heartbeat: other tabs see a recent last run and do not start a cycle of their own.
			$.set("youScannerLastRun", YouScanner.lastRequestStart);
			start();
			YouScanner.pump();
		}, wait);
	},

	/**
	 * Once per cycle, after scanning: drops the state of boards not scanned for STATE_MAX_AGE (they do a first run if
	 * they come back), and keeps at most MAX_ADDED_ENTRIES entries in `youScannerAdded`.
	 */
	async prune(now: number) {
		const states = await YouScanner.loadState();
		const stale = staleBoards(states, now);
		if (stale.length > 0) {
			for (const boardID of stale) delete states[boardID];
			await YouScanner.setStored("youScannerState", states);
		}
		const added: Record<string, number> = await YouScanner.getStored(
			"youScannerAdded",
			dict(),
		);
		const drop = addedKeysToDrop(added, MAX_ADDED_ENTRIES);
		if (drop.length > 0) {
			for (const key of drop) delete added[key];
			await YouScanner.setStored("youScannerAdded", added);
		}
	},

	getStored<T>(key: string, defaultValue: T): Promise<T> {
		return new Promise((resolve) => {
			$.get(key, defaultValue, (items) => resolve(items[key]));
		});
	},

	setStored(key: string, value: unknown): Promise<void> {
		return new Promise((resolve) => {
			$.set(key, value, () => resolve());
		});
	},

	loadState(): Promise<Record<string, BoardScanState>> {
		return YouScanner.getStored("youScannerState", dict());
	},

	/** Re-reads the stored state just before writing, and replaces only this board's entry. */
	async saveBoard(
		boardID: string,
		update: (state: BoardScanState | undefined) => BoardScanState | undefined,
	) {
		const all = await YouScanner.loadState();
		const next = update(all[boardID]);
		if (!next) return;
		all[boardID] = next;
		await YouScanner.setStored("youScannerState", all);
	},
};

export default YouScanner;
