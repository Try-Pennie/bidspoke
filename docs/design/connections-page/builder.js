// The Connections page as settled in the #2338 design rounds (rounds 1 to 27, 2026-10-20 and 21), drawn
// into the captured app chrome's #main-content at 1120 wide. Only the settled behaviour is here;
// every rejected option of the rounds is gone. make-settled.py hands buildScreen one variant per
// frame, and the variant names the frame's state:
//
//   {state: "detail", chosen: "<connection name>"}       the list, and that connection's panel
//   {state: "detail", chosen, dialog: "reconnect" | "replace" | "remove"}   a dialog over it
//   {state: "detail", chosen, statuses: "stale"}         login checks not answering (round 22)
//   {state: "google"}                                    Google mailboxes and drives (round 10)
//   {state: "add", service: null | "Salesforce" | "Google", save: "ready" | "saving" | "failed",
//    google: "company" | "own"}                          Add connection in the panel (rounds 11 to 17)
//   {state: "add", service: "Salesforce", save: "ready", org: "new"}   Another org, its address
//                                                        typed into the Org box (round 25)
//   {state: "loadfailed"}                                the list did not load (round 23)
//   extra: true adds the fixture's justSaved connection to the list (rounds 18 and 21).
//
// What a check reads is marked with data-part attributes (and roles for tabs and dialogs), never a
// styling class, so the built page carries the same attributes and the checks run on both sides.
//
// Regenerate the settled file from the repository root with
//   python3 ~/.claude/skills/design-rounds/make-settled.py docs/design/connections-page/settled.json docs/design/connections-page.html
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function part(e, name) { e.setAttribute("data-part", name); return e; }
function FX() { return window.DESIGN_FIXTURE; }
var TICK = String.fromCharCode(0x2713);
var MASK = new Array(13).join(String.fromCharCode(0x2022));
var CHEV = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
var PLUG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-icon="plug"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>';
var GLOGO = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.7-4.1-13.6-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>';

// Round 2: Integrations is renamed Connections, with a plug icon.
function renameNav() {
  var links = Array.prototype.slice.call(document.querySelectorAll("nav a"));
  links.forEach(function (a) {
    if (a.textContent.trim() !== "Integrations") return;
    var icon = a.querySelector("svg"); if (icon) icon.outerHTML = PLUG;
    var walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT), t;
    while ((t = walker.nextNode())) if (t.nodeValue.trim()) { t.nodeValue = "Connections"; break; }
  });
}

function all(variant) {
  var list = FX().connections.slice();
  if (variant.extra) list.push(FX().justSaved);
  return list;
}
function statusLabel(c) { return FX().statusVocabulary[c.status]; }
function statusEl(c) {
  var s = part(el("span", "cx-status" + (c.status === "ok" ? "" : " problem")), "status");
  s.setAttribute("data-status", c.status);
  s.append(el("span", "dot"), document.createTextNode(statusLabel(c)));
  return s;
}

// Round 3: a Needs attention group first, then every other connection grouped by service,
// alphabetical by service and then by name.
function groups(variant) {
  var sorted = all(variant).sort(function (a, b) { return a.service.localeCompare(b.service) || a.name.localeCompare(b.name); });
  var out = [];
  var bad = sorted.filter(function (c) { return c.status !== "ok"; });
  if (bad.length) out.push({ heading: "Needs attention", items: bad, attention: true });
  sorted.filter(function (c) { return c.status === "ok"; }).forEach(function (c) {
    var g = out[out.length - 1];
    if (!g || g.attention || g.heading !== c.service) { g = { heading: c.service, items: [] }; out.push(g); }
    g.items.push(c);
  });
  return out;
}

