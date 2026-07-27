/**
 * The single owner of #status.
 *
 * THE BUG THIS REPLACES
 * Three modules each grabbed #status and wrote to it directly. detail.js and
 * addtruck.js had their own copies of a toast() that set a 3.8s hide timer;
 * main.js had a setStatus() with no timer, used for "Couldn't load trucks".
 * Nothing coordinated them, so a load failure — the one message that must stay
 * on screen — was silently erased 3.8 seconds after any unrelated toast, and a
 * toast could be wiped instantly by a load error arriving mid-fade.
 *
 * TWO KINDS OF MESSAGE, AND THEY ARE NOT THE SAME
 *   transient  feedback for something you just did ("Thanks for the review!").
 *              Self-clearing, because you already know what you did.
 *   sticky     a condition that is still true ("Couldn't load trucks"). Clearing
 *              it on a timer is a lie — the trucks are still not loaded.
 *
 * A transient message may cover a sticky one briefly, then the sticky message is
 * RESTORED rather than lost. That way acting while offline still confirms the
 * action, and the reason the page is broken does not quietly disappear.
 */
const el = document.getElementById("status");

let sticky = null;      // { msg, isError } or null — the condition still in force
let timer = null;

function paint(msg, isError) {
  el.textContent = msg;
  el.classList.toggle("err", Boolean(isError));
  el.hidden = false;
}

function restoreOrHide() {
  // Null the handle, do not just let it expire. setTimeout's return value stays
  // truthy after it fires, so `if (!timer)` in clearSticky() would be false
  // forever after the first transient message — and clearSticky would silently
  // stop hiding anything.
  timer = null;
  if (sticky) paint(sticky.msg, sticky.isError);
  else el.hidden = true;
}

/**
 * @param {string}  msg
 * @param {object}  [opts]
 * @param {boolean} [opts.error]   style as a failure
 * @param {boolean} [opts.sticky]  stays until explicitly cleared
 */
export function toast(msg, { error = false, sticky: isSticky = false } = {}) {
  clearTimeout(timer);
  timer = null;

  if (isSticky) {
    sticky = { msg, isError: error };
    paint(msg, error);
    return;
  }

  paint(msg, error);
  timer = setTimeout(restoreOrHide, 3800);
}

/** Drop the sticky condition — call when the thing that failed starts working. */
export function clearSticky() {
  sticky = null;
  // Only take it off screen if a transient message is not currently showing;
  // otherwise let that one finish its own life and hide itself.
  if (!timer) el.hidden = true;
}
