// Round 2 of the App Action step's canvas card (#2339). Round 1 settled the place: the header names
// the service, with the action in a chip on its right. The one variable now is the header's icon and
// colour. Held identical in every option: the card's frame and size, the step's name and namespace,
// the chip, and the service name written in ordinary case rather than capitals so "Google Drive"
// fits beside its chip (in capitals, round 1 cut it to "Google Dri...").

var BOX_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path><path d="m3.3 7 8.7 5 8.7-5"></path><path d="M12 22V12"></path></svg>';
// Google Drive's own mark.
var DRIVE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 87.3 78" class="h-4 w-4 shrink-0" aria-hidden="true"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>';

function el(tag, className, text) {
  var e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function buildScreen(variant) {
  var f = window.DESIGN_FIXTURE;
  var card = el("div", "relative w-52 rounded-lg border bg-white shadow-sm border-gray-200");
  var head = el("div", "flex items-center gap-2 rounded-t-lg border-b px-3 py-2");
  var nameCls = "truncate whitespace-nowrap text-xs font-semibold";
  var chip = el("span", "ml-auto shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-xs", f.action);
  if (variant.look === "tinted") {
    // One App Action colour for every service (Tailwind's fuchsia, a hue no canvas step uses yet).
    head.style.cssText = "background:#fdf4ff;border-color:#fae8ff";
    var n = el("span", nameCls, f.service);
    n.style.color = "#a21caf";
    chip.style.cssText = "background:#fae8ff;color:#a21caf";
    head.innerHTML = DRIVE_ICON;
    head.append(n, chip);
  } else {
    head.classList.add("bg-beige", "border-gray-200");
    head.innerHTML = variant.look === "plain" ? BOX_ICON : DRIVE_ICON;
    head.append(el("span", nameCls + " text-gray-600", f.service));
    chip.classList.add("bg-gray-100", "text-gray-600");
    head.append(chip);
  }
  card.append(head);
  var body = el("div", "px-3 py-2");
  body.append(el("p", "truncate text-sm font-semibold text-graphite", f.label));
  body.append(el("p", "truncate font-mono text-xs text-slate-400", f.namespace));
  card.append(body);
  return card;
}