function header(variant) {
  var h = el("div", "cx-head");
  h.append(part(el("h1", "text-3xl font-bold text-graphite", "Connections"), "page-title"));
  // Round 23: Add connection is hidden until the list loads. Round 11b: otherwise always there.
  if (variant.state !== "loadfailed") {
    var right = el("div", "cx-actions");
    right.append(part(el("button", "cx-btn", "Add connection"), "add-connection"));
    h.append(right);
  }
  return h;
}

function listColumn(variant) {
  var list = part(el("div", "cx-card cx-list"), "connection-list");
  groups(variant).forEach(function (g) {
    var head = part(el("div", "cx-group", g.heading), "group-heading");
    head.setAttribute("role", "heading"); head.setAttribute("aria-level", "3");
    list.append(head);
    // Round 10: the Google section opens with the entry for its mailboxes and drives.
    if (g.heading === "Google") {
      var ga = part(el("div", "cx-item" + (variant.state === "google" ? " sel" : ""), "Mailboxes and drives"), "list-item");
      ga.setAttribute("data-entry", "google-subjects");
      if (variant.state === "google") ga.setAttribute("data-selected", "true");
      list.append(ga);
    }
    g.items.forEach(function (c) {
      var chosen = variant.state === "detail" && c.name === variant.chosen;
      var it = part(el("div", "cx-item" + (chosen ? " sel" : "")), "list-item");
      it.setAttribute("data-name", c.name);
      if (chosen) it.setAttribute("data-selected", "true");
      if (g.attention) {
        var nm = el("span");
        nm.append(el("div", null, c.name), part(el("div", "cx-hint", c.service + ", " + statusLabel(c).toLowerCase()), "item-problem"));
        it.append(nm);
      } else it.append(el("span", null, c.name));
      list.append(it);
    });
  });
  return list;
}

function workflowLink(name) { var a = part(el("a", "cx-wf", name), "workflow-link"); a.href = "#"; return a; }

function detailPanel(c) {
  var d = part(el("div", "cx-card cx-detail"), "detail");
  var problem = c.status !== "ok";
  var n = c.workflows.length;
  d.append(el("h2", null, c.name), statusEl(c));
  // Round 5: three tabs.
  var tabs = el("div", "cx-dtabs"); tabs.setAttribute("role", "tablist");
  ["Connection", "Used by (" + n + ")", "History"].forEach(function (t, k) {
    var tab = el("div", "cx-dtab" + (k === 0 ? " on" : ""), t);
    tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", k === 0 ? "true" : "false");
    tabs.append(tab);
  });
  d.append(tabs);
  // Round 7: a problem is a shaded notice at the top of the Connection tab, with Reconnect in it.
  if (problem) {
    var note = part(el("div", "cx-notice"), "problem-notice");
    note.append(el("p", null, "Since " + c.since + ", " + c.cause), el("p", null, c.effect), el("p", "cx-hint", c.fix));
    note.append(el("button", "cx-btn cx-btn-sm", "Reconnect"));
    d.append(note);
  }
  var rows = el("div", "cx-rows");
  [["Service", c.service], ["Acts as", c.actsAs], ["Org", c.instance], ["Last checked", c.checked]].forEach(function (r) {
    var row = part(el("div", "cx-row"), "fact"); row.setAttribute("data-fact", r[0]);
    row.append(el("div", null, r[0]), el("div", null, r[1])); rows.append(row);
  });
  d.append(rows);
  // Rounds 6 and 9c: Reconnect and Replace quiet under the facts (Reconnect is in the notice when
  // there is a problem), Remove set apart in its own row at the bottom.
  var acts = part(el("div", "cx-actions"), "actions");
  if (!problem) acts.append(el("button", "cx-btn-quiet", "Reconnect"));
  acts.append(el("button", "cx-btn-quiet", "Replace"));
  d.append(acts);
  var row = part(el("div", "cx-danger"), "remove-row");
  var what = el("div", "what");
  var rb = el("button", "cx-btn-danger", "Remove");
  // Rounds 9 to 9d: while a workflow uses it, Remove is greyed out, the row says why, and the
  // workflows are listed under it with no button.
  if (n > 0) { what.textContent = "Cannot be removed while a workflow uses it."; rb.disabled = true; }
  row.append(what, rb);
  d.append(row);
  if (n > 0) {
    var used = part(el("div", "cx-inline"), "used-by");
    used.append(el("div", null, "Used by:"));
    c.workflows.forEach(function (w) { used.append(workflowLink(w)); });
    d.append(used);
  }
  return d;
}

