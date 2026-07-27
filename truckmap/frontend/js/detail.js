import {
  pendingEdits, reviews, submitEdit, submitReview, submitSighting, truck,
} from "./api.js";
import { fmtRange } from "./time.js";
import { toast } from "./toast.js";
import { guard } from "./turnstile.js";

const sheet = document.getElementById("sheet");
const body = document.getElementById("sheet-body");
let lastFocus = null;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** "★★★★☆" — text, not images, so it survives any font and reads to a screen reader. */
function stars(rating) {
  const n = Math.round(Number(rating) || 0);
  const s = el("span", "stars");
  s.textContent = "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);
  s.setAttribute("aria-label", `${n} out of 5 stars`);
  return s;
}

// --- sections ----------------------------------------------------------------

function sightingSection(row) {
  const box = el("section", "sheet-sec");
  box.append(el("h3", null, "Is it there right now?"));
  box.append(el("p", "hint",
    "Reports fade fast — a confirmation is worth most in the first hour and is "
    + "close to worthless after three."));

  const captcha = el("div", "captcha");
  const g = guard(captcha); // promise; resolved lazily on first click

  const bar = el("div", "btn-row");
  for (const [kind, label] of [["here", "👋 It's here"], ["not_here", "🚫 Not here"]]) {
    const b = el("button", "btn", label);
    b.type = "button";
    b.addEventListener("click", async () => {
      bar.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        const gate = await g;
        await submitSighting({
          truck_id: row.truck_id,
          appearance_id: row.appearance_id,
          kind,
          lat: row.lat,
          lon: row.lon,
          turnstile_token: await gate.getToken(),
        });
        gate.reset(); // tokens are single-use
        toast("Thanks — that updates the confidence score immediately.");
        document.dispatchEvent(new CustomEvent("truckmap:refresh"));
      } catch (e) {
        (await g).reset();
        console.error(e.detail ?? e);
        toast(e.message, { error: true });
      } finally {
        bar.querySelectorAll("button").forEach((x) => (x.disabled = false));
      }
    });
    bar.append(b);
  }
  box.append(bar, captcha);
  return box;
}

function reviewForm(truckId, onDone) {
  const form = el("form", "form review-form");
  form.append(el("h3", null, "Leave a review"));

  // Star picker: radios, so keyboard and screen readers get it for free.
  //
  // DOM order is 5 -> 1, DELIBERATELY. The CSS flips it back with
  // flex-direction: row-reverse, which is what makes `input:checked ~ label`
  // able to fill every star to the LEFT of the chosen one — CSS has no
  // previous-sibling selector, so the markup has to run backwards.
  //
  // Building this 1 -> 5 and then reversing it inverts the whole scale: the
  // stars still LOOK right, but the leftmost is 5 and clicking the fifth star
  // records 1. Do not "tidy" this loop into ascending order.
  const fs = el("fieldset", "stars-pick");
  fs.append(el("legend", "hint", "Your rating"));

  const readout = el("span", "stars-readout", "");
  for (let i = 5; i >= 1; i--) {
    const id = `star-${i}`;
    const input = el("input");
    input.type = "radio";
    input.name = "rating";
    input.value = String(i);
    input.id = id;
    input.required = true;
    input.addEventListener("change", () => {
      readout.textContent = `${i} star${i > 1 ? "s" : ""}`;
    });
    const label = el("label", null, "★");
    label.htmlFor = id;
    label.title = `${i} star${i > 1 ? "s" : ""}`;
    label.setAttribute("aria-label", `${i} star${i > 1 ? "s" : ""}`);
    fs.append(input, label);
  }
  form.append(fs, readout);

  const text = el("textarea", "input");
  text.name = "body";
  text.rows = 3;
  text.maxLength = 2000;
  text.placeholder = "What did you eat? Was it worth the trip? (optional)";
  form.append(text);

  const name = el("input", "input");
  name.name = "author_name";
  name.maxLength = 40;
  name.placeholder = "Your name (optional)";
  form.append(name);

  const captcha = el("div", "captcha");
  const g = guard(captcha);
  form.append(captcha);

  const submit = el("button", "btn primary", "Post review");
  submit.type = "submit";
  form.append(submit);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    submit.disabled = true;
    try {
      const gate = await g;
      const out = await submitReview({
        truck_id: truckId,
        rating: Number(fd.get("rating")),
        body: fd.get("body") || null,
        author_name: fd.get("author_name") || null,
        turnstile_token: await gate.getToken(),
      });
      gate.reset();
      toast(out.updated ? "Your review was updated." : "Thanks for the review!");
      form.reset();
      onDone();
    } catch (err) {
      (await g).reset();
      console.error(err.detail ?? err);
      toast(err.message, { error: true });
    } finally {
      submit.disabled = false;
    }
  });

  return form;
}

