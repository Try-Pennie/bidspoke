// The decision checks for docs/design/canvas-save-conflict.html (#2599). Each reads only text,
// roles, data-part attributes, layout boxes and computed colours, never a styling class, so it
// runs the same on the design and on the built canvas.
(function () {
  var NAMED = ["refused", "save-over", "load-theirs"];
  var ALL = NAMED.concat(["refused-outside"]);
  var WHITE = "rgb(255, 255, 255)";
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  // Any computed colour (rgb(), or the oklch() Tailwind v4 computes) as [r, g, b, a 0 to 1], read
  // back from one canvas pixel, so a check never depends on the colour space a stylesheet names.
  var probe = null;
  function rgb(s) {
    if (!s) return null;
    if (!probe) { var c = document.createElement("canvas"); c.width = 1; c.height = 1; probe = c.getContext("2d", { willReadFrequently: true }); }
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "rgba(0, 0, 0, 0)";
    probe.fillStyle = s;
    probe.fillRect(0, 0, 1, 1);
    var d = probe.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  // Red text: a red channel well above green and blue. Light red background: near white, red highest.
  function redText(c) { var v = rgb(c); return !!v && v[0] > 150 && v[1] < 90 && v[2] < 90; }
  function lightRed(c) { var v = rgb(c); return !!v && v[0] >= 250 && v[1] < v[0] && v[1] > 200 && v[2] > 200; }
  function strongRed(c) { var v = rgb(c); return !!v && v[0] > 150 && v[1] < 90 && v[2] < 90 && (v.length < 4 || v[3] > 0); }
  function strip(doc) { return doc.querySelector('[data-part="save-conflict"]'); }
  function sentenceOf(f, named) {
    return named
      ? "Not saved. " + f.savedBy + " saved this workflow at " + f.savedAt + ", after you opened it. Your changes are still on the canvas."
      : "Not saved. This workflow was changed at " + f.savedAt + ", outside the canvas, after you opened it. Your changes are still on the canvas.";
  }
  function stripButtons(s) { return qa(s, "button"); }
  function sentenceText(s) {
    var copy = s.cloneNode(true);
    qa(copy, "button").forEach(function (b) { b.remove(); });
    return txt(copy);
  }
  function dialogCheck(doc, title, description, action) {
    var d = doc.querySelector('[role="alertdialog"]');
    if (!d) return bad("no alertdialog is open");
    var heading = d.querySelector("h2, [id$='-title'], .dialog-title");
    var h = qa(d, "h2")[0] || heading;
    if (txt(h) !== title) return bad("the title reads " + JSON.stringify(txt(h)));
    var p = qa(d, "p")[0];
    if (txt(p) !== description) return bad("the description reads " + JSON.stringify(txt(p)));
    var buttons = qa(d, "button").filter(function (b) { return txt(b); });
    var names = buttons.map(txt);
    if (JSON.stringify(names) !== JSON.stringify(["Cancel", action])) return bad("the buttons read " + JSON.stringify(names));
    if (!strongRed(css(buttons[1]).backgroundColor)) return bad(action + " is not on a red background: " + css(buttons[1]).backgroundColor);
    if (strongRed(css(buttons[0]).backgroundColor)) return bad("Cancel is red");
    return ok(title + " / " + description + " / Cancel, " + action + " in red");
  }
  window.DESIGN_CHECKS = [
    { id: "D1", frames: ALL, check: function (doc, ctx) {
      var s = strip(doc);
      if (!s) return bad("no save conflict strip");
      var want = sentenceOf(ctx.fixture, ctx.frame !== "refused-outside");
      var got = sentenceText(s);
      if (got !== want) return bad("the strip reads " + JSON.stringify(got));
      if (!redText(css(s).color)) return bad("the strip's text is not red: " + css(s).color);
      if (!lightRed(css(s).backgroundColor)) return bad("the strip is not on light red: " + css(s).backgroundColor);
      return ok(want);
    } },
    { id: "D2", frames: ALL, check: function (doc) {
      var s = strip(doc);
      if (!s) return bad("no save conflict strip");
      var b = stripButtons(s), names = b.map(txt);
      if (JSON.stringify(names) !== JSON.stringify(["Load their version", "Save mine over theirs"])) return bad("the strip's buttons read " + JSON.stringify(names));
      var span = qa(s, "span").filter(function (e) { return txt(e).indexOf("Not saved.") === 0; })[0];
      var sentenceRight = span ? span.getBoundingClientRect().right : 0;
      for (var i = 0; i < b.length; i++) {
        var st = css(b[i]);
        if (b[i].getBoundingClientRect().left < sentenceRight) return bad(names[i] + " is not to the right of the sentence");
        if (st.backgroundColor !== WHITE) return bad(names[i] + " is not on white: " + st.backgroundColor);
        if (parseFloat(st.borderTopWidth) < 1) return bad(names[i] + " has no border");
      }
      return ok("Load their version, Save mine over theirs, right of the sentence, white with a border");
    } },
    { id: "D3", frames: ["save-over"], check: function (doc, ctx) {
      var f = ctx.fixture;
      return dialogCheck(doc, "Save over " + f.savedBy + "'s version?", "Their save at " + f.savedAt + " is replaced by your changes. It stays in Version history.", "Save over theirs");
    } },
    { id: "D4", frames: ["load-theirs"], check: function (doc, ctx) {
      var f = ctx.fixture;
      return dialogCheck(doc, "Load " + f.savedBy + "'s version?", "Your unsaved changes on the canvas are discarded and cannot be brought back.", "Load theirs");
    } }
  ];
})();