// Round 10: the company list of mailboxes and shared drives Google connections may act as.
function googlePanel() {
  var d = part(el("div", "cx-card cx-detail"), "google-subjects");
  d.append(el("h2", null, "Google mailboxes and drives"));
  var p = el("p", "ga-intro");
  var term = part(el("span", "ga-term", "domain wide delegation"), "term");
  var explain = "A Google Workspace grant that lets one service account act as anyone in the company.";
  term.title = explain; term.tabIndex = 0; term.setAttribute("aria-description", explain);
  p.append(document.createTextNode("Google connections act as a mailbox or shared drive through "), term, document.createTextNode(". They may act only as the ones listed here."));
  d.append(p);
  FX().delegation.forEach(function (r) {
    var row = part(el("div", "ga-row"), "subject-row");
    row.append(el("div", null, r.who), el("div", "cx-hint", r.kind), el("div", "cx-hint", "Added by " + r.added), el("button", "ga-link", "Remove"));
    d.append(row);
  });
  var add = part(el("div", "ga-add"), "subject-add");
  var inp = el("input", "input"); inp.placeholder = "Mailbox address or shared drive name"; inp.setAttribute("aria-label", "Mailbox address or shared drive name");
  add.append(inp, el("button", "cx-btn cx-btn-sm", "Add"));
  d.append(add);
  return d;
}

function field(label, control, hint) {
  var w = part(el("div", "ad-field"), "field"); w.setAttribute("data-field", label);
  w.append(el("span", "ad-label", label), control); if (hint) w.append(hint);
  return w;
}
function input(value, secret) { var i = el("input", "input"); i.value = value; if (secret) i.type = "password"; return i; }
function pick(text) {
  var b = el("button", "ad-pick"); b.type = "button"; b.setAttribute("aria-haspopup", "listbox");
  var ch = el("span"); ch.innerHTML = CHEV;
  b.append(el("span", null, text), ch);
  return b;
}
function tile(s, chosen) {
  var t = part(el("div", "sv-tile" + (chosen ? " sv-on" : "")), "service-tile");
  t.setAttribute("data-service", s[0]); if (chosen) t.setAttribute("data-chosen", "true");
  t.append(document.createTextNode(s[0]), el("span", "cx-hint", s[1]));
  return t;
}