function editForm(truckId, currentDescription) {
  const details = el("details", "sheet-sec");
  details.append(el("summary", null, "Suggest a description edit"));

  const form = el("form", "form");
  form.append(el("p", "hint",
    "Edits are queued for review — they don't appear on the map immediately."));

  const ta = el("textarea", "input");
  ta.name = "value";
  ta.rows = 4;
  ta.maxLength = 2000;
  ta.required = true;
  ta.value = currentDescription ?? "";
  ta.placeholder = "Describe this truck…";
  form.append(ta);

  const note = el("input", "input");
  note.name = "note";
  note.maxLength = 500;
  note.placeholder = "Why the change? (optional)";
  form.append(note);

  const captcha = el("div", "captcha");
  const g = guard(captcha);
  form.append(captcha);

  const submit = el("button", "btn", "Submit suggestion");
  submit.type = "submit";
  form.append(submit);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    submit.disabled = true;
    try {
      const gate = await g;
      await submitEdit({
        truck_id: truckId,
        field: "description",
        value: fd.get("value"),
        note: fd.get("note") || null,
        turnstile_token: await gate.getToken(),
      });
      gate.reset();
      toast("Suggestion queued. Thank you!");
      details.open = false;
    } catch (err) {
      (await g).reset();
      console.error(err.detail ?? err);
      toast(err.message, { error: true });
    } finally {
      submit.disabled = false;
    }
  });

  details.append(form);
  return details;
}

const PAGE_SIZE = 10;   // fetched per page
const VISIBLE = 5;      // shown before the list starts scrolling

/**
 * Cap the list at VISIBLE rows, plus a sliver of the next one.
 *
 * Measured rather than assumed: rows vary in height (a rating with no prose is
 * half the height of a paragraph), so a hardcoded `max-height: 5 * Nrem` would
 * cut the 5th row in half on some trucks and leave a gap on others.
 *
 * The leftover sliver is the affordance — a half-visible row says "more below"
 * far more plainly than a fade alone, and combined with the mask it reads as
 * the list continuing underneath the review form.
 */
function capHeight(ul) {
  ul.classList.remove("peek");
  ul.style.maxHeight = "";
  const items = ul.children;
  if (items.length <= VISIBLE) return;

  const top = ul.getBoundingClientRect().top;
  const cut = items[VISIBLE].getBoundingClientRect().top - top;
  ul.style.maxHeight = `${cut + 18}px`;   // +18px: peek of the next row
  ul.classList.add("peek");

  // Drop the fade once the reader reaches the end — leaving it there implies
  // content that isn't coming.
  const onScroll = () => {
    const atEnd = ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 2;
    ul.classList.toggle("at-end", atEnd);
  };
  ul.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/**
 * Self-contained, self-paging review list. Owns its page state and refetches on
 * navigation, so paging does not rebuild (or re-fetch) the rest of the sheet.
 * `refresh()` is exposed for after a new review is posted.
 */
function reviewSection(truckId) {
  const box = el("section", "sheet-sec");
  const heading = el("h3", null, "Reviews");
  const ul = el("ul", "reviews");
  const pager = el("div", "pager");
  // A permanent slot for failures rather than appending one on each. The old
  // code did `box.append(...)` in the catch, so every retry stacked another
  // error paragraph under the last — three failed pager clicks left three
  // identical messages on screen.
  const errorBox = el("div", "load-error");
  errorBox.hidden = true;
  box.append(heading, ul, pager, errorBox);

  let page = 0;

  async function load() {
    ul.setAttribute("aria-busy", "true");
    errorBox.hidden = true;
    let rows = [];
    let total = 0;
    try {
      ({ rows, total } = await reviews(truckId, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }));
    } catch (e) {
      // aria-busy was previously left set on this path, so a screen reader was
      // told the list was still loading — forever, with no way to learn it had
      // failed. Clear it before anything else.
      ul.removeAttribute("aria-busy");
      ul.replaceChildren();
      pager.replaceChildren();
      heading.textContent = "Reviews";

      console.error("reviews:", e.detail ?? e);
      errorBox.replaceChildren(el("p", "hint", e.message));
      const retry = el("button", "btn", "Try again");
      retry.type = "button";
      retry.addEventListener("click", load);
      errorBox.append(retry);
      errorBox.hidden = false;
      return;
    }
    ul.removeAttribute("aria-busy");

    // A page can empty out underneath us (reviews removed while open) — step
    // back rather than showing a blank list on a page that no longer exists.
    if (!rows.length && page > 0) {
      page = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
      return load();
    }

    heading.textContent = total ? `Reviews (${total})` : "Reviews";
    ul.replaceChildren();
    pager.replaceChildren();

    if (!total) {
      ul.append(Object.assign(el("li", "hint"), { textContent: "No reviews yet — be the first." }));
      return;
    }

    for (const r of rows) {
      const li = el("li");
      const head = el("div", "review-head");
      head.append(stars(r.rating));
      head.append(el("span", "review-who", r.author_name || "Anonymous"));
      li.append(head);
      if (r.body) li.append(el("p", "review-body", r.body));
      ul.append(li);
    }

    // After layout — the rows must have real heights to measure.
    requestAnimationFrame(() => capHeight(ul));

    if (total <= PAGE_SIZE) return;

    const first = page * PAGE_SIZE + 1;
    const last = Math.min(total, (page + 1) * PAGE_SIZE);
    const pages = Math.ceil(total / PAGE_SIZE);

    // Paging keeps the pager where it is (it sits below the short list, so it
    // does not move) — just reset the inner scroll so the new page starts at
    // its first review rather than halfway down.
    const toTop = () => { ul.scrollTop = 0; };

    const prev = el("button", "btn pager-btn", "‹ Newer");
    prev.type = "button";
    prev.disabled = page === 0;
    prev.addEventListener("click", () => { page--; load(); toTop(); });

    const next = el("button", "btn pager-btn", "Older ›");
    next.type = "button";
    next.disabled = page >= pages - 1;
    next.addEventListener("click", () => { page++; load(); toTop(); });

    const label = el("span", "pager-label", `${first}–${last} of ${total}`);
    label.setAttribute("aria-live", "polite");

    pager.append(prev, label, next);
  }

  load();
  return { el: box, refresh: () => { page = 0; return load(); } };
}

