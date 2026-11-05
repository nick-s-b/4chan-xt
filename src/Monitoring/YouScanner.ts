import Notice from "../classes/Notice";
import { Conf, c, d, g } from "../globals/globals";
import $ from "../platform/$";
import { dict, MINUTE } from "../platform/helpers";
import QuoteYou from "../Quotelinks/QuoteYou";
import ThreadWatcher from "./ThreadWatcher";
import {
	ADD_SLOTS,
	AWAY_GAP,
	addedKeysToDrop,
	CYCLE_CAP,
	CYCLE_INTERVAL,
	cycleDue,
	findQuotedPosts,
	HEARTBEAT_GAP,
	MANUAL_SCAN_GAP,
	MAX_ADDED_ENTRIES,
	MAX_ARCHIVE_FETCHES,
	MAX_THREAD_FETCHES,
	needsArchiveScan,
	needsThreadFetch,
	pickBoards,
	REQUEST_GAP,
	START_JITTER,
	STORAGE_PAUSE,
	STORAGE_TIMEOUT,
	staleBoards,
	type ThreadScanState,
	threadState,
} from "./YouScannerLogic";

/*
 * Finds replies to your posts in threads you never opened, and adds those threads to the thread watcher.
 * Every CYCLE_INTERVAL one tab reads the catalog of a few boards and scans the posts that are new since the last
 * cycle. The thread watcher then marks the thread as quoting you through its own status check.
 */

/** Stored per board under `youScannerState`. */
interface BoardScanState {
	/** Time of this board's last cycle (ms). Used to drop boards not scanned for a week. */
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

/** One running cycle. Work left over from a stopped cycle sees a newer `gen` and stops at its next step. */
interface Cycle {
	gen: number;
	/** No tab scanned for longer than AWAY_GAP before this cycle started (browser closed or asleep). */
	away: boolean;
}

/** A queued job: one request, or adding a thread to the watcher. */
interface Job {
	cycle: Cycle;
	/** Slots of REQUEST_GAP this job takes before the next job may start. */
	slots: number;
	run: () => void;
	cancel: () => void;
}

const ENABLED = "Find replies to you in other threads";
/** Web Locks name. All 4chan board tabs share the boards.4chan.org origin, so one lock covers every tab. */
const LOCK_NAME = "4chanXT-youScanner";
const BOARDS = "Reply scan boards";
const STORAGE_FAILED = "Reply scanner: storage did not answer";
const CYCLE_TOO_LONG = "Reply scanner: cycle stopped at the time cap";
const CYCLE_STOPPED = "Reply scanner: cycle stopped";

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
	queue: [] as Job[],
	pumping: false,
	/** Earliest time the next queued job may start. */
	nextStartAt: 0,
	/** Last time this tab wrote `youScannerLastRun`. */
	lastHeartbeat: 0,
	/** Generation of the running cycle; raised when a cycle ends or is stopped. */
	cycleGen: 0,
	/** After a storage failure this tab does not scan before this time. */
	pausedUntil: 0,
	/** Last time a manual scan (thread watcher refresh) was accepted in this tab. */
	lastManualScan: 0,
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
		// A post marked as yours by hand (post menu "You"): rescan its board from the start.
		$.on(d, "YourPostMarked", (e: CustomEvent) => {
			if (e.detail?.boardID) YouScanner.forgetBoard(e.detail.boardID);
		});
		// Thread watcher refresh (button or keybind): scan now.
		$.on(d, "ThreadWatcherRefresh", YouScanner.scanNow);
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
	 * Checks whether a cycle is due: no tab wrote `youScannerLastRun` in the last CYCLE_INTERVAL. The scanning tab
	 * refreshes that value while it works (see heartbeat), so other tabs wait while it is mid-cycle.
	 */
	tick() {
		// Schedule the next check first, so a storage callback that never comes cannot stop the loop.
		YouScanner.schedule(CYCLE_INTERVAL);
		if (
			!YouScanner.isEnabled() ||
			YouScanner.running ||
			Date.now() < YouScanner.pausedUntil
		)
			return;
		$.get("youScannerLastRun", 0, ({ youScannerLastRun }) => {
			if (YouScanner.running) return;
			const now = Date.now();
			if (cycleDue(youScannerLastRun, now)) {
				YouScanner.startCycle();
			} else {
				YouScanner.schedule(CYCLE_INTERVAL - (now - youScannerLastRun));
			}
		});
	},

