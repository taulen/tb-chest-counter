/**
 * "Change photo" (account menu): pick a photo, frame it in the circle, save.
 *
 * Any photo works, whatever its size: it is decoded to a working copy of at
 * most WORK_MAX px on the long edge (createImageBitmap with resize options,
 * EXIF orientation applied; an <img> + canvas where that isn't available), so
 * a 50-megapixel phone photo never has to sit in memory at full size. The
 * person pans and zooms it inside a round mask — drag or touch, pinch, the
 * wheel, the slider, or the keyboard — and it can never be moved so the circle
 * shows empty space. Only the framed square is exported (512×512 WebP, JPEG
 * where the browser can't encode WebP) and uploaded; re-encoding drops the
 * photo's metadata (EXIF, GPS), and the original never leaves the device.
 *
 * The server checks the upload again (avatar-repo.validateAvatarUpload) and
 * decides what the account shows; this only sends the picture.
 */
import { t } from './i18n.js';
import { api } from './api.js';
import { confirmDialog, esc, holdDialogFocus, notify } from './ui.js';
import { avatarHtml } from './avatar.js';

/** The uploaded square, in px. */
const OUT_PX = 512;
/** The working copy's long edge, in px: plenty for a 512 crop at any zoom used. */
const WORK_MAX = 2048;
/** The tightest framing: the circle never shows fewer source pixels than this. */
const MIN_VISIBLE_PX = 96;
/** Preview sizes: where the picture is actually shown (account menu, Users page). */
const PREVIEW_SIZES = [34, 28];

/**
 * Decode `file` into a source no larger than WORK_MAX on its long edge, upright.
 * Resolves { source, width, height, close } or rejects when the browser can't
 * read the format.
 */
async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    // The <img> reads the oriented size from the header; its pixels are only
    // decoded if the fallback below draws it.
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('unreadable'));
      img.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('unreadable');
    const scale = Math.min(1, WORK_MAX / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file, {
          imageOrientation: 'from-image', resizeWidth: tw, resizeHeight: th, resizeQuality: 'high',
        });
        // An engine that ignored the orientation hands back the other shape.
        if (bmp.width === tw && bmp.height === th) {
          return { source: bmp, width: tw, height: th, close: () => bmp.close() };
        }
        bmp.close();
      } catch { /* no resize/orientation options here: draw the <img> instead */ }
    }

    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, tw, th);
    return { source: canvas, width: tw, height: th, close: () => { canvas.width = 0; canvas.height = 0; } };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The framed square as an upload: WebP where the browser encodes it, else JPEG. */
async function exportSquare(photo, frame) {
  const canvas = document.createElement('canvas');
  canvas.width = OUT_PX;
  canvas.height = OUT_PX;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.source, frame.cx - frame.side / 2, frame.cy - frame.side / 2, frame.side, frame.side, 0, 0, OUT_PX, OUT_PX);
  const webp = await toBlob(canvas, 'image/webp', 0.9);
  if (webp && webp.type === 'image/webp') return webp;
  // JPEG has no transparency: put a transparent PNG on the page's own colour.
  const flat = document.createElement('canvas');
  flat.width = OUT_PX;
  flat.height = OUT_PX;
  const fctx = flat.getContext('2d');
  fctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-elevated').trim() || 'gray';
  fctx.fillRect(0, 0, OUT_PX, OUT_PX);
  fctx.drawImage(canvas, 0, 0);
  return toBlob(flat, 'image/jpeg', 0.9);
}

/** What the account shows now, in words. */
function currentLine(avatar) {
  if (avatar?.kind === 'photo') return t('Your photo is shown beside your name.');
  if (avatar?.kind === 'hero') return t('Your hero portrait from the game is shown beside your name.');
  return t('Your initial is shown beside your name.');
}

/**
 * Open the editor for `user` (needs `.avatar`). `onChange(avatar)` runs after
 * a save or a removal with what the account shows now.
 */