// --- open / close ------------------------------------------------------------

export async function openTruck(row) {
  lastFocus = document.activeElement;
  body.replaceChildren(el("p", "hint", "Loading…"));
  sheet.hidden = false;
  sheet.querySelector(".sheet-close").focus();

  async function paint() {
    // Reviews are fetched by reviewSection itself so paging can refetch without
    // rebuilding the sheet.
    const [t, edits] = await Promise.all([
      truck(row.truck_id), pendingEdits(row.truck_id),
    ]);

    const frag = document.createDocumentFragment();

    const head = el("header", "sheet-head");
    head.append(el("h2", null, t.name));
    const sub = el("p", "sheet-sub");
    sub.textContent = [
      (t.cuisines ?? []).join(" · "),
      row.venue_name ?? "Ad-hoc stop",
      fmtRange(row.starts_at, row.ends_at),
    ].filter(Boolean).join("  —  ");
    head.append(sub);

    const rate = el("p", "sheet-rating");
    if (t.rating_count > 0) {
      rate.append(stars(t.rating_avg));
      rate.append(el("span", "hint", ` ${Number(t.rating_avg).toFixed(1)} · ${t.rating_count} review${t.rating_count > 1 ? "s" : ""}`));
    } else {
      rate.append(el("span", "hint", "No ratings yet"));
    }
    head.append(rate);
    frag.append(head);

    if (t.description) frag.append(el("p", "sheet-desc", t.description));

    frag.append(sightingSection(row));

    if (edits.length) {
      const p = el("p", "hint pending-note",
        `${edits.length} suggested edit${edits.length > 1 ? "s" : ""} awaiting review.`);
      frag.append(p);
    }

    // Form ABOVE the list: writing a review is the action we want to be
    // reachable, and putting it first means it never moves as the list below it
    // grows, pages, or refreshes.
    const section = reviewSection(row.truck_id);
    // Posting refreshes only the list — repainting the whole sheet would drop
    // focus and collapse the edit panel mid-interaction.
    frag.append(reviewForm(row.truck_id, () => section.refresh()));
    frag.append(section.el);
    frag.append(editForm(row.truck_id, t.description));

    body.replaceChildren(frag);
  }

  try {
    await paint();
  } catch (e) {
    console.error("openTruck:", e.detail ?? e);
    const retry = el("button", "btn", "Try again");
    retry.type = "button";
    retry.addEventListener("click", () => openTruck(row));
    body.replaceChildren(el("p", "hint", e.message), retry);
  }
}

export function closeSheet() {
  sheet.hidden = true;
  lastFocus?.focus();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !sheet.hidden) closeSheet();
});
sheet.querySelector(".sheet-close").addEventListener("click", closeSheet);
sheet.querySelector(".sheet-scrim").addEventListener("click", closeSheet);
