// The decision checks for docs/design/connections-page.html (#2338), one per decision the map
// verifies by a check. Each reads only what the design and the built page share: text, roles,
// data-part and data-* attributes, layout boxes and computed colours, never a styling class. The
// score runs them on the design first (the positive control) and then on the built page.
(function () {
  var NAVY = "rgb(29, 33, 47)", BLUE = "rgb(27, 114, 186)", RED = "rgb(180, 35, 24)", HINT = "rgb(105, 112, 129)", WHITE = "rgb(255, 255, 255)";
  var ALL = ["healthy", "problem", "google-list", "add-choose", "add-salesforce", "add-saving", "add-failed", "add-salesforce-new-org", "add-google-company", "add-google-own", "saved", "reconnect", "replace", "remove", "stale", "not-loaded", "google-add-drive", "google-removing", "stale-retry-failed", "not-loaded-refused", "alert-login", "add-stalled", "add-failed-no-cap", "reconnect-failed", "remove-refused-in-use"];
  // Round 26: every dialog's title is one size.
  var DIALOG_TITLE = "20px";
  var EXTRA = ["saved", "remove", "remove-refused-in-use"];
  function main(doc) { return doc.getElementById("main-content") || doc.body; }
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  // Text as read, with blocks apart and anything hidden from a screen reader left out.
  function said(e) {
    if (!e) return "";
    var c = e.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('[aria-hidden="true"]'), function (h) { h.remove(); });
    var parts = [];
    (function walk(n) { n.childNodes.forEach(function (k) { if (k.nodeType === 3) parts.push(k.nodeValue); else if (k.nodeType === 1) { parts.push(" "); walk(k); parts.push(" "); } }); })(c);
    return parts.join("").replace(/\s+/g, " ").trim();
  }
  function q(root, sel) { return root.querySelector(sel); }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function p(root, name) { return q(root, '[data-part="' + name + '"]'); }
  function pa(root, name) { return qa(root, '[data-part="' + name + '"]'); }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function box(e) { return e.getBoundingClientRect(); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function buttons(root) { return qa(root, 'button, [role="button"]'); }
  function button(root, label) { return buttons(root).filter(function (b) { return txt(b) === label; })[0]; }
  function disabled(b) { return b.disabled || b.getAttribute("aria-disabled") === "true"; }
  function underlined(e) { return css(e).textDecorationLine.indexOf("underline") >= 0; }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  // A dialog's title as drawn: its heading reading the title, and why not when it is wrong.
  function titleProblem(dg, title) {
    var h = qa(dg, "h1, h2, h3, h4, [role='heading']").filter(function (e) { return txt(e) === title; })[0];
    if (!h) return "the dialog has no heading reading " + title;
    if (css(h).fontSize !== DIALOG_TITLE) return "the dialog's title is " + css(h).fontSize + ", not " + DIALOG_TITLE;
    return null;
  }
  // The app's red for a failure, read from the colour FieldError draws on this side (its one class).
  function failureRed(doc) {
    var m = main(doc), probe = doc.createElement("span"); probe.className = "field-error"; probe.textContent = "x";
    m.append(probe); var c = css(probe).color; probe.remove();
    return c;
  }
  // A dialog, or an alert dialog (one whose answer destroys something, announced by what it says).
  function dialogOf(doc) { return q(doc, '[role="dialog"], [role="alertdialog"]'); }
  function connections(ctx) {
    var list = ctx.fixture.connections.slice();
    if (EXTRA.indexOf(ctx.frame) >= 0) list.push(ctx.fixture.justSaved);
    return list;
  }
  function chosen(doc, ctx) {
    var it = q(main(doc), '[data-part="list-item"][data-selected="true"]');
    var name = it && it.getAttribute("data-name");
    return connections(ctx).filter(function (c) { return c.name === name; })[0];
  }
  // The list as it reads: each heading with the entries under it, in order.
  function groupsOf(list) {
    var out = [];
    qa(list, '[data-part="group-heading"], [data-part="list-item"]').forEach(function (e) {
      if (e.getAttribute("data-part") === "group-heading") out.push({ heading: txt(e), el: e, items: [] });
      else if (out.length) out[out.length - 1].items.push(e);
    });
    return out;
  }
  function itemName(e) { return e.getAttribute("data-name") || txt(e); }
  function expectedGroups(ctx) {
    var sorted = connections(ctx).sort(function (a, b) { return a.service.localeCompare(b.service) || a.name.localeCompare(b.name); });
    var out = [];
    var badOnes = sorted.filter(function (c) { return c.status !== "ok"; });
    if (badOnes.length) out.push({ heading: "Needs attention", items: badOnes.map(function (c) { return c.name; }) });
    sorted.filter(function (c) { return c.status === "ok"; }).forEach(function (c) {
      var g = out[out.length - 1];
      if (!g || g.heading === "Needs attention" || g.heading !== c.service) { g = { heading: c.service, items: [] }; out.push(g); }
      g.items.push(c.name);
    });
    return out;
  }
  // Every text node's words, grouped by the block that lays them out, as lines of word boxes.
  function lineBlocks(root) {
    var doc = root.ownerDocument, blocks = new Map();
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var t;
    while ((t = walker.nextNode())) {
      if (!t.nodeValue.trim()) continue;
      var b = t.parentElement;
      while (b && b !== root && css(b).display === "inline") b = b.parentElement;
      if (!b) continue;
      var re = /\S+/g, m;
      while ((m = re.exec(t.nodeValue))) {
        var r = doc.createRange(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length);
        var rect = r.getClientRects()[0];
        if (!rect || rect.width === 0) continue;
        if (!blocks.has(b)) blocks.set(b, []);
        blocks.get(b).push({ word: m[0], y: rect.top + rect.height / 2, h: rect.height });
      }
    }
    var out = [];
    blocks.forEach(function (words, b) {
      var lines = [];
      words.forEach(function (w) {
        var line = lines.filter(function (l) { return Math.abs(l.y - w.y) < w.h / 2; })[0];
        if (line) line.words.push(w.word); else lines.push({ y: w.y, words: [w.word] });
      });
      lines.sort(function (a, c) { return a.y - c.y; });
      out.push({ el: b, lines: lines });
    });
    return out;
  }

  window.DESIGN_CHECKS = [
    { id: "D1", frames: ["healthy", "problem", "saved", "stale", "stale-retry-failed", "alert-login", "reconnect-failed", "remove-refused-in-use"], check: function (doc) {
      var list = p(main(doc), "connection-list"), panel = p(main(doc), "detail");
      if (!list || !panel) return bad("no connection list or no detail panel");
      var l = box(list), r = box(panel);
      if (!(l.right <= r.left)) return bad("the list is not wholly left of the panel");
      if (!(l.top < r.bottom && r.top < l.bottom)) return bad("the list and the panel are not side by side");
      return ok("list " + Math.round(l.width) + " wide, panel " + Math.round(r.width) + " wide, side by side");
    } },
    { id: "D2", frames: ["healthy", "google-list", "add-choose", "not-loaded"], check: function (doc) {
      var links = qa(doc, "nav a");
      var conn = links.filter(function (a) { return txt(a) === "Connections"; })[0];
      if (!conn) return bad("no nav link reads Connections");
      if (!q(conn, '[data-icon="plug"]')) return bad("the Connections nav link has no plug icon (data-icon=\"plug\")");
      if (links.some(function (a) { return txt(a) === "Integrations"; })) return bad("a nav link still reads Integrations");
      var list = p(main(doc), "connection-list");
      if (!list) return ok("nav renamed; no list on this frame");
      var gs = groupsOf(list);
      function under(h, names) { var g = gs.filter(function (x) { return x.heading === h; })[0]; return g && names.every(function (n) { return g.items.map(itemName).indexOf(n) >= 0; }); }
      if (!under("Slack", ["Bidspoke Alerts"])) return bad("Bidspoke Alerts is not under Slack");
      if (!under("HTTP", ["Lender API", "Regal webhook"])) return bad("Lender API and Regal webhook are not under HTTP");
      return ok("nav reads Connections with a plug; the alert login and HTTP services are listed");
    } },
    { id: "D3", frames: ["healthy", "problem", "google-list", "add-choose", "saved", "stale", "stale-retry-failed", "alert-login", "google-add-drive", "google-removing", "add-stalled", "add-failed-no-cap", "reconnect-failed", "remove-refused-in-use"], check: function (doc, ctx) {
      var list = p(main(doc), "connection-list");
      if (!list) return bad("no connection list");
      var got = groupsOf(list).map(function (g) {
        return { heading: g.heading, items: g.items.filter(function (e) { return !e.getAttribute("data-entry"); }).map(itemName) };
      });
      var want = expectedGroups(ctx);
      if (!same(got, want)) return bad("the list reads " + JSON.stringify(got) + ", expected " + JSON.stringify(want));
      var att = groupsOf(list)[0];
      var vocab = ctx.fixture.statusVocabulary;
      for (var i = 0; i < att.items.length; i++) {
        var c = connections(ctx).filter(function (x) { return x.name === itemName(att.items[i]); })[0];
        var line = txt(p(att.items[i], "item-problem"));
        var expect = c.service + ", " + vocab[c.status].toLowerCase();
        if (line !== expect) return bad(c.name + " reads \"" + line + "\" under its name, expected \"" + expect + "\"");
      }
      return ok(want.length + " groups, Needs attention first with " + att.items.length);
    } },
    { id: "D4", frames: ["healthy"], check: function (doc) {
      var hs = pa(main(doc), "group-heading");
      if (!hs.length) return bad("no group headings");
      for (var i = 0; i < hs.length; i++) {
        var s = css(hs[i]);
        if (s.color !== NAVY) return bad(txt(hs[i]) + " is coloured " + s.color);
        if (s.fontSize !== "14px") return bad(txt(hs[i]) + " is " + s.fontSize);
        if (s.fontWeight !== "600") return bad(txt(hs[i]) + " has weight " + s.fontWeight);
        if (s.textTransform !== "none") return bad(txt(hs[i]) + " is transformed " + s.textTransform);
        if (i > 0) {
          var prev = hs[i].previousElementSibling;
          var line = parseFloat(s.borderTopWidth) >= 1 && s.borderTopStyle !== "none";
          if (!line && !(prev && prev.getAttribute("role") === "separator")) return bad(txt(hs[i]) + " has no line above it");
        }
      }
      return ok(hs.length + " headings, dark 14px semibold, lined");
    } },
    { id: "D5", frames: ["healthy", "problem", "saved"], check: function (doc, ctx) {
      var panel = p(main(doc), "detail"), c = chosen(doc, ctx);
      if (!panel || !c) return bad("no detail panel or no chosen connection");
      var tabs = qa(panel, '[role="tab"]');
      var want = ["Connection", "Used by (" + c.workflows.length + ")", "History"];
      if (!q(panel, '[role="tablist"]')) return bad("no tablist in the panel");
      if (!same(tabs.map(txt), want)) return bad("the tabs read " + JSON.stringify(tabs.map(txt)));
      if (tabs[0].getAttribute("aria-selected") !== "true" || tabs.slice(1).some(function (t) { return t.getAttribute("aria-selected") === "true"; })) return bad("Connection is not the one selected tab");
      return ok(want.join(", "));
    } },
    { id: "D6", frames: ["healthy", "problem", "saved"], check: function (doc) {
      var panel = p(main(doc), "detail");
      var acts = p(panel, "actions"), row = p(panel, "remove-row");
      if (!acts || !row) return bad("no action row or no Remove row");
      var labels = buttons(acts).map(txt);
      var want = p(panel, "problem-notice") ? ["Replace"] : ["Reconnect", "Replace"];
      if (!same(labels, want)) return bad("the action row reads " + JSON.stringify(labels));
      for (var i = 0; i < buttons(acts).length; i++) {
        var s = css(buttons(acts)[i]);
        if ([BLUE, RED].indexOf(s.backgroundColor) >= 0 || [BLUE, RED].indexOf(s.color) >= 0) return bad(labels[i] + " is not quiet");
      }
      var facts = pa(panel, "fact");
      if (!facts.length || box(acts).top < box(facts[facts.length - 1]).bottom) return bad("the action row is not under the facts");
      if (!same(buttons(row).map(txt), ["Remove"])) return bad("the Remove row holds " + JSON.stringify(buttons(row).map(txt)));
      if (box(row).top < box(acts).bottom) return bad("Remove's row is not below the actions");
      return ok(labels.join(" and ") + " quiet; Remove in its own row below");
    } },
    { id: "D7", frames: ["problem"], check: function (doc, ctx) {
      var panel = p(main(doc), "detail"), c = chosen(doc, ctx);
      var note = p(panel, "problem-notice"), tl = q(panel, '[role="tablist"]');
      if (!note) return bad("no problem notice");
      var facts = pa(panel, "fact");
      if (box(note).top < box(tl).bottom || (facts.length && box(note).bottom > box(facts[0]).top)) return bad("the notice is not the first thing under the tabs");
      var lines = qa(note, "*").filter(function (e) { return !e.closest("button") && e.children.length === 0 && txt(e); });
      var texts = lines.map(txt);
      var want = ["Since " + c.since + ", " + c.cause, c.effect, c.fix];
      if (!same(texts.slice(0, 3), want)) return bad("the notice reads " + JSON.stringify(texts));
      if (css(lines[2]).color !== HINT) return bad("the fix line is " + css(lines[2]).color + ", not grey");
      var rc = button(note, "Reconnect");
      if (!rc || css(rc).backgroundColor !== BLUE) return bad("no blue Reconnect in the notice");
      var st = p(panel, "status");
      if (txt(st) !== ctx.fixture.statusVocabulary[c.status] || css(st).color !== RED) return bad("the status reads \"" + txt(st) + "\" in " + css(st).color);
      return ok("notice, then facts; status " + txt(st) + " in red");
    } },
    { id: "D9", frames: ["healthy", "problem"], check: function (doc, ctx) {
      var panel = p(main(doc), "detail"), c = chosen(doc, ctx);
      var row = p(panel, "remove-row"), rb = button(row, "Remove");
      if (!rb || !disabled(rb)) return bad("Remove is not disabled");
      if (css(rb).color === RED) return bad("the disabled Remove is still red");
      if (txt(row).indexOf("Cannot be removed while a workflow uses it.") !== 0) return bad("the Remove row reads \"" + txt(row) + "\"");
      var used = p(panel, "used-by");
      if (!used || box(used).top < box(row).bottom) return bad("no Used by list under the Remove row");
      if (txt(used).indexOf("Used by:") !== 0) return bad("the list does not start Used by:");
      var links = qa(used, "a");
      if (!same(links.map(txt), c.workflows)) return bad("the list names " + JSON.stringify(links.map(txt)));
      if (links.some(function (a) { return css(a).color !== NAVY || !underlined(a); })) return bad("a workflow link is not dark and underlined");
      if (buttons(used).length) return bad("the Used by list holds a button");
      return ok(c.workflows.length + " workflows listed, Remove greyed");
    } },
    { id: "D10", frames: ["google-list", "google-add-drive", "google-removing"], check: function (doc, ctx) {
      var list = p(main(doc), "connection-list");
      var g = groupsOf(list).filter(function (x) { return x.heading === "Google"; })[0];
      if (!g || !g.items.length || g.items[0].getAttribute("data-entry") !== "google-subjects") return bad("Mailboxes and drives is not the first Google entry");
      if (g.items[0].getAttribute("data-selected") !== "true") return bad("Mailboxes and drives is not chosen");
      var panel = p(main(doc), "google-subjects");
      if (!panel) return bad("no mailboxes and drives panel");
      var h = q(panel, "h1, h2, h3, [role='heading']");
      if (txt(h) !== "Google mailboxes and drives") return bad("the panel is headed " + txt(h));
      var term = p(panel, "term");
      if (!term || txt(term) !== "domain wide delegation") return bad("no domain wide delegation term");
      if (term.tabIndex < 0) return bad("the term cannot take focus");
      var said = term.getAttribute("aria-description") || term.getAttribute("title") || "";
      var by = term.getAttribute("aria-describedby"); if (by && doc.getElementById(by)) said = txt(doc.getElementById(by));
      if (!/\.$/.test(said.trim()) || said.split(" ").length < 6) return bad("the term carries no sentence explaining it");
      var rows = pa(panel, "subject-row");
      if (rows.length !== ctx.fixture.delegation.length) return bad(rows.length + " rows for " + ctx.fixture.delegation.length + " entries");
      for (var i = 0; i < rows.length; i++) {
        var r = ctx.fixture.delegation[i], cells = qa(rows[i], ":scope > *").map(txt);
        if (!same(cells, [r.who, r.kind, "Added by " + r.added, "Remove"])) return bad("row " + (i + 1) + " reads " + JSON.stringify(cells));
        var kids = qa(rows[i], ":scope > *");
        // An ellipsis keeps scrollWidth equal to clientWidth and clips the text's own box, so the
        // text is measured unclipped in a copy set in the same font, then the copy is taken away.
        var cut = kids.filter(function (k) {
          var s = doc.createElement("span"); s.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
          s.style.font = css(k).font; s.style.letterSpacing = css(k).letterSpacing; s.textContent = k.textContent;
          doc.body.append(s); var w = s.getBoundingClientRect().width; s.remove();
          return w > box(k).width - parseFloat(css(k).paddingLeft) - parseFloat(css(k).paddingRight) + 0.5;
        });
        if (cut.length) return bad("row " + (i + 1) + " is cut off: " + txt(cut[0]));
        var tops = kids.map(function (k) { return Math.round(box(k).top + box(k).height / 2); });
        if (Math.max.apply(null, tops) - Math.min.apply(null, tops) > 4) return bad("row " + (i + 1) + " is not on one line");
      }
      var add = p(panel, "subject-add");
      if (!add || !q(add, "input") || !button(add, "Add")) return bad("no add box with Add");
      return ok(rows.length + " entries on one line each, with an add box");
    } },
    { id: "D11", frames: ["healthy", "problem", "google-list", "stale", "add-choose", "add-salesforce", "add-google-company", "add-stalled", "add-failed-no-cap"], check: function (doc, ctx) {
      var m = main(doc), b = p(m, "add-connection"), title = p(m, "page-title");
      if (!b || txt(b) !== "Add connection") return bad("no Add connection button");
      if (css(b).backgroundColor !== BLUE) return bad("Add connection is " + css(b).backgroundColor + ", not blue");
      var bb = box(b), tb = box(title);
      if (!(bb.left > tb.right && bb.top < tb.bottom && tb.top < bb.bottom)) return bad("Add connection is not at the top right, level with the title");
      var list = p(m, "connection-list");
      if (list && bb.right < box(list).right) return bad("Add connection is left of the list's right edge");
      if (ctx.frame.indexOf("add-") === 0) {
        var form = p(m, "add-form");
        if (!form || !q(form, "h1, h2, h3") || txt(q(form, "h1, h2, h3")) !== "Add a connection") return bad("the panel does not hold Add a connection");
        if (p(m, "detail")) return bad("the details are still shown beside the form");
        if (list && box(form).left < box(list).right) return bad("the form is not in the right panel");
        if (q(m, '[data-selected="true"]')) return bad("a list item is still chosen");
      }
      return ok("blue Add connection at the top right");
    } },
    { id: "D12", frames: ["add-choose"], check: function (doc, ctx) {
      var tiles = pa(main(doc), "service-tile");
      var names = tiles.map(function (t) { return t.getAttribute("data-service"); });
      var want = ctx.fixture.services.map(function (s) { return s[0]; });
      if (!same(names, want)) return bad("the tiles are " + JSON.stringify(names));
      for (var i = 0; i < tiles.length; i++) if (said(tiles[i]) !== ctx.fixture.services[i][0] + " " + ctx.fixture.services[i][1]) return bad("the " + want[i] + " tile reads " + said(tiles[i]));
      var lefts = {}; tiles.forEach(function (t) { lefts[Math.round(box(t).left)] = 1; });
      if (Object.keys(lefts).length !== 2) return bad("the tiles are in " + Object.keys(lefts).length + " columns");
      return ok(tiles.length + " tiles in two columns");
    } },
    { id: "D13", frames: ["add-saving"], check: function (doc, ctx) {
      var form = p(main(doc), "add-form"), save = button(form, "Save"), line = p(form, "save-line");
      if (!save || !disabled(save)) return bad("Save is not disabled");
      if (!line || line.getAttribute("data-state") !== "saving") return bad("no saving line");
      if (box(line).top < box(save).bottom) return bad("the line is not under the buttons");
      if (!p(line, "spinner")) return bad("the line has no spinner");
      var want = "Checking the login with Salesforce, " + ctx.fixture.draft.salesforce.elapsed;
      if (txt(line) !== want) return bad("the line reads \"" + txt(line) + "\"");
      return ok(want);
    } },
    { id: "D14", frames: ["add-failed"], check: function (doc) {
      var form = p(main(doc), "add-form"), save = button(form, "Save"), line = p(form, "save-line");
      var want = "Salesforce refused the client secret. Nothing was saved. Check the secret and save again.";
      if (!line || line.getAttribute("data-state") !== "failed") return bad("no failed line");
      if (txt(line) !== want) return bad("the line reads \"" + txt(line) + "\"");
      // Red is FieldError's (.impeccable.md), or the problem status's red on a side that has no FieldError.
      if ([failureRed(doc), RED].indexOf(css(line).color) < 0) return bad("the line is " + css(line).color + ", not red");
      if (!save || disabled(save)) return bad("Save is not ready again");
      return ok("red line, Save ready");
    } },
    { id: "D15", frames: ["add-salesforce", "add-saving", "add-failed", "add-salesforce-new-org"], check: function (doc, ctx) {
      var form = p(main(doc), "add-form");
      var fields = pa(form, "field"), names = fields.map(function (f) { return f.getAttribute("data-field"); });
      if (!same(names, ["Name", "Org", "Client id", "Client secret"])) return bad("the fields are " + JSON.stringify(names));
      var org = fields[1], said_ = "";
      if (ctx.frame === "add-salesforce-new-org") {
        // Round 25: Another org makes Org a box the address is typed into, its menu offering it.
        var nw = ctx.fixture.draft.newOrg;
        var nm = q(fields[0], "input");
        if (!nm || nm.value !== nw.name) return bad("Name does not read " + nw.name);
        var typed = q(org, "input");
        if (!typed || typed.value !== nw.address) return bad("Org is not a box reading " + nw.address);
        if (typed.getAttribute("role") !== "combobox" || typed.getAttribute("aria-expanded") !== "true") return bad("the Org box is not a combobox with its menu open");
        if (q(org, "button")) return bad("Org is still a dropdown button");
        // The menu the box controls, wherever it is drawn: it floats over the fields below (round 34),
        // and the app draws it at the end of the page, so it is found by the box's aria-controls.
        var menu = typed.getAttribute("aria-controls") && doc.getElementById(typed.getAttribute("aria-controls"));
        var opts = qa(menu || org, '[role="option"]');
        var want = "Use " + nw.address + " as a new org";
        if (!same(opts.map(txt), [want])) return bad("the Org menu offers " + JSON.stringify(opts.map(txt)));
        var ob = box(opts[0]);
        if (!ob.height || ob.top < box(typed).bottom) return bad("the Org menu is not open under the box");
        said_ = "Org typed as " + nw.address + ", its menu offering " + want;
      } else {
        var orgName = ctx.fixture.draft.salesforce.org;
        var addr = ctx.fixture.salesforceOrgs.filter(function (o) { return o[0] === orgName; })[0][1];
        var dd = q(org, "button, [role='combobox']");
        if (!dd || txt(dd) !== orgName) return bad("Org is not a dropdown reading " + orgName);
        var hint = qa(org, "*").filter(function (e) { return txt(e) === addr && e.children.length === 0; })[0];
        if (!hint || css(hint).color !== HINT || box(hint).top < box(dd).bottom) return bad("the org's address is not a grey line under the dropdown");
        said_ = "Org (" + orgName + ", " + addr + ")";
      }
      var secret = q(fields[3], "input");
      if (!secret || secret.type !== "password") return bad("Client secret is not masked");
      var labels = qa(form, "label, [data-field]").map(function (e) { return e.getAttribute("data-field") || txt(e); });
      if (labels.some(function (l) { return /acts as|run as/i.test(l); })) return bad("the form asks who it acts as");
      return ok("Name, " + said_ + ", Client id, Client secret");
    } },
    { id: "D16", frames: ["add-google-company", "add-google-own"], check: function (doc, ctx) {
      var form = p(main(doc), "add-form");
      var fields = pa(form, "field");
      if (!fields.length || fields[0].getAttribute("data-field") !== "Name") return bad("the first field is not Name");
      var cards = pa(form, "choice-card");
      if (!same(cards.map(said), ["A company mailbox or drive From the company list", "My own Google account Signed in as you"])) return bad("the cards read " + JSON.stringify(cards.map(said)));
      if (box(cards[0]).top < box(fields[0]).bottom) return bad("the cards are not after Name");
      var company = ctx.frame === "add-google-company";
      if (cards[company ? 0 : 1].getAttribute("data-chosen") !== "true" || cards[company ? 1 : 0].getAttribute("data-chosen") === "true") return bad("the wrong card is chosen");
      var dd = qa(form, "[aria-haspopup], [role='combobox']").filter(function (e) { return box(e).top >= box(cards[0]).bottom; });
      if (company && (dd.length !== 1 || txt(dd[0]) !== ctx.fixture.draft.google.subject)) return bad("no company list dropdown reading " + ctx.fixture.draft.google.subject);
      if (!company && dd.length) return bad("a dropdown shows for your own account");
      return ok(company ? "company card chosen, its dropdown shown" : "own account chosen, no dropdown");
    } },
    { id: "D17", frames: ["add-google-own"], check: function (doc) {
      var form = p(main(doc), "add-form"), g = p(form, "google-sign-in");
      if (!g || txt(g) !== "Sign in with Google") return bad("no Sign in with Google button");
      if (css(g).backgroundColor !== WHITE) return bad("the Google button is " + css(g).backgroundColor);
      if (!q(g, "svg, img")) return bad("the Google button has no logo");
      if (button(form, "Save")) return bad("Save is still there");
      // The form's first action: a tile that chooses the service and a card that chooses a way are choices, not actions.
      var first = buttons(form).filter(function (b) { return !b.closest('[data-part="service-tile"]') && b.getAttribute("role") !== "radio"; })[0];
      if (first !== g) return bad("the first button is " + txt(first));
      return ok("Google's button in place of Save");
    } },
    { id: "D18", frames: ["saved"], check: function (doc, ctx) {
      var m = main(doc), it = q(m, '[data-part="list-item"][data-selected="true"]');
      var name = ctx.fixture.justSaved.name;
      if (!it || it.getAttribute("data-name") !== name) return bad("the chosen list item is not " + name);
      var h = q(p(m, "detail"), "h1, h2, h3");
      if (txt(h) !== name) return bad("the panel is headed " + txt(h));
      if (/\bsaved\b/i.test(txt(m))) return bad("the page says Saved");
      return ok(name + " chosen and open, no message");
    } },
    { id: "D19", frames: ["reconnect"], check: function (doc, ctx) {
      var dg = dialogOf(doc), c = chosen(doc, ctx);
      if (!dg) return bad("no dialog");
      var title = "Reconnect " + c.name;
      if (dg.getAttribute("aria-label") !== title && txt(q(dg, "h1, h2, h3")) !== title) return bad("the dialog is not titled " + title);
      var tp = titleProblem(dg, title); if (tp) return bad(tp);
      var f = pa(dg, "field"), names = f.map(function (x) { return x.getAttribute("data-field"); });
      if (!same(names, ["Client id", "New client secret"])) return bad("the fields are " + JSON.stringify(names));
      if (q(f[0], "input").value !== ctx.fixture.reconnect.clientId) return bad("the client id is not kept");
      var s = q(f[1], "input");
      if (s.type !== "password" || s.value !== "") return bad("New client secret is not an empty masked field");
      if (!same(buttons(dg).map(txt), ["Save", "Cancel"])) return bad("the buttons are " + JSON.stringify(buttons(dg).map(txt)));
      return ok(title);
    } },
    { id: "D20", frames: ["replace"], check: function (doc, ctx) {
      var dg = dialogOf(doc), c = chosen(doc, ctx), w = ctx.fixture.replaceWith;
      if (!dg) return bad("no dialog");
      var title = "Replace " + c.name;
      if (dg.getAttribute("aria-label") !== title && txt(q(dg, "h1, h2, h3")) !== title) return bad("the dialog is not titled " + title);
      var tp = titleProblem(dg, title); if (tp) return bad(tp);
      var rf = pa(dg, "field").filter(function (x) { return x.getAttribute("data-field") === "Replace with"; })[0];
      if (!rf || txt(q(rf, "button, [role='combobox']")) !== w) return bad("Replace with does not read " + w);
      if (txt(dg).indexOf("In these workflows") < 0) return bad("no In these workflows");
      var ticks = qa(dg, '[role="checkbox"]');
      if (!same(ticks.map(said), c.workflows) || ticks.some(function (t) { return t.getAttribute("aria-checked") !== "true"; })) return bad("the workflows ticked are " + JSON.stringify(ticks.map(said)));
      if (txt(dg).indexOf("Each ticked workflow gets a new version with " + w + ".") < 0) return bad("the sentence is missing");
      var go = button(dg, "Replace in " + c.workflows.length + " workflows");
      if (!go || css(go).backgroundColor !== RED) return bad("no red Replace in " + c.workflows.length + " workflows");
      if (!button(dg, "Cancel")) return bad("no Cancel");
      return ok(c.workflows.length + " ticked, red Replace");
    } },
    { id: "D21", frames: ["saved", "remove"], check: function (doc, ctx) {
      var row = p(p(main(doc), "detail"), "remove-row"), rb = button(row, "Remove");
      if (!rb || disabled(rb)) return bad("Remove is not ready on an unused connection");
      if (css(rb).color !== RED) return bad("Remove is " + css(rb).color + ", not red");
      if (txt(row) !== "Remove") return bad("the Remove row reads \"" + txt(row) + "\"");
      if (ctx.frame === "remove") {
        var dg = dialogOf(doc), title = "Remove " + ctx.fixture.justSaved.name + "?";
        if (!dg || (dg.getAttribute("aria-label") !== title && txt(q(dg, "h1, h2, h3")) !== title)) return bad("no dialog titled " + title);
        var tp = titleProblem(dg, title); if (tp) return bad(tp);
        if (txt(dg).indexOf("Its login is deleted from Bidspoke and cannot be brought back.") < 0) return bad("the dialog does not say what is lost");
        var go = buttons(dg).filter(function (b) { return txt(b) === "Remove"; })[0];
        if (!button(dg, "Cancel") || !go || css(go).backgroundColor !== RED) return bad("the dialog lacks Cancel and a red Remove");
      }
      return ok("Remove ready" + (ctx.frame === "remove" ? ", dialog asks once" : ""));
    } },
    { id: "D22", frames: ["stale", "stale-retry-failed"], check: function (doc, ctx) {
      var m = main(doc), st = p(m, "stale-strip"), list = p(m, "connection-list");
      var want = "Login checks are not answering. Statuses are as of " + ctx.fixture.statusesAsOf + ".";
      if (!st || txt(st).indexOf(want) !== 0) return bad("no strip reading " + want);
      if (!button(st, "Try again")) return bad("the strip has no Try again");
      if (box(st).bottom > box(list).top) return bad("the strip is not above the list");
      if (groupsOf(list)[0].heading !== "Needs attention") return bad("Needs attention is gone");
      var s = p(p(m, "detail"), "status");
      if (!s || txt(s) !== ctx.fixture.statusVocabulary[chosen(doc, ctx).status]) return bad("the last known status is not shown");
      return ok("strip with Try again; statuses kept");
    } },
    { id: "D23", frames: ["not-loaded"], check: function (doc) {
      var m = main(doc), card = p(m, "load-failed");
      if (!card || txt(card).indexOf("The connections could not be loaded: Bidspoke's server did not answer.") !== 0) return bad("no card saying the connections could not be loaded");
      if (!button(card, "Try again")) return bad("no Try again");
      if (p(m, "connection-list")) return bad("a connection list is shown");
      if (p(m, "add-connection") || button(m, "Add connection")) return bad("Add connection is shown");
      return ok("one card with Try again");
    } },
    { id: "D24", frames: ALL, check: function (doc) {
      var m = main(doc);
      var off = qa(m, "*").filter(function (e) {
        if (e.closest("button")) return false;
        var s = css(e);
        var ownText = Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); });
        return s.backgroundColor === BLUE || (ownText && s.color === BLUE);
      });
      if (off.length) return bad("blue outside a button: " + off.slice(0, 3).map(txt).join(" | "));
      var links = qa(m, "a").filter(function (a) { return css(a).color !== NAVY || !underlined(a); });
      if (links.length) return bad("a link is not dark and underlined: " + txt(links[0]));
      return ok("blue only on buttons");
    } },
    // Red is the app's red for a failure, read from the colour FieldError draws on this side (the
    // one class every failed line is drawn with), beside the problem status's and the destroying
    // button's red. Every element in either red must be one that is wrong or destroys, and every
    // failed line must be drawn in one of them, so a failed line in grey is refused, not passed.
    { id: "D25", frames: ALL, check: function (doc) {
      var m = main(doc);
      var probe = doc.createElement("span"); probe.className = "field-error"; probe.textContent = "x";
      m.append(probe); var fieldRed = css(probe).color; probe.remove();
      if (!fieldRed || fieldRed === css(m).color) return bad("no red could be read from the failure colour on this side");
      var reds = [fieldRed, RED];
      var isRed = function (c) { return reds.indexOf(c) >= 0; };
      var ownText = function (e) { return Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); }); };
      // A failed line: a save that failed, or a Try again that did not work.
      var failed = function (e) { return !!e.closest('[data-part="save-line"][data-state="failed"]') || /^Trying again did not work/.test(txt(e)); };
      var all = qa(m, "*");
      var off = all.filter(function (e) {
        var s = css(e);
        if (!(isRed(s.backgroundColor) || (ownText(e) && isRed(s.color)))) return false;
        var st = e.closest('[data-part="status"]');
        if (st && st.getAttribute("data-status") !== "ok") return false;
        if (failed(e)) return false;
        var b = e.closest("button");
        var destroys = b && (txt(b) === "Remove" || txt(b).indexOf("Replace in ") === 0);
        // The button that destroys: red when ready, and faded red while held inside its dialog (a refused Remove).
        if (destroys && (!disabled(b) || b.closest('[role="dialog"], [role="alertdialog"]'))) return false;
        return true;
      });
      if (off.length) return bad("red on something not wrong: " + off.slice(0, 3).map(txt).join(" | "));
      var grey = all.filter(function (e) { return ownText(e) && failed(e) && !isRed(css(e).color); });
      if (grey.length) return bad("a failed line is not red: " + txt(grey[0]) + " (" + css(grey[0]).color + ")");
      var lines = all.filter(function (e) { return ownText(e) && failed(e); }).length;
      return ok("red only where something is wrong or destroys; " + lines + " failed line(s), each in " + fieldRed + " or " + RED);
    } },
    { id: "D27", frames: ALL, check: function (doc) {
      var lone = lineBlocks(main(doc)).filter(function (b) { return b.lines.length > 1 && b.lines[b.lines.length - 1].words.length === 1; });
      if (lone.length) return bad("ends on a lone word: " + lone.slice(0, 3).map(function (b) { return "\"" + txt(b.el).slice(0, 80) + "\""; }).join(" | "));
      return ok("no line ends on a lone word");
    } },
    // Round 29: Mailbox or Shared drive is chosen first.
    { id: "D30", frames: ["google-list", "google-add-drive", "google-removing"], check: function (doc, ctx) {
      var add = p(p(main(doc), "google-subjects"), "subject-add");
      if (!add) return bad("no add row");
      var group = q(add, '[role="radiogroup"]');
      if (!group) return bad("no choice above the boxes");
      var radios = qa(group, '[role="radio"]');
      if (!same(radios.map(txt), ["Mailbox", "Shared drive"])) return bad("the choice reads " + JSON.stringify(radios.map(txt)));
      var inputs = qa(add, "input");
      if (!inputs.length || box(group).bottom > box(inputs[0]).top) return bad("the choice is not above the boxes");
      if (ctx.frame === "google-list") {
        if (radios[0].getAttribute("aria-checked") !== "true") return bad("Mailbox is not the one chosen");
        if (inputs.length !== 1 || inputs[0].placeholder !== "Mailbox address") return bad("the mailbox row holds " + JSON.stringify(inputs.map(function (i) { return i.placeholder; })));
        var add_ = button(add, "Add"), ib = box(inputs[0]), ab = add_ && box(add_);
        if (!ab || !(ab.top < ib.bottom && ib.top < ab.bottom) || ab.left < ib.right) return bad("Add is not beside the mailbox box");
      }
      return ok("Mailbox or Shared drive first");
    } },
    // Rounds 29 and 30: the whole address is pasted; the ID is never shown back.
    { id: "D31", frames: ["google-add-drive"], check: function (doc) {
      var panel = p(main(doc), "google-subjects"), add = p(panel, "subject-add");
      var addr = qa(add, "input").filter(function (i) { return /address/i.test(i.placeholder); })[0];
      if (!addr) return bad("no address box");
      var m = /^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,128})(?:[/?#]|$)/.exec(addr.value);
      if (!m) return bad("the address box holds " + JSON.stringify(addr.value) + ", not a whole Drive folder address");
      if (txt(panel).indexOf(m[1]) >= 0) return bad("the drive's ID is shown on the panel");
      var other = qa(panel, "input").filter(function (i) { return i !== addr && i.value.indexOf(m[1]) >= 0; });
      if (other.length) return bad("another box shows the ID");
      return ok("the whole address pasted; its ID shown nowhere else");
    } },
    // Round 31: the address on a line of its own, the name and Add under it.
    { id: "D32", frames: ["google-add-drive"], check: function (doc) {
      var add = p(p(main(doc), "google-subjects"), "subject-add");
      var addr = qa(add, "input").filter(function (i) { return i.placeholder === "Shared drive address, from Google Drive"; })[0];
      var name = qa(add, "input").filter(function (i) { return i.placeholder === "Drive name, shown on this list"; })[0];
      var go = button(add, "Add");
      if (!addr || !name || !go) return bad("the drive row lacks its address, its name or Add");
      var a = box(addr), n = box(name), g = box(go);
      var level = function (x, y) { return x.top < y.bottom && y.top < x.bottom; };
      var sharing = qa(add, "input, button").filter(function (e) { return e !== addr && level(box(e), a); });
      if (sharing.length) return bad("something shares the address's line: " + txt(sharing[0]));
      if (n.top < a.bottom) return bad("the name is not under the address");
      if (!level(g, n) || g.left < n.right) return bad("Add is not at the end of the name's line");
      return ok("address alone; name and Add under it");
    } },
    // Round 32: a working line's spinner is as tall as the capitals and level with them.
    { id: "D33", frames: ["google-removing"], check: function (doc) {
      var line = qa(main(doc), '[role="status"]').filter(function (e) { return /Removing /.test(txt(e)); })[0];
      var svg = line && q(line, "svg");
      if (!svg) return bad("no working line with a spinner");
      var fs = parseFloat(css(line).fontSize), s = css(svg);
      var near = function (v, want) { return Math.abs(parseFloat(v) - want) <= 0.25; };
      if (!near(s.width, 0.95 * fs) || !near(s.height, 0.95 * fs)) return bad("the spinner is " + s.width + " by " + s.height + " on a " + fs + "px line, not 0.95em");
      if (s.position !== "relative" || !near(s.top, -0.1 * fs)) return bad("the spinner is not raised 0.1em (" + s.position + ", top " + s.top + ")");
      return ok("spinner 0.95em, raised 0.1em, on a " + fs + "px line");
    } },
    // Round 33: an org with no call limit set is refused in Dan's words.
    { id: "D34", frames: ["add-failed-no-cap"], check: function (doc, ctx) {
      var form = p(main(doc), "add-form"), save = button(form, "Save"), line = p(form, "save-line");
      var org = ctx.fixture.draft.newOrg.address;
      var want = "Bidspoke has no limit set yet on how many Salesforce calls its workflows may make to " + org + ", so it cannot connect to that org. Nothing was saved. Ask Dan to set a limit for this org, then save again.";
      if (!line || line.getAttribute("data-state") !== "failed") return bad("no failed line");
      if (txt(line) !== want) return bad("the line reads \"" + txt(line) + "\"");
      if ([failureRed(doc), RED].indexOf(css(line).color) < 0) return bad("the line is " + css(line).color + ", not red");
      if (!save || disabled(save)) return bad("Save is not ready again");
      return ok("round 33's sentence, in red, Save ready");
    } },
    // Round 34: a dropdown's open menu sits over what is below it, never pushing the page down.
    { id: "D35", frames: ["add-salesforce-new-org"], check: function (doc) {
      var form = p(main(doc), "add-form");
      var org = qa(form, '[data-part="field"]').filter(function (f) { return f.getAttribute("data-field") === "Org"; })[0];
      var below = qa(form, '[data-part="field"]').filter(function (f) { return f.getAttribute("data-field") === "Client id"; })[0];
      var boxEl = org && q(org, '[role="combobox"]');
      var id = boxEl && boxEl.getAttribute("aria-controls");
      var menu = id && doc.getElementById(id);
      if (!menu || !below) return bad("no open Org menu, or no Client id field under it");
      var floats = false;
      for (var e = menu; e && e !== doc.body; e = e.parentElement) { var pos = css(e).position; if (pos === "absolute" || pos === "fixed") { floats = true; break; } }
      if (!floats) return bad("the menu is in the page's flow, so it pushes the page down");
      var mb = box(menu), bb = box(boxEl), cb = box(below);
      if (mb.top < bb.bottom) return bad("the menu does not start under the box");
      if (!(mb.bottom > cb.top && mb.top < cb.bottom)) return bad("the menu does not lie over the field below it");
      return ok("the menu floats over Client id");
    } },
    // Round 35: every dialog's title is 20px, drawn by the app's one title rule.
    { id: "D36", frames: ["reconnect", "replace", "remove", "reconnect-failed", "remove-refused-in-use"], check: function (doc) {
      var dgs = qa(doc, '[role="dialog"], [role="alertdialog"]');
      if (!dgs.length) return bad("no dialog");
      for (var i = 0; i < dgs.length; i++) {
        var named = dgs[i].getAttribute("aria-label") || txt(q(dgs[i], "h1, h2, h3, h4, [role='heading']"));
        var tp = titleProblem(dgs[i], named);
        if (tp) return bad(tp);
      }
      return ok(dgs.length + " dialog title(s) at " + DIALOG_TITLE);
    } },
    // Round 27: an open dropdown's highlighted row is pale grey behind dark text, in every dropdown.
    { id: "D28", frames: ["add-salesforce-new-org"], check: function (doc) {
      var HIGHLIGHT = "rgb(241, 239, 234)", GRAPHITE = "rgb(52, 52, 52)";
      var opt = qa(doc, '[role="listbox"] [role="option"][aria-selected="true"]')[0];
      if (!opt) return bad("the open menu has no highlighted option");
      var s = css(opt);
      if (s.backgroundColor !== HIGHLIGHT) return bad("the highlighted option's background is " + s.backgroundColor + ", not " + HIGHLIGHT);
      var words = [opt].concat(qa(opt, "*")).filter(function (e) {
        return Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); });
      })[0];
      var colour = words ? css(words).color : s.color;
      if (colour !== GRAPHITE) return bad("the highlighted option's text is " + colour + ", not " + GRAPHITE);
      return ok("highlighted option pale grey behind graphite text");
    } }
  ];
})();
