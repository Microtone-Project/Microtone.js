// Sending a sketch to Microtone — through the same online projects the
// tracker's File tab lists (core/storage/online.js, the server under
// /api/online). Touch adds nothing to that protocol: a sketch arrives as an
// ordinary online project, and Microtone opens it like any other.
//
// The first send creates the project; later sends save over THAT project
// (quoting the etag it was last sent with), so re-sending a sketch as it grows
// keeps one project rather than filling the person's few slots. Where there
// is no API at all — a static server, a deploy without the Worker — the sheet
// says so and offers the file itself instead.

import * as online from "../core/storage/online.js";
import { sketchToTaud, sketchFileName } from "./sketch.js";

const MESSAGES = {
  offline: "No connection. Try again when you are back online.",
  quota: "Your online projects are full. Delete one in Microtone, then send again.",
  "too-large": "This sketch is larger than an online project can be.",
  exists: "You already have an online project with this name.",
  conflict: "That project was changed somewhere else since you last sent it.",
  "signed-out": "Your sign-in has expired. Sign in again to send.",
  "bad-name": "That name cannot be used for an online project.",
};
const message = (code) => MESSAGES[code] ?? `The server said no (${code}).`;

/** An online project is named like a file — the tracker's Save As adds
 *  `.taud` too, and the server requires it. */
const projectName = (name) => sketchFileName({ name });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Open the send sheet. `ctx` = { sheet, body, sketch, bank, onSent(sent),
 * toast(text) } — `onSent` records { id, etag } on the sketch so the next send
 * updates the same project.
 */
export async function openSend(ctx) {
  const { sheet, body } = ctx;
  render(body, `<h2>Send to Microtone</h2><p>Checking your online projects…</p>`);
  if (!sheet.open) sheet.showModal();
  const st = await online.status();
  if (!st.available) return offerFile(ctx, "Online projects are not available here, so the sketch cannot be sent from this page. You can still take the file and open it in Microtone yourself.");
  if (!st.signedIn) return offerSignIn(ctx, st);
  return offerSend(ctx, st);
}

function render(body, html) {
  body.innerHTML = html;
}

function offerSignIn(ctx, st) {
  const dev = st.signIn === "dev";
  render(ctx.body, `
    <h2>Send to Microtone</h2>
    <p>Sign in with the account you use in Microtone. The sketch then appears there under File → Online projects.</p>
    ${dev ? `<input type="text" name="devName" placeholder="Test account name" autocomplete="off">` : ""}
    <div class="row">
      <button type="button" class="tbtn primary" data-act="signin">Sign in</button>
      <button type="button" class="tbtn" data-act="file">Take the file instead</button>
      <button class="tbtn" value="close">Close</button>
    </div>
    <p class="err" data-err hidden></p>`);
  const err = ctx.body.querySelector("[data-err]");
  const stop = online.onAuthChange(async (type) => {
    if (type !== "signed-in") return;
    stop();
    offerSend(ctx, await online.status());
  });
  ctx.sheet.addEventListener("close", stop, { once: true });
  ctx.body.querySelector('[data-act="signin"]').onclick = () => {
    const name = ctx.body.querySelector('[name="devName"]')?.value.trim() ?? "";
    if (dev && !name) { err.hidden = false; err.textContent = "Give the test account a name."; return; }
    if (!online.signIn(st.signIn, { name })) {
      err.hidden = false;
      err.textContent = "The sign-in window was blocked. Allow pop-ups for this page and try again.";
    }
  };
  ctx.body.querySelector('[data-act="file"]').onclick = () => offerFile(ctx, "");
}

async function offerSend(ctx, st) {
  const { sketch } = ctx;
  render(ctx.body, `
    <h2>Send to Microtone</h2>
    <p>Signed in as <b>${esc(st.user?.name ?? "you")}</b>.</p>
    <label>Name<input type="text" name="name" value="${esc(sketch.name)}" autocomplete="off" maxlength="64"></label>
    <div class="row">
      <button type="button" class="tbtn primary" data-act="send">${sketch.sent ? "Send update" : "Send"}</button>
      <button type="button" class="tbtn" data-act="file">Take the file instead</button>
      <button class="tbtn" value="close">Close</button>
    </div>
    <p data-msg hidden></p>`);
  const msg = ctx.body.querySelector("[data-msg]");
  const say = (text, cls) => { msg.hidden = false; msg.className = cls; msg.textContent = text; };
  ctx.body.querySelector('[data-act="file"]').onclick = () => offerFile(ctx, "");
  ctx.body.querySelector('[data-act="send"]').onclick = async (e) => {
    const name = ctx.body.querySelector('[name="name"]').value.trim() || sketch.name;
    e.target.disabled = true;
    say("Sending…", "");
    try {
      const sent = await send(sketch, ctx.bank, name);
      ctx.onSent(sent, name);
      say("Sent. Open it in Microtone from File → Online projects.", "ok");
    } catch (err) {
      e.target.disabled = false;
      if (err.code === "conflict") return offerConflict(ctx, name);
      if (err.code === "exists" && err.project) return offerExists(ctx, name, err.project);
      if (err.code === "signed-out") return offerSignIn(ctx, await online.status());
      say(message(err.code ?? "offline"), "err");
    }
  };
}