// Rounds 11 to 17: Add connection opens in the right panel.
function addPanel(variant) {
  var d = part(el("div", "cx-card cx-detail"), "add-form");
  d.append(el("h2", null, "Add a connection"));
  var g = el("div", "ad-form");
  var svc = el("div"); svc.append(el("span", "ad-label", "Service"));
  // Round 12: a grid of tiles in two columns from the service catalogue; once one is chosen, it
  // stands alone above that service's fields.
  var services = FX().services;
  if (!variant.service) {
    var grid = el("div", "sv-grid");
    services.forEach(function (s) { grid.append(tile(s, false)); });
    svc.append(grid);
  } else svc.append(tile(services.filter(function (s) { return s[0] === variant.service; })[0], true));
  g.append(svc);
  var foot = el("div", "ad-foot");
  var line = null;
  if (variant.service === "Salesforce") {
    var draft = FX().draft.salesforce;
    var orgField, name = draft.name;
    if (variant.org === "new") {
      // Round 25: Another org makes Org a box the new org's address is typed into, and its menu
      // offers the typed address as a new org.
      var nw = FX().draft.newOrg;
      name = nw.name;
      var typed = input(nw.address);
      typed.setAttribute("role", "combobox"); typed.setAttribute("aria-expanded", "true"); typed.setAttribute("aria-controls", "org-menu");
      var menu = el("div", "sv-menu"); menu.id = "org-menu"; menu.setAttribute("role", "listbox");
      var opt = el("div", "sv-opt", "Use " + nw.address + " as a new org"); opt.setAttribute("role", "option");
      // Round 27: the only option is the highlighted one, as the box marks it while an address is typed.
      opt.setAttribute("aria-selected", "true");
      menu.append(opt);
      orgField = field("Org", typed, menu);
    } else {
      // Round 15: the org by name from the orgs Bidspoke knows, its address in a grey line under it.
      var org = FX().salesforceOrgs.filter(function (o) { return o[0] === draft.org; })[0];
      orgField = field("Org", pick(org[0]), el("span", "cx-hint ad-pick-hint", org[1]));
    }
    g.append(field("Name", input(name)),
      orgField,
      field("Client id", input(draft.clientId)),
      field("Client secret", input(MASK, true)));
    var save = el("button", "cx-btn cx-btn-sm", "Save");
    // Round 13: Save greys out, and a line under the buttons says what is happening and counts.
    if (variant.save === "saving") {
      save.disabled = true;
      line = part(el("div", "ad-line"), "save-line"); line.setAttribute("data-state", "saving"); line.setAttribute("role", "status");
      var spin = part(el("span", "spin"), "spinner"); spin.setAttribute("aria-hidden", "true");
      line.append(spin, document.createTextNode("Checking the login with Salesforce, " + draft.elapsed));
    }
    // Round 14: the same line turns red, and Save is ready again.
    if (variant.save === "failed") {
      line = part(el("div", "ad-line bad"), "save-line"); line.setAttribute("data-state", "failed"); line.setAttribute("role", "alert");
      line.append(document.createTextNode("Salesforce refused the client secret. Nothing was saved. Check the secret and save again."));
    }
    foot.append(save, el("button", "cx-btn-quiet", "Cancel"));
  } else if (variant.service === "Google") {
    var gd = FX().draft.google;
    var own = variant.google === "own";
    // Round 16: two choice cards; the company card shows a dropdown of the company list.
    var cards = el("div", "gk-cards");
    [["A company mailbox or drive", "From the company list", !own], ["My own Google account", "Signed in as you", own]].forEach(function (k) {
      var card = part(el("div", "gk-card" + (k[2] ? " on" : "")), "choice-card");
      if (k[2]) card.setAttribute("data-chosen", "true");
      card.append(document.createTextNode(k[0]), el("span", "cx-hint", k[1]));
      cards.append(card);
    });
    var acts = el("div"); acts.append(el("span", "ad-label", "Acts as"), cards);
    if (!own) { var p2 = pick(gd.subject); p2.classList.add("gk-pick"); acts.append(p2); }
    g.append(field("Name", input(own ? gd.ownName : gd.companyName)), acts);
    // Round 17: for your own account, Google's own Sign in with Google button replaces Save.
    if (own) {
      var gb = part(el("button", "g-btn"), "google-sign-in"); var gi = el("span"); gi.innerHTML = GLOGO;
      gb.append(gi, document.createTextNode("Sign in with Google"));
      foot.append(gb, el("button", "cx-btn-quiet", "Cancel"));
    } else foot.append(el("button", "cx-btn cx-btn-sm", "Save"), el("button", "cx-btn-quiet", "Cancel"));
  } else foot.append(el("button", "cx-btn-quiet", "Cancel"));
  g.append(foot);
  if (line) g.append(line);
  d.append(g);
  return d;
}