	/**
	 * Manual scan, from the thread watcher's refresh: starts a cycle now even if the last one is under CYCLE_INTERVAL
	 * old. At most once per MANUAL_SCAN_GAP per tab; not while this tab scans or is paused. It goes through the same
	 * guard (Web Lock or fallback), queue and rules as a normal cycle.
	 */
	scanNow() {
		const now = Date.now();
		if (
			!YouScanner.isEnabled() ||
			YouScanner.running ||
			now < YouScanner.pausedUntil ||
			now - YouScanner.lastManualScan < MANUAL_SCAN_GAP
		)
			return;
		YouScanner.lastManualScan = now;
		YouScanner.startCycle(true);
	},

	/**
	 * Only one tab may scan at a time. Main guard: a Web Lock shared by all tabs of the origin; a tab that cannot get
	 * it skips this cycle. Fallback when Web Locks are missing or blocked: wait a random 0 to START_JITTER ms, so tabs
	 * that checked at the same moment do not start together, then check again.
	 */
	startCycle(manual = false) {
		YouScanner.running = true;
		let called = false;
		try {
			const locks = navigator.locks;
			if (!locks?.request) throw new Error("Web Locks not available");
			locks
				.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
					called = true;
					if (!lock) {
						// Another tab is scanning.
						YouScanner.running = false;
						return;
					}
					await YouScanner.runIfDue(manual, true);
				})
				.catch((err) => {
					if (called) {
						c.error(err);
					} else {
						YouScanner.startAfterDelay(manual);
					}
				});
		} catch {
			YouScanner.startAfterDelay(manual);
		}
	},

	startAfterDelay(manual: boolean) {
		setTimeout(
			() => YouScanner.runIfDue(manual, false),
			Math.random() * START_JITTER,
		);
	},

	/**
	 * Reads `youScannerLastRun` again (inside the lock, or after the random delay) and runs the cycle if still due.
	 * A manual scan skips the due check. Always returns, so the lock is always released.
	 */
	async runIfDue(manual = false, locked = false) {
		try {
			const lastRun: number = await YouScanner.getStored(
				"youScannerLastRun",
				0,
			);
			const now = Date.now();
			if (!manual && !cycleDue(lastRun, now)) {
				YouScanner.schedule(CYCLE_INTERVAL - (now - lastRun));
				return;
			}
			// Without the lock, a manual scan must not overlap another tab's cycle. A scanning tab writes the last-run
			// time at least every HEARTBEAT_GAP while it sends requests, so a recent value from another tab means it
			// is still scanning.
			if (
				manual &&
				!locked &&
				lastRun !== YouScanner.lastHeartbeat &&
				now - lastRun >= 0 &&
				now - lastRun < HEARTBEAT_GAP + REQUEST_GAP
			)
				return;
			// No tab scanned for longer than AWAY_GAP: the browser was closed or asleep.
			const away = !!lastRun && now - lastRun > AWAY_GAP;
			YouScanner.heartbeat(true);
			await YouScanner.runCycle(away);
		} catch (err) {
			YouScanner.onError(err);
		} finally {
			YouScanner.running = false;
		}
	},

	/** Writes `youScannerLastRun`: always when a cycle starts (`force`), otherwise at most every HEARTBEAT_GAP. */
	heartbeat(force = false) {
		const now = Date.now();
		if (!force && now - YouScanner.lastHeartbeat < HEARTBEAT_GAP) return;
		YouScanner.lastHeartbeat = now;
		$.set("youScannerLastRun", now);
	},

	/** Runs one cycle, stopped after CYCLE_CAP at the latest. */
	async runCycle(away: boolean) {
		YouScanner.running = true;
		const cycle: Cycle = { gen: ++YouScanner.cycleGen, away };
		let capTimer: ReturnType<typeof setTimeout> | undefined;
		const work = YouScanner.cycleWork(cycle);
		// Errors of work that goes on after a stop are not reported again.
		work.catch((err) => err);
		try {
			await Promise.race([
				work,
				new Promise((_resolve, reject) => {
					capTimer = setTimeout(
						() => reject(new Error(CYCLE_TOO_LONG)),
						CYCLE_CAP,
					);
				}),
			]);
		} catch (err) {
			YouScanner.onError(err);
		} finally {
			clearTimeout(capTimer);
			YouScanner.stopCycle();
			YouScanner.running = false;
		}
	},

	async cycleWork(cycle: Cycle) {
		const forever = QuoteYou.dbForever.data[g.SITE.ID]?.boards;
		const boards = pickBoards(forever, Conf[BOARDS], Date.now());
		for (const boardID of boards) {
			if (!YouScanner.isEnabled()) break;
			await YouScanner.scanBoard(boardID, cycle);
			YouScanner.alive(cycle);
		}
		await YouScanner.prune(Date.now(), cycle);
	},

	/** Ends the current cycle: its queued jobs are dropped and its remaining work stops at its next step. */
	stopCycle() {
		YouScanner.cycleGen++;
		for (const job of YouScanner.queue.splice(0)) job.cancel();
	},

	alive(cycle: Cycle) {
		if (cycle.gen !== YouScanner.cycleGen) throw new Error(CYCLE_STOPPED);
	},

	onError(err: unknown) {
		const message = err instanceof Error ? err.message : "";
		if (message === CYCLE_STOPPED) return;
		// Storage does not answer (for example after an extension update): let other tabs take over for a while.
		if (message === STORAGE_FAILED)
			YouScanner.pausedUntil = Date.now() + STORAGE_PAUSE;
		c.error(err);
	},

	async scanBoard(boardID: string, cycle: Cycle) {
		const siteID = g.SITE.ID;
		const catalogURL = g.SITE.urls.catalogJSON({ siteID, boardID });
		const prev: BoardScanState | undefined = (await YouScanner.loadState())[
			boardID
		];
		YouScanner.alive(cycle);
		// Work left over from the previous pass, or no state (first run, or a rescan after a post was marked as yours
		// by hand): ask for the full catalog instead of a possible 304.
		if (YouScanner.pending.has(boardID) || !prev)
			delete $.lastModified.YouScanner?.[catalogURL];
		const catalogReq = await YouScanner.request(catalogURL, true, cycle);
		YouScanner.alive(cycle);
		const now = Date.now();
		if (catalogReq?.status === 304) {
			await YouScanner.saveBoard(
				boardID,
				(state) => state && { ...state, lastCycle: now },
			);
			YouScanner.alive(cycle);
			return;
		}
		const pages = catalogReq?.status === 200 ? catalogReq.response : null;
		if (!Array.isArray(pages)) return;

		YouScanner.pending.add(boardID);
		const oldThreads = prev?.threads || {};
		const threads: Record<string, ThreadScanState> = dict();
		const inCatalog = new Set<string>();
		let maxThreadNoSeen = prev?.maxThreadNoSeen || 0;
		let fetches = 0;
		let leftover = false;

		// Last page first: the threads closest to being archived get the thread fetches first.
		const catalogThreads: ApiCatalogThread[] = [];
		for (const page of pages) catalogThreads.push(...(page?.threads || []));
		catalogThreads.reverse();

		for (const thread of catalogThreads) {
			const key = `${thread.no}`;
			inCatalog.add(key);
			if (thread.no > maxThreadNoSeen) maxThreadNoSeen = thread.no;
			const old: ThreadScanState | undefined = oldThreads[key];
			const from = old?.lastScannedNo || 0;
			const replies = thread.replies || 0;
			const catalogPosts = [thread, ...(thread.last_replies || [])];
			// Not scanned this cycle (over the cap, failed fetch or failed add): keep the old state, or store a new
			// thread as pending, so it is done next cycle or looked up in the archive if it leaves the catalog first.
			const notScanned = () => {
				threads[key] = old
					? threadState(old.replies, old.lastScannedNo, replies, !!old.pending)
					: threadState(0, 0, replies, true);
				leftover = true;
			};

			// The watcher checks watched threads itself; only keep the state current.
			if (ThreadWatcher.isWatchedRaw(boardID, thread.no)) {
				threads[key] = threadState(
					replies,
					highestNo(catalogPosts, from),
					replies,
				);
				continue;
			}

			// The catalog holds every new reply: scan the OP and last replies, no extra request.
			if (!needsThreadFetch(old, thread)) {
				const ok = await YouScanner.scanPosts(
					boardID,
					thread.no,
					catalogPosts,
					from,
					thread,
					false,
					cycle,
				);
				if (ok) {
					threads[key] = threadState(
						replies,
						highestNo(catalogPosts, from),
						replies,
					);
				} else {
					notScanned();
				}
				continue;
			}

			if (fetches >= MAX_THREAD_FETCHES) {
				notScanned();
				continue;
			}
			fetches++;
			const posts = await YouScanner.fetchThreadPosts(
				boardID,
				thread.no,
				cycle,
			);
			if (!posts) {
				notScanned();
				continue;
			}
			const ok = await YouScanner.scanPosts(
				boardID,
				thread.no,
				posts,
				from,
				posts[0],
				!!posts[0].archived,
				cycle,
			);
			if (ok) {
				// The reply count of the thread JSON that was scanned, not the catalog's (the two can differ).
				threads[key] = threadState(
					posts.length - 1,
					highestNo(posts, from),
					replies,
				);
			} else {
				notScanned();
			}
		}

		// Threads that left the catalog and may have unscanned posts: look them up in the archive. That is every one
		// of them if the browser was away, else the ones still pending or with fewer replies scanned than the catalog
		// last showed.
		const wanted = new Map<string, number>();
		for (const key of Object.keys(oldThreads)) {
			if (!inCatalog.has(key) && needsArchiveScan(oldThreads[key], cycle.away))
				wanted.set(key, oldThreads[key].lastScannedNo || 0);
		}
		const archiveURL = g.SITE.urls.archiveListJSON?.({ siteID, boardID });
		if (prev && wanted.size > 0 && archiveURL) {
			const archiveReq = await YouScanner.request(archiveURL, false, cycle);
			YouScanner.alive(cycle);
			const archive: number[] =
				archiveReq?.status === 200 && Array.isArray(archiveReq.response)
					? archiveReq.response
					: [];
			let archiveFetches = 0;
			for (const threadNo of archive) {
				const key = `${threadNo}`;
				let from: number;
				if (wanted.has(key)) {
					from = wanted.get(key) || 0;
				} else if (
					cycle.away &&
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
				const posts = await YouScanner.fetchThreadPosts(
					boardID,
					threadNo,
					cycle,
				);
				if (posts)
					await YouScanner.scanPosts(
						boardID,
						threadNo,
						posts,
						from,
						posts[0],
						true,
						cycle,
					);
			}
		}

		// Threads that left the catalog are not carried over into the new state. If the board's state was deleted
		// while this scan ran (a post was marked as yours by hand), keep it deleted so the next cycle starts over.
		await YouScanner.saveBoard(boardID, (state) =>
			prev && !state ? undefined : { lastCycle: now, maxThreadNoSeen, threads },
		);
		YouScanner.alive(cycle);
		if (!leftover) YouScanner.pending.delete(boardID);
	},

	/**
	 * A post on this board was marked as yours by hand. Quotes of it may already be behind the scan position, so the
	 * board's state is dropped and its next cycle is a first run. `youScannerAdded` is kept, so threads you removed
	 * from the watcher do not come back for old quotes.
	 */
	async forgetBoard(boardID: string) {
		try {
			const states = await YouScanner.loadState();
			if (!(boardID in states)) return;
			delete states[boardID];
			await YouScanner.setStored("youScannerState", states);
		} catch (err) {
			c.error(err);
		}
	},

	/**
	 * Scans posts newer than `from`; if any of them quotes one of your posts, adds the thread to the watcher.
	 * False when the thread should be scanned again (adding it failed).
	 */
	async scanPosts(
		boardID: string,
		threadNo: number,
		posts: ApiPost[],
		from: number,
		op: ApiPost,
		archived: boolean,
		cycle: Cycle,
	): Promise<boolean> {
		const siteID = g.SITE.ID;
		let quotingNo = 0;
		// Your post that the highest quoting post quotes.
		let quotedNo = 0;
		for (const post of posts) {
			if (!(post.no > from) || post.no <= quotingNo) continue;
			if (QuoteYou.isYouPostID(siteID, boardID, post.no)) continue;
			const quote = findQuotedPosts(post.com, boardID).find((q) =>
				QuoteYou.isYouPostID(siteID, q.boardID, q.postID),
			);
			if (quote) {
				quotingNo = post.no;
				quotedNo = quote.postID;
			}
		}
		if (!quotingNo) return true;
		return YouScanner.addToWatcher(
			boardID,
			threadNo,
			quotingNo,
			quotedNo,
			op,
			archived,
			cycle,
		);
	},

	/**
	 * Adds the thread to the watcher, then remembers the quoting post as handled (`youScannerAdded`), so a thread you
	 * removed from the watcher only comes back for a newer quote. False when adding failed.
	 */
	async addToWatcher(
		boardID: string,
		threadNo: number,
		quotingNo: number,
		quotedNo: number,
		op: ApiPost,
		archived: boolean,
		cycle: Cycle,
	): Promise<boolean> {
		const key = `${boardID}/${threadNo}`;
		const handled: Record<string, number> = await YouScanner.getStored(
			"youScannerAdded",
			dict(),
		);
		YouScanner.alive(cycle);
		if (quotingNo <= (handled[key] || 0)) return true;
		let addedNow = false;
		if (!ThreadWatcher.isWatchedRaw(boardID, threadNo)) {
			// youScannerQuote: your quoted post, shown in the watcher entry's tooltip.
			const data: {
				excerpt: string;
				youScannerQuote: number;
				isDead?: boolean;
			} = {
				excerpt: YouScanner.excerpt(boardID, op),
				youScannerQuote: quotedNo,
			};
			if (archived) data.isDead = true;
			let done: boolean | null = null;
			try {
				// Same path as the watch button. It starts the watcher's own threads.json and thread JSON requests,
				// so it takes ADD_SLOTS queue slots.
				done = await YouScanner.enqueue<boolean>(
					cycle,
					ADD_SLOTS,
					(resolve) => {
						if (!ThreadWatcher.isWatchedRaw(boardID, threadNo)) {
							ThreadWatcher.addRaw(boardID, threadNo, data);
							addedNow = true;
						}
						resolve(true);
					},
				);
			} catch (err) {
				if (err instanceof Error && err.message === CYCLE_STOPPED) throw err;
				// Not marked as handled: the thread is tried again next cycle.
				c.error(err);
				return false;
			}
			YouScanner.alive(cycle);
			if (!done) return false;
		}
		const latest: Record<string, number> = await YouScanner.getStored(
			"youScannerAdded",
			dict(),
		);
		YouScanner.alive(cycle);
		if (quotingNo > (latest[key] || 0)) {
			latest[key] = quotingNo;
			await YouScanner.setStored("youScannerAdded", latest);
			YouScanner.alive(cycle);
		}
		if (addedNow) await YouScanner.showIntro(quotedNo, cycle);
		return true;
	},

	/** The first time the scanner adds a thread in this browser, one notice explains why it appeared. */
	async showIntro(quotedNo: number, cycle: Cycle) {
		const shown: boolean = await YouScanner.getStored(
			"youScannerIntroShown",
			false,
		);
		YouScanner.alive(cycle);
		if (shown) return;
		await YouScanner.setStored("youScannerIntroShown", true);
		new Notice(
			"info",
			`Found a reply to your post >>${quotedNo} in a thread you were not watching, and added it to the thread watcher. This is the "Find replies to you in other threads" option (Settings > Main > Monitoring).`,
		);
		YouScanner.alive(cycle);
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
		cycle: Cycle,
	): Promise<ApiPost[] | null> {
		const url = g.SITE.urls.threadJSON({
			siteID: g.SITE.ID,
			boardID,
			threadID: threadNo,
		});
		const req = await YouScanner.request(url, false, cycle);
		YouScanner.alive(cycle);
		const posts = req?.status === 200 ? req.response?.posts : null;
		return Array.isArray(posts) && posts.length > 0 ? posts : null;
	},

	/**
	 * Queues a GET request (one slot). `ifModified` sends If-Modified-Since like the thread watcher does.
	 * Resolves with the finished request, or null.
	 */
	async request(
		url: string,
		ifModified: boolean,
		cycle: Cycle,
	): Promise<XMLHttpRequest | null> {
		try {
			return await YouScanner.enqueue<XMLHttpRequest>(cycle, 1, (resolve) => {
				const onloadend = function (this: XMLHttpRequest) {
					resolve(this);
				};
				if (ifModified) {
					$.whenModified(url, "YouScanner", onloadend, { timeout: MINUTE });
				} else {
					$.ajax(url, { onloadend, timeout: MINUTE });
				}
			});
		} catch (err) {
			if (err instanceof Error && err.message === CYCLE_STOPPED) throw err;
			c.error(err);
			return null;
		}
	},

	/**
	 * Queues a job. Job starts are at least REQUEST_GAP apart, and a job of N slots keeps the next start N gaps
	 * away. Resolves with the job's value, rejects if the job throws, resolves null if the cycle stops first.
	 */
	enqueue<T>(
		cycle: Cycle,
		slots: number,
		run: (resolve: (value: T) => void) => void,
	): Promise<T | null> {
		YouScanner.alive(cycle);
		return new Promise<T | null>((resolve, reject) => {
			YouScanner.queue.push({
				cycle,
				slots,
				run: () => {
					try {
						run(resolve);
					} catch (err) {
						reject(err);
					}
				},
				cancel: () => resolve(null),
			});
			if (!YouScanner.pumping) YouScanner.pump();
		});
	},

	pump() {
		const job = YouScanner.queue.shift();
		if (!job) {
			YouScanner.pumping = false;
			return;
		}
		YouScanner.pumping = true;
		setTimeout(
			() => {
				if (job.cycle.gen !== YouScanner.cycleGen) {
					job.cancel();
				} else {
					YouScanner.nextStartAt = Date.now() + job.slots * REQUEST_GAP;
					// Heartbeat: other tabs see a recent last run and do not start a cycle of their own.
					YouScanner.heartbeat();
					job.run();
				}
				YouScanner.pump();
			},
			Math.max(0, YouScanner.nextStartAt - Date.now()),
		);
	},

	/**
	 * Once per cycle, after scanning: drops the state of boards not scanned for STATE_MAX_AGE (they do a first run if
	 * they come back), and keeps at most MAX_ADDED_ENTRIES entries in `youScannerAdded`.
	 */
	async prune(now: number, cycle: Cycle) {
		const states = await YouScanner.loadState();
		YouScanner.alive(cycle);
		const stale = staleBoards(states, now);
		if (stale.length > 0) {
			for (const boardID of stale) delete states[boardID];
			await YouScanner.setStored("youScannerState", states);
			YouScanner.alive(cycle);
		}
		const added: Record<string, number> = await YouScanner.getStored(
			"youScannerAdded",
			dict(),
		);
		YouScanner.alive(cycle);
		const drop = addedKeysToDrop(added, MAX_ADDED_ENTRIES);
		if (drop.length > 0) {
			for (const key of drop) delete added[key];
			await YouScanner.setStored("youScannerAdded", added);
		}
	},

	/** A storage call that has not called back after STORAGE_TIMEOUT rejects. */
	withTimeout<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(STORAGE_FAILED)),
				STORAGE_TIMEOUT,
			);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	},

	getStored<T>(key: string, defaultValue: T): Promise<T> {
		return YouScanner.withTimeout(
			new Promise<T>((resolve) => {
				$.get(key, defaultValue, (items) => resolve(items[key]));
			}),
		);
	},

	setStored(key: string, value: unknown): Promise<void> {
		return YouScanner.withTimeout(
			new Promise<void>((resolve) => {
				$.set(key, value, () => resolve());
			}),
		);
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
