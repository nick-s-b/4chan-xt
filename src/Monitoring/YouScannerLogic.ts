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