export function openAvatarEditor(user, onChange) {
  const root = document.getElementById('modalRoot');
  if (!root || !user) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card avatar-editor" role="dialog" aria-modal="true">
      <div class="modal-title">${t('Profile photo')}</div>
      <input type="file" accept="image/*" class="avatar-editor-file" hidden>

      <div class="avatar-editor-step" data-step="pick">
        <div class="avatar-editor-current">${avatarHtml(user, { size: 'xl' })}</div>
        <p class="avatar-editor-line">${esc(currentLine(user.avatar))}</p>
        <button type="button" class="btn btn-primary avatar-editor-choose" data-act="choose">${t('Choose a photo')}</button>
      </div>

      <div class="avatar-editor-step avatar-editor-busy" data-step="busy" hidden role="status">
        <span class="avatar-editor-spinner" aria-hidden="true"></span>
        <span>${t('Preparing photo…')}</span>
      </div>

      <div class="avatar-editor-step" data-step="frame" hidden>
        <div class="avatar-crop-stage" tabindex="0" role="group" aria-label="${esc(t('Photo framing'))}" aria-describedby="avatarCropHint">
          <canvas class="avatar-crop-canvas"></canvas>
          <div class="avatar-crop-ring" aria-hidden="true"></div>
        </div>
        <p class="modal-form-hint avatar-crop-hint" id="avatarCropHint">${t('Drag to move the photo; pinch or scroll to zoom. With the keyboard: the arrow keys move it, + and − zoom.')}</p>
        <div class="avatar-crop-zoom">
          <button type="button" class="btn avatar-crop-zoom-btn" data-act="zoom-out" aria-label="${esc(t('Zoom out'))}">−</button>
          <input type="range" class="avatar-crop-range" min="1" max="4" step="0.01" value="1" aria-label="${esc(t('Zoom'))}">
          <button type="button" class="btn avatar-crop-zoom-btn" data-act="zoom-in" aria-label="${esc(t('Zoom in'))}">+</button>
        </div>
        <div class="avatar-crop-previews">
          <span class="avatar-crop-previews-label">${t('Preview')}</span>
          ${PREVIEW_SIZES.map((px) => `<canvas class="avatar-crop-preview" data-size="${px}" style="width:${px}px;height:${px}px" aria-hidden="true"></canvas>`).join('')}
          <button type="button" class="btn avatar-editor-another" data-act="choose">${t('Choose another photo')}</button>
        </div>
      </div>

      <p class="modal-form-hint avatar-editor-privacy">${t('Only the framed picture is uploaded. Your original photo stays on this device.')}</p>

      <div class="modal-actions avatar-editor-actions">
        <button type="button" class="btn btn-danger avatar-editor-remove" data-act="remove"${user.avatar?.kind === 'photo' ? '' : ' hidden'}>${t('Remove photo')}</button>
        <button type="button" class="btn modal-cancel" data-act="cancel">${t('Cancel')}</button>
        <button type="button" class="btn btn-primary" data-act="save" hidden>${t('Save')}</button>
      </div>
    </div>
  `;
  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const card = overlay.querySelector('.modal-card');
  const fileInput = overlay.querySelector('.avatar-editor-file');
  const stage = overlay.querySelector('.avatar-crop-stage');
  const canvas = overlay.querySelector('.avatar-crop-canvas');
  const range = overlay.querySelector('.avatar-crop-range');
  const saveBtn = overlay.querySelector('[data-act="save"]');
  const removeBtn = overlay.querySelector('[data-act="remove"]');
  const previews = [...overlay.querySelectorAll('.avatar-crop-preview')];

  /** The decoded working copy, and the framing: centre + visible side, in its px. */
  let photo = null;
  let frame = null;
  let minSide = 0;
  let zoom = 1;
  let maxZoom = 1;
  let loadSeq = 0;
  let busy = false;

  const showStep = (name) => {
    for (const el of overlay.querySelectorAll('[data-step]')) el.hidden = el.dataset.step !== name;
    saveBtn.hidden = name !== 'frame';
    removeBtn.hidden = name !== 'pick' || user.avatar?.kind !== 'photo';
  };

  const stageSize = () => stage.clientWidth || 280;

  // Keep the circle covered: the visible square stays inside the photo.
  const clampFrame = () => {
    const half = frame.side / 2;
    frame.cx = Math.min(Math.max(frame.cx, half), photo.width - half);
    frame.cy = Math.min(Math.max(frame.cy, half), photo.height - half);
  };

  const draw = () => {
    if (!photo || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    const size = stageSize();
    const px = Math.round(size * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const scale = size / frame.side;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(photo.source, size / 2 - frame.cx * scale, size / 2 - frame.cy * scale, photo.width * scale, photo.height * scale);
    for (const p of previews) {
      const css = Number(p.dataset.size);
      const ppx = Math.round(css * dpr);
      if (p.width !== ppx) { p.width = ppx; p.height = ppx; }
      const pctx = p.getContext('2d');
      pctx.imageSmoothingQuality = 'high';
      pctx.clearRect(0, 0, ppx, ppx);
      pctx.drawImage(photo.source, frame.cx - frame.side / 2, frame.cy - frame.side / 2, frame.side, frame.side, 0, 0, ppx, ppx);
    }
    range.value = String(zoom);
  };

  /** Zoom to `next`, keeping the photo point under `at` (stage px) where it is. */
  const zoomTo = (next, at) => {
    if (!frame) return;
    const size = stageSize();
    const point = at ?? { x: size / 2, y: size / 2 };
    const before = size / frame.side;
    const ix = frame.cx + (point.x - size / 2) / before;
    const iy = frame.cy + (point.y - size / 2) / before;
    zoom = Math.min(Math.max(next, 1), maxZoom);
    frame.side = minSide / zoom;
    const after = size / frame.side;
    frame.cx = ix - (point.x - size / 2) / after;
    frame.cy = iy - (point.y - size / 2) / after;
    clampFrame();
    draw();
  };

  /** Move the photo by (dx, dy) stage px, the way a drag moves it. */
  const panBy = (dx, dy) => {
    if (!frame) return;
    const scale = stageSize() / frame.side;
    frame.cx -= dx / scale;
    frame.cy -= dy / scale;
    clampFrame();
    draw();
  };

  const release = holdDialogFocus(overlay, {
    card,
    initial: overlay.querySelector('[data-act="choose"]'),
    onEscape: () => close(),
    returnTo: document.getElementById(window.matchMedia('(max-width: 640px)').matches ? 'shellMoreBtn' : 'userMenuBtn'),
  });

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => draw()) : null;
  resizeObserver?.observe(stage);

  function close() {
    loadSeq++;
    resizeObserver?.disconnect();
    photo?.close();
    photo = null;
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 180);
    release();
  }

  const pick = async (file) => {
    if (!file) return;
    const seq = ++loadSeq;
    showStep('busy');
    try {
      const loaded = await loadPhoto(file);
      if (seq !== loadSeq) { loaded.close(); return; }
      photo?.close();
      photo = loaded;
      minSide = Math.min(photo.width, photo.height);
      maxZoom = Math.max(1, Math.min(8, minSide / MIN_VISIBLE_PX));
      range.max = String(maxZoom);
      zoom = 1;
      frame = { cx: photo.width / 2, cy: photo.height / 2, side: minSide };
      showStep('frame');
      draw();
      stage.focus({ preventScroll: true });
    } catch {
      if (seq !== loadSeq) return;
      showStep(photo ? 'frame' : 'pick');
      await notify(t('This photo could not be opened here. Try a JPEG or PNG.'), t('Profile photo'));
    }
  };

  const save = async () => {
    if (!photo || !frame || busy) return;
    busy = true;
    saveBtn.disabled = true;
    saveBtn.textContent = t('Saving…');
    try {
      const blob = await exportSquare(photo, frame);
      if (!blob) throw new Error(t('This browser could not prepare the picture.'));
      const res = await api('/auth/avatar', { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob });
      if (res?.error) throw new Error(res.error);
      onChange?.(res.avatar);
      close();
    } catch (err) {
      busy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = t('Save');
      if (err?.name === 'UnauthenticatedError') return;
      await notify(t('Could not save the photo: {error}', { error: err?.message || String(err) }), t('Error'));
    }
  };

  const remove = async () => {
    const ok = await confirmDialog(t('The picture beside your name goes back to the default.'), {
      title: t('Remove your photo?'), confirmLabel: t('Remove photo'), danger: true,
    });
    if (!ok) return;
    try {
      const res = await api('/auth/avatar', { method: 'DELETE' });
      if (res?.error) throw new Error(res.error);
      onChange?.(res.avatar);
      close();
    } catch (err) {
      if (err?.name === 'UnauthenticatedError') return;
      await notify(t('Could not remove the photo: {error}', { error: err?.message || String(err) }), t('Error'));
    }
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { close(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'choose') fileInput.click();
    else if (act === 'cancel') close();
    else if (act === 'save') save();
    else if (act === 'remove') remove();
    else if (act === 'zoom-in') zoomTo(zoom * 1.15);
    else if (act === 'zoom-out') zoomTo(zoom / 1.15);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    pick(file);
  });
  range.addEventListener('input', () => zoomTo(Number(range.value)));

  // Drag with one pointer, pinch with two.
  const pointers = new Map();
  let pinch = null;
  const stagePoint = (x, y) => {
    const r = stage.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  };
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2),
    };
  };
  stage.addEventListener('pointerdown', (e) => {
    if (!frame) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinch = { ...pinchState(), zoom };
    stage.classList.add('is-dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    if (pointers.size === 1) {
      pointers.set(e.pointerId, now);
      panBy(now.x - prev.x, now.y - prev.y);
      return;
    }
    pointers.set(e.pointerId, now);
    if (pinch && pointers.size === 2) {
      const cur = pinchState();
      panBy(cur.mid.x - pinch.mid.x, cur.mid.y - pinch.mid.y);
      zoomTo(pinch.zoom * (cur.dist / pinch.dist), cur.mid);
      pinch.mid = cur.mid;
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 2) pinch = { ...pinchState(), zoom };
    if (pointers.size === 0) stage.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('wheel', (e) => {
    if (!frame) return;
    e.preventDefault();
    zoomTo(zoom * Math.exp(-e.deltaY * 0.0015), stagePoint(e.clientX, e.clientY));
  }, { passive: false });
  stage.addEventListener('keydown', (e) => {
    if (!frame) return;
    const step = e.shiftKey ? 32 : 8;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      panBy(...moves[e.key]);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomTo(zoom * 1.1);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomTo(zoom / 1.1);
    }
  });

  showStep('pick');
}