/** Create the project, or save over the one this sketch was last sent as. */
async function send(sketch, bank, name) {
  const bytes = sketchToTaud({ ...sketch, name }, bank);
  const file = projectName(name);
  if (sketch.sent) {
    try {
      const p = await online.save(sketch.sent.id, bytes, sketch.sent.etag);
      return { id: p.id, etag: p.etag };
    } catch (err) {
      // Deleted in Microtone since: send it afresh rather than fail.
      if (err.status !== 404 && err.code !== "not-found") throw err;
    }
  }
  const { projects } = await online.list();
  const same = projects.find((p) => p.name === file);
  if (same) {
    const e = new online.OnlineError("exists");
    e.project = same;
    throw e;
  }
  const p = await online.create(file, bytes);
  return { id: p.id, etag: p.etag };
}

function offerExists(ctx, name, project) {
  render(ctx.body, `
    <h2>That name is taken</h2>
    <p>You already have an online project called “${esc(projectName(name))}”. Replace it with this sketch, or send it under another name.</p>
    <div class="row">
      <button type="button" class="tbtn" data-act="replace">Replace it</button>
      <button type="button" class="tbtn primary" data-act="back">Choose another name</button>
      <button class="tbtn" value="close">Cancel</button>
    </div>
    <p data-msg hidden></p>`);
  const msg = ctx.body.querySelector("[data-msg]");
  ctx.body.querySelector('[data-act="back"]').onclick = async () => offerSend(ctx, await online.status());
  ctx.body.querySelector('[data-act="replace"]').onclick = async () => {
    try {
      const p = await online.save(project.id, sketchToTaud({ ...ctx.sketch, name }, ctx.bank), null);
      ctx.onSent({ id: p.id, etag: p.etag }, name);
      msg.className = "ok";
      msg.textContent = "Sent. Open it in Microtone from File → Online projects.";
    } catch (err) {
      msg.className = "err";
      msg.textContent = message(err.code ?? "offline");
    }
    msg.hidden = false;
  };
}

function offerConflict(ctx, name) {
  render(ctx.body, `
    <h2>Changed in Microtone</h2>
    <p>“${esc(name)}” was saved from somewhere else after this sketch was last sent. Sending now would replace that work.</p>
    <div class="row">
      <button type="button" class="tbtn primary" data-act="new">Send as a new project</button>
      <button type="button" class="tbtn" data-act="replace">Replace it</button>
      <button class="tbtn" value="close">Cancel</button>
    </div>
    <p data-msg hidden></p>`);
  const msg = ctx.body.querySelector("[data-msg]");
  const run = async (fn) => {
    try { ctx.onSent(await fn(), name); msg.className = "ok"; msg.textContent = "Sent."; }
    catch (err) { msg.className = "err"; msg.textContent = message(err.code ?? "offline"); }
    msg.hidden = false;
  };
  ctx.body.querySelector('[data-act="replace"]').onclick = () => run(async () => {
    const p = await online.save(ctx.sketch.sent.id, sketchToTaud({ ...ctx.sketch, name }, ctx.bank), null);
    return { id: p.id, etag: p.etag };
  });
  ctx.body.querySelector('[data-act="new"]').onclick = () => run(() => send({ ...ctx.sketch, sent: null }, ctx.bank, `${name} (phone)`));
}

function offerFile(ctx, why) {
  const canShare = typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [new File([new Uint8Array(1)], "x.taud")] });
  render(ctx.body, `
    <h2>Take the file</h2>
    ${why ? `<p>${esc(why)}</p>` : ""}
    <p>${esc(sketchFileName(ctx.sketch))} opens in Microtone with File → Open.</p>
    <div class="row">
      ${canShare ? `<button type="button" class="tbtn primary" data-act="share">Share…</button>` : ""}
      <button type="button" class="tbtn ${canShare ? "" : "primary"}" data-act="download">Download</button>
      <button class="tbtn" value="close">Close</button>
    </div>`);
  const file = () => new File([sketchToTaud(ctx.sketch, ctx.bank)], sketchFileName(ctx.sketch),
    { type: "application/octet-stream" });
  ctx.body.querySelector('[data-act="download"]').onclick = () => {
    const url = URL.createObjectURL(file());
    const a = document.createElement("a");
    a.href = url;
    a.download = sketchFileName(ctx.sketch);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const share = ctx.body.querySelector('[data-act="share"]');
  if (share) share.onclick = () => navigator.share({ files: [file()], title: ctx.sketch.name }).catch(() => {});
}