function dialog(title, width) {
  var scrim = el("div", "cx-scrim"); var dg = el("div", "cx-dialog");
  dg.setAttribute("role", "dialog"); dg.setAttribute("aria-modal", "true"); dg.setAttribute("aria-label", title);
  dg.style.width = width + "px"; dg.append(el("h2", null, title));
  scrim.append(dg);
  return { scrim: scrim, box: dg };
}
// Round 19: Reconnect keeps the client id and asks for a new client secret.
function reconnectDialog(c) {
  var dl = dialog("Reconnect " + c.name, 480);
  var g = el("div", "ad-form");
  g.append(field("Client id", input(FX().reconnect.clientId)), field("New client secret", input("", true)));
  var ft = el("div", "ad-foot"); ft.append(el("button", "cx-btn cx-btn-sm", "Save"), el("button", "cx-btn-quiet", "Cancel"));
  g.append(ft); dl.box.append(g);
  return dl.scrim;
}
// Round 20: Replace names the connection to use instead and lists the workflows, each ticked.
function replaceDialog(c) {
  var dl = dialog("Replace " + c.name, 500);
  var g = el("div", "ad-form");
  g.append(field("Replace with", pick(FX().replaceWith)));
  var lst = part(el("div"), "replace-workflows"); lst.append(el("span", "ad-label", "In these workflows"));
  c.workflows.forEach(function (w) {
    var r = el("div", "rp-check"); r.setAttribute("role", "checkbox"); r.setAttribute("aria-checked", "true");
    var box = el("span", "rp-box", TICK); box.setAttribute("aria-hidden", "true");
    r.append(box, document.createTextNode(w)); lst.append(r);
  });
  g.append(lst, el("div", null, "Each ticked workflow gets a new version with " + FX().replaceWith + "."));
  var ft = el("div", "ad-foot"); ft.append(el("button", "cx-btn-dangerfill", "Replace in " + c.workflows.length + " workflows"), el("button", "cx-btn-quiet", "Cancel"));
  g.append(ft); dl.box.append(g);
  return dl.scrim;
}
// Round 21: removing one no workflow uses asks once, with what cannot be undone.
function removeDialog(c) {
  var dl = dialog("Remove " + c.name + "?", 460);
  dl.box.append(el("div", null, "Its login is deleted from Bidspoke and cannot be brought back."));
  var ft = el("div", "foot"); ft.append(el("button", "cx-btn-quiet", "Cancel"), el("button", "cx-btn-dangerfill", "Remove"));
  dl.box.append(ft);
  return dl.scrim;
}

function buildScreen(variant) {
  renameNav();
  var page = el("div", "cx-page");
  page.append(header(variant));
  // Round 23: one card across the page, and nothing else.
  if (variant.state === "loadfailed") {
    var card = part(el("div", "cx-card ld-card"), "load-failed"); card.setAttribute("role", "alert");
    card.append(el("p", null, "The connections could not be loaded: Bidspoke's server did not answer."), el("button", "cx-btn-quiet", "Try again"));
    page.append(card);
    return page;
  }
  // Round 22: the last known statuses stay, under a strip saying when they are from.
  if (variant.statuses === "stale") {
    var st = part(el("div", "un-strip"), "stale-strip"); st.setAttribute("role", "status");
    st.append(el("span", null, "Login checks are not answering. Statuses are as of " + FX().statusesAsOf + "."), el("button", "cx-btn-quiet", "Try again"));
    page.append(st);
  }
  var chosen = all(variant).filter(function (c) { return c.name === variant.chosen; })[0];
  var split = el("div", "cx-split");
  var right;
  if (variant.state === "google") right = googlePanel();
  else if (variant.state === "add") right = addPanel(variant);
  else right = detailPanel(chosen);
  split.append(listColumn(variant), right);
  page.append(split);
  if (variant.dialog === "reconnect") page.append(reconnectDialog(chosen));
  if (variant.dialog === "replace") page.append(replaceDialog(chosen));
  if (variant.dialog === "remove") page.append(removeDialog(chosen));
  return page;
}
