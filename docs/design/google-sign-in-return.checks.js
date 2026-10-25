// The decision checks for docs/design/google-sign-in-return.html (#2338, build PR 13), one per
// decision. Each reads only what the design and the built page share: text, roles, data-part and
// data-* attributes, layout and computed colours, never a styling class. The score runs them on the
// design first (the positive control) and then on the built page.
(function () {
  var NAME = "Dan's drive";
  function main(doc) { return doc.getElementById("main-content") || doc.body; }
  function txt(e) { return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }
  function q(root, sel) { return root.querySelector(sel); }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function p(root, name) { return q(root, '[data-part="' + name + '"]'); }
  function css(e) { return e.ownerDocument.defaultView.getComputedStyle(e); }
  function ok(detail) { return { ok: true, detail: detail || "" }; }
  function bad(detail) { return { ok: false, detail: detail }; }
  function buttons(root) { return qa(root, 'button, [role="button"]'); }
  // The app's red for a failure, read from the colour FieldError draws on this side (its one class).
  function failureRed(doc) {
    var m = main(doc), probe = doc.createElement("span");
    probe.className = "field-error";
    probe.textContent = "x";
    m.append(probe);
    var c = css(probe).color;
    probe.remove();
    return c;
  }

  window.DESIGN_CHECKS = [
    // Round 1: back in the add form he left, everything kept, the line under the buttons.
    { id: "D1", frames: ["add-google-own-finishing", "add-google-own-declined"], check: function (doc, ctx) {
      var form = p(main(doc), "add-form");
      if (!form) return bad("no add form is open");
      var tile = q(form, '[data-part="service-tile"][data-chosen="true"]');
      if (!tile || tile.getAttribute("data-service") !== "Google") return bad("the chosen service is " + (tile ? tile.getAttribute("data-service") : "none"));
      var name = q(form, '[data-field="Name"] input');
      if (!name || name.value !== NAME) return bad("the name reads " + (name ? JSON.stringify(name.value) : "nothing"));
      var cards = qa(form, '[data-part="choice-card"]');
      var own = cards.filter(function (c) { return txt(c).indexOf("My own Google account") === 0; })[0];
      if (!own || own.getAttribute("data-chosen") !== "true") return bad("My own Google account is not chosen");
      if (qa(doc, "a").some(function (a) { return txt(a) === "Back to Connections"; })) return bad("a Back to Connections link is drawn");
      var foot = q(form, ".ad-foot") || buttons(form).filter(function (b) { return txt(b) === "Sign in with Google"; })[0].parentElement;
      var labels = buttons(foot).map(txt);
      if (JSON.stringify(labels) !== JSON.stringify(["Sign in with Google", "Cancel"])) return bad("the button row reads " + JSON.stringify(labels));
      var line = foot.nextElementSibling;
      if (!line || line.getAttribute("data-part") !== "save-line") return bad("the element after the buttons is not the save line");
      var want = ctx.frame === "add-google-own-finishing" ? ctx.fixture.finishing + ", " + ctx.fixture.elapsed + " s" : ctx.fixture.declined;
      if (txt(line) !== want) return bad("the line reads " + JSON.stringify(txt(line)) + ", not " + JSON.stringify(want));
      return ok("back in the add form, everything kept, the line under the buttons");
    } },
    // Round 2: the declined sentence is the product's error red, FieldError.
    { id: "D2", frames: ["add-google-own-declined"], check: function (doc) {
      var line = p(main(doc), "save-line");
      if (!line) return bad("no save line");
      if (line.getAttribute("role") !== "alert") return bad("the line is not announced as an alert");
      var red = failureRed(doc);
      if (css(line).color !== red) return bad("the line is " + css(line).color + ", not the failure red " + red);
      return ok("the failure red, announced");
    } }
  ];
})();
