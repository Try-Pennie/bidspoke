// The decision checks for docs/design/connections-step-form.html (#2338). Each reads only text,
// data-part and data-* attributes, layout boxes and computed colours, never a styling class, so it
// runs the same on the design and on the built canvas.
(function () {
  var BLUE = "rgb(27, 114, 186)", RED = "rgb(180, 35, 24)", NAVY = "rgb(29, 33, 47)", HINT = "rgb(105, 112, 129)";
  // Round 24: the problem line names where it is fixed, the page's name a link to it.
  var WHERE = " on the ", PAGE = "Connections page";
  var SETTLED = ["step-healthy", "step-problem", "step-failing"];
  // The field's own states, as Dan passed them on 2026-10-21, each frame's kind.
  var STATES = { "none-chosen": "none", "loading": "loading", "failed": "failed", "refused": "refused", "empty": "empty", "gone": "gone" };
  var ALL = SETTLED.concat(Object.keys(STATES));
  var CHOSEN = { "step-healthy": "Pennie Salesforce", "step-problem": "Achieve Salesforce", "step-failing": "Lendco Salesforce" };
  function panel(doc) { return doc.getElementById("step-panel-body") || doc.body; }
  // The app's red for a sentence saying something is wrong, read from the colour FieldError's class draws
  // on this side, beside the status red; a line in grey or any other colour is refused, never passed.
  function failureRed(doc) {
    var p = panel(doc), probe = doc.createElement("span"); probe.className = "field-error"; probe.textContent = "x";
    p.append(probe); var c = css(probe).color; probe.remove();
    return c;
  }
  function reds(doc) { var f = failureRed(doc); return f && f !== css(panel(doc)).color ? [f, RED] : [RED]; }
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function q(root, sel) { return root.querySelector(sel); }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function ownText(e) { return Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); }); }
  function field(doc) { return q(panel(doc), '[data-part="connection-field"]'); }
  function underlined(e) { return css(e).textDecorationLine.indexOf("underline") >= 0; }
  function weight(e) { return parseInt(css(e).fontWeight, 10); }
  function chosen(ctx) {
    var name = CHOSEN[ctx.frame];
    return ctx.fixture.connections.filter(function (c) { return c.name === name; })[0];
  }
  // Each line under the dropdown as read: a link inside a line is part of that line, not a line of its
  // own, and a button (the dropdown, Try again) is not a line.
  function linesOf(f) {
    return qa(f, "*").filter(function (e) { return ownText(e) && !e.closest("button") && !e.closest("a") && e.tagName !== "LABEL" && txt(e) !== "Connection"; }).map(txt);
  }
  function failedLines(doc) { return qa(panel(doc), '[data-part="connection-failed"]'); }
  window.DESIGN_CHECKS = [
    { id: "D8", frames: SETTLED, check: function (doc, ctx) {
      var f = field(doc), c = chosen(ctx);
      if (!f) return bad("no Connection field");
      var dd = q(f, "button, [role='combobox']");
      if (!dd || txt(dd) !== c.name) return bad("the dropdown does not read " + c.name);
      var lines = linesOf(f);
      var want = ["Acts as " + c.actsAs];
      if (c.status !== "ok") want.push(ctx.fixture.statusVocabulary[c.status] + WHERE + PAGE);
      if (JSON.stringify(lines) !== JSON.stringify(want)) return bad("under the dropdown: " + JSON.stringify(lines));
      var prob = q(f, '[data-part="connection-problem"]');
      if (c.status === "ok") return prob || q(f, "a") ? bad("a problem line or link shows on a working connection") : ok(want.join(" / "));
      if (!prob || reds(doc).indexOf(css(prob).color) < 0 || weight(prob) !== 500) return bad("the problem line is not red at weight 500");
      var links = qa(prob, "a");
      if (links.length !== 1 || txt(links[0]) !== PAGE || !links[0].getAttribute("href")) return bad("the problem line has no link reading " + PAGE);
      var a = links[0];
      if (css(a).color !== NAVY || !underlined(a) || weight(a) !== 400) return bad("the " + PAGE + " link is not dark, underlined and normal weight");
      return ok(want.join(" / ") + ", " + PAGE + " a dark underlined link");
    } },
    { id: "D24", frames: ALL, check: function (doc) {
      var off = qa(field(doc), "*").filter(function (e) {
        if (e.closest("button")) return false;
        var s = css(e); return s.backgroundColor === BLUE || (ownText(e) && s.color === BLUE);
      });
      if (off.length) return bad("blue outside a button: " + txt(off[0]));
      var links = qa(field(doc), "a").filter(function (a) { return css(a).color !== NAVY || !underlined(a); });
      return links.length ? bad("a link is not dark and underlined: " + txt(links[0])) : ok("no blue outside buttons, links dark and underlined");
    } },
    // Red is FieldError's (read from its class on this side) or the status red, and only where something
    // is genuinely wrong: the problem line, and a sentence saying the list could not be read or the chosen
    // connection no longer exists. Every such sentence must be drawn in that red, so a grey one is refused.
    { id: "D25", frames: ALL, check: function (doc) {
      var red = reds(doc);
      var wrong = function (e) { return !!e.closest('[data-part="connection-problem"], [data-part="connection-failed"]'); };
      var off = qa(panel(doc), "*").filter(function (e) {
        var s = css(e);
        if (!(red.indexOf(s.backgroundColor) >= 0 || (ownText(e) && red.indexOf(s.color) >= 0))) return false;
        return !wrong(e);
      });
      if (off.length) return bad("red on something not wrong: " + txt(off[0]));
      var grey = failedLines(doc).concat(qa(panel(doc), '[data-part="connection-problem"]')).filter(function (e) { return red.indexOf(css(e).color) < 0; });
      if (grey.length) return bad("a line saying something is wrong is not red: " + txt(grey[0]) + " (" + css(grey[0]).color + ")");
      return ok("red only where something is wrong, " + (failedLines(doc).length + qa(panel(doc), '[data-part="connection-problem"]').length) + " such line(s), each red");
    } },
    // A block's words are its own text and the words of any link inside it, read as one sentence, so a link
    // ending the sentence and the full stop after it are one word, as an eye reads them.
    { id: "D27", frames: ALL, check: function (doc) {
      var f = field(doc), lone = [];
      var inSentence = function (a) { return a.tagName === "A" && ownText(a.parentElement); };
      qa(f, "*").filter(function (b) { return ownText(b) && !inSentence(b); }).forEach(function (b) {
        var nodes = [], full = "";
        var walker = doc.createTreeWalker(b, 4);
        for (var t = walker.nextNode(); t; t = walker.nextNode()) {
          var p = t.parentElement;
          if (p !== b && !(p.tagName === "A" && p.parentElement === b)) continue;
          nodes.push({ node: t, start: full.length }); full += t.nodeValue;
        }
        var ys = [], re = /\S+/g, m;
        while ((m = re.exec(full))) {
          var at = m.index, hit = null;
          for (var i = nodes.length - 1; i >= 0; i--) if (nodes[i].start <= at) { hit = nodes[i]; break; }
          if (!hit) continue;
          var r = doc.createRange(); r.setStart(hit.node, at - hit.start); r.setEnd(hit.node, at - hit.start + 1);
          var rect = r.getClientRects()[0]; if (rect && rect.width) ys.push(Math.round(rect.top));
        }
        var lines = ys.filter(function (y, i) { return ys.indexOf(y) === i; });
        if (lines.length > 1 && ys.filter(function (y) { return y === lines[lines.length - 1]; }).length === 1) lone.push(txt(b));
      });
      return lone.length ? bad("ends on a lone word: " + lone[0]) : ok("no lone last word");
    } },
    { id: "D37", frames: Object.keys(STATES), check: function (doc, ctx) {
      var f = field(doc), w = ctx.fixture.fieldWords, kind = STATES[ctx.frame];
      if (!f) return bad("no Connection field");
      var dd = q(f, "button, [role='combobox']");
      if (!dd) return bad("no dropdown");
      var placeholder = kind === "none" || kind === "empty" || kind === "gone";
      if (placeholder) {
        var shown = qa(dd, "*").filter(ownText)[0];
        if (txt(dd) !== w.placeholder || !shown || css(shown).color !== HINT) return bad("the dropdown does not read " + w.placeholder + " in the hint grey: " + txt(dd));
      } else if (txt(dd) !== "") return bad("the dropdown is not blank: " + txt(dd));
      var want = { none: [], loading: [w.loading + ", " + w.loadingSeconds + " s"], failed: [w.noAnswer], refused: [w.refused], empty: [w.emptyBefore + w.page + w.emptyAfter], gone: [w.gone] }[kind];
      var lines = linesOf(f);
      if (JSON.stringify(lines) !== JSON.stringify(want)) return bad("under the dropdown: " + JSON.stringify(lines));
      if (kind === "loading" && !q(f, '[data-part="spinner"]')) return bad("the loading line has no spinner");
      var red = reds(doc);
      if (kind === "failed" || kind === "refused" || kind === "gone") {
        var line = q(f, '[data-part="connection-failed"]');
        if (!line || red.indexOf(css(line).color) < 0) return bad("the sentence saying what went wrong is not red");
      }
      var buttons = qa(f, "button").filter(function (b) { return b !== dd; }).map(txt);
      var wantButtons = kind === "failed" || kind === "refused" ? ["Try again"] : [];
      if (JSON.stringify(buttons) !== JSON.stringify(wantButtons)) return bad("buttons under the dropdown: " + JSON.stringify(buttons));
      var links = qa(f, "a");
      if (kind === "empty") {
        if (links.length !== 1 || txt(links[0]) !== w.page || css(links[0]).color !== NAVY || !underlined(links[0])) return bad("the empty line has no dark underlined " + w.page + " link");
      } else if (links.length) return bad("a link shows: " + txt(links[0]));
      var name = kind === "gone" ? w.removed : CHOSEN["step-healthy"];
      if (txt(f).indexOf(name) >= 0) return bad("the field names a connection it cannot show: " + name);
      return ok(kind + ": " + (want.join(" / ") || "nothing under the dropdown"));
    } }
  ];
})();
