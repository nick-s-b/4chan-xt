import Callbacks from "../classes/Callbacks";
import DataBoard from "../classes/DataBoard";
import Notice from "../classes/Notice";
import Get from "../General/Get";
import Header from "../General/Header";
import { Conf, d, doc, g } from "../globals/globals";
import Menu from "../Menu/Menu";
import ExpandComment from "../Miscellaneous/ExpandComment";
import ScrollMarkers from "../Miscellaneous/ScrollMarkers";
import $ from "../platform/$";
import $$ from "../platform/$$";
import { dict } from "../platform/helpers";
import PostRedirect from "../Posting/PostRedirect";

/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/main/docs/suggestions.md
 */
var QuoteYou = {
  init() {
    if (!Conf['Remember Your Posts']) { return; }

    this.db = new DataBoard('yourPosts');
    // Permanent copy of your posts, never cleaned. Value = time the post was recorded (ms).
    this.dbForever = new DataBoard('yourPostsForever', QuoteYou.buildIndex, true);
    QuoteYou.buildIndex();
    QuoteYou.backfillForever();
    $.sync('Remember Your Posts', enabled => Conf['Remember Your Posts'] = enabled);
    $.on(d, 'QRPostSuccessful', function(e) {
      const cb = PostRedirect.delay();
      const cbForever = PostRedirect.delay();
      return $.get('Remember Your Posts', Conf['Remember Your Posts'], function(items) {
        if (!items['Remember Your Posts']) { return; }
        const {boardID, threadID, postID} = e.detail;
        QuoteYou.rememberForever({boardID, threadID, postID}, cbForever);
        return QuoteYou.db.set({boardID, threadID, postID, val: true}, cb);
      });
    });

    if (!['index', 'thread', 'archive'].includes(g.VIEW)) { return; }

    if (Conf['Highlight Own Posts']) {
      $.addClass(doc, 'highlight-own');
    }

    if (Conf['Highlight Posts Quoting You']) {
      $.addClass(doc, 'highlight-you');
    }

    if (Conf['Comment Expansion']) {
      ExpandComment.callbacks.push(this.node);
    }

    // \u00A0 is nbsp
    this.mark = $.el('span', {
      textContent: '\u00A0(You)',
      className:   'qmark-you'
    }
    );
    Callbacks.Post.push({
      name: 'Mark Quotes of You',
      cb:   this.node
    });

    QuoteYou.menu.init();
  },

  isYou(post) {
    return !!QuoteYou.db?.get({
      boardID:  post.boardID,
      threadID: post.threadID,
      postID:   post.ID
    });
  },

  // Index of `yourPostsForever` as "siteID/boardID/postID". Post numbers are unique per board,
  // so the thread number is not needed to recognize a post as yours.
  foreverIndex: new Set(),

  buildIndex() {
    const index = new Set();
    const data = QuoteYou.dbForever?.data || {};
    for (const siteID in data) {
      const boards = data[siteID]?.boards;
      if (!boards || typeof boards !== 'object') continue;
      for (const boardID in boards) {
        for (const threadID in boards[boardID]) {
          for (const postID in boards[boardID][threadID]) {
            index.add(`${siteID}/${boardID}/${postID}`);
          }
        }
      }
    }
    QuoteYou.foreverIndex = index;
  },

  isYouPostID(siteID, boardID, postID) {
    return QuoteYou.foreverIndex.has(`${siteID || g.SITE.ID}/${boardID}/${postID}`);
  },

  rememberForever({boardID, threadID, postID}, cb) {
    if (!QuoteYou.dbForever) return cb?.();
    QuoteYou.foreverIndex.add(`${g.SITE.ID}/${boardID}/${postID}`);
    QuoteYou.dbForever.set({boardID, threadID, postID, val: Date.now()}, cb);
  },

  forgetForever({boardID, threadID, postID}) {
    if (!QuoteYou.dbForever) return;
    QuoteYou.foreverIndex.delete(`${g.SITE.ID}/${boardID}/${postID}`);
    QuoteYou.dbForever.delete({boardID, threadID, postID});
  },

  // One time: copy everything already in `yourPosts` into `yourPostsForever`, dated now.
  backfillForever() {
    $.get('yourPostsForeverBackfilled', false, function({yourPostsForeverBackfilled}) {
      if (yourPostsForeverBackfilled) return;
      const now = Date.now();
      QuoteYou.dbForever.save(() => {
        const from = QuoteYou.db.data;
        const to = QuoteYou.dbForever.data;
        for (const siteID in from) {
          const boards = from[siteID]?.boards;
          if (!boards || typeof boards !== 'object') continue;
          to[siteID] ||= {boards: dict()};
          const toBoards = to[siteID].boards;
          for (const boardID in boards) {
            for (const threadID in boards[boardID]) {
              const posts = boards[boardID][threadID];
              if (!posts || typeof posts !== 'object') continue;
              for (const postID in posts) {
                if (!posts[postID]) continue;
                toBoards[boardID] ||= dict();
                toBoards[boardID][threadID] ||= dict();
                toBoards[boardID][threadID][postID] ??= now;
              }
            }
          }
        }
      }, () => {
        QuoteYou.buildIndex();
        $.set('yourPostsForeverBackfilled', true);
      });
      QuoteYou.buildIndex();
    });
  },

  node() {
    if (this.isClone) { return; }

    if (QuoteYou.isYou(this)) {
      $.addClass(this.nodes.root, 'yourPost');
      ScrollMarkers.markScroll();
    }

    // Dead quotes that were not turned into quote links (no thread number known).
    const deadlinks = QuoteYou.foreverIndex.size > 0
      ? $$('.deadlink', this.nodes.comment).filter(link => !this.nodes.quotelinks.includes(link))
      : [];

    // Stop there if there's no quotes in that post.
    if (!this.quotes.length && !deadlinks.length) { return; }

    for (var quotelink of this.nodes.quotelinks) {
      const data = Get.postDataFromLink(quotelink);
      // The board + post number check also covers resurrected dead quotes, which have thread number 0.
      if (QuoteYou.db.get(data) || QuoteYou.isYouPostID(this.siteID, data.boardID, data.postID)) {
        QuoteYou.markQuote(this, quotelink);
      }
    }

    for (const deadlink of deadlinks) {
      const match = deadlink.textContent.match(/^>>(?:>\/([a-z\d]+)\/)?(\d+)/);
      if (match && QuoteYou.isYouPostID(this.siteID, match[1] || this.board.ID, match[2])) {
        QuoteYou.markQuote(this, deadlink);
      }
    }
  },

  markQuote(post, link) {
    if (Conf['Mark Quotes of You']) { $.add(link, QuoteYou.mark.cloneNode(true)); }
    $.addClass(link, 'you');
    $.addClass(post.nodes.root, 'quotesYou');
  },

  menu: {
    init() {
      const label = $.el('label',
        {className: 'toggle-you'}
      ,
        {innerHTML: '<input type="checkbox"> You'});
      const input = $('input', label);
      $.on(input, 'change', QuoteYou.menu.toggle);
      Menu.menu?.addEntry({
        el: label,
        order: 80,
        open(post) {
          QuoteYou.menu.post = (post.origin || post);
          input.checked = QuoteYou.isYou(post);
          return true;
        }
      });
    },

    toggle() {
      const {post} = QuoteYou.menu;
      const data = {boardID: post.board.ID, threadID: post.thread.ID, postID: post.ID, val: true};
      if (this.checked) {
        QuoteYou.db.set(data);
        QuoteYou.rememberForever(data);
        // Marked by hand: quotes of this post may already be behind the reply scanner's position on this board.
        $.event('YourPostMarked', {boardID: data.boardID, threadID: data.threadID, postID: data.postID});
      } else {
        QuoteYou.db.delete(data);
        QuoteYou.forgetForever(data);
      }
      for (var clone of [post].concat(post.clones)) {
        clone.nodes.root.classList.toggle('yourPost', this.checked);
      }
      for (var quotelink of Get.allQuotelinksLinkingTo(post)) {
        if (this.checked) {
          if (Conf['Mark Quotes of You']) { $.add(quotelink, QuoteYou.mark.cloneNode(true)); }
        } else {
          $.rm($('.qmark-you', quotelink));
        }
        quotelink.classList.toggle('you', this.checked);
        if ($.hasClass(quotelink, 'quotelink')) {
          var quoter = Get.postFromNode(quotelink).nodes.root;
          quoter.classList.toggle('quotesYou', !!$('.quotelink.you', quoter));
        }
      }
      ScrollMarkers.markScroll();
    }
  },

  cb: {
    seek(type) {
      let highlighted, post;
      let result;
      const {highlight} = g.SITE.classes;
      if (highlighted = $(`.${highlight}`)) { $.rmClass(highlighted, highlight); }

      if (!QuoteYou.lastRead || !doc.contains(QuoteYou.lastRead) || !$.hasClass(QuoteYou.lastRead, 'quotesYou')) {
        if (!(post = (QuoteYou.lastRead = $('.quotesYou')))) {
          new Notice('warning', 'No posts are currently quoting you, loser.', 20);
          return;
        }
        if (QuoteYou.cb.scroll(post)) { return; }
      } else {
        post = QuoteYou.lastRead;
      }

      const str = `${type}::div[contains(@class,'quotesYou')]`;

      while (post = (result = $.X(str, post)).snapshotItem(type === 'preceding' ? result.snapshotLength - 1 : 0)) {
        if (QuoteYou.cb.scroll(post)) { return; }
      }

      const posts = $$('.quotesYou');
      return QuoteYou.cb.scroll(posts[type === 'following' ? 0 : posts.length - 1]);
    },

    scroll(root) {
      const post = Get.postFromRoot(root);
      if (!post.nodes.post.getBoundingClientRect().height) {
        return false;
      } else {
        QuoteYou.lastRead = root;
        location.href = Get.url('post', post);
        Header.scrollTo(post.nodes.post);
        if (post.isReply) {
          const sel = `${g.SITE.selectors.postContainer}${g.SITE.selectors.highlightable.reply}`;
          let node = post.nodes.root;
          if (!node.matches(sel)) { node = $(sel, node); }
          $.addClass(node, g.SITE.classes.highlight);
        }
        return true;
      }
    }
  }
};
export default QuoteYou;
