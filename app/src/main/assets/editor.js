const hasChromeIdentity = typeof chrome !== 'undefined' && chrome.identity && chrome.runtime && chrome.runtime.getURL;

pdfjsLib.GlobalWorkerOptions.workerSrc = hasChromeIdentity
  ? chrome.runtime.getURL('vendor/pdf.worker.min.js')
  : 'vendor/pdf.worker.min.js';

// Non-extension hosts (Android WebView, plain web app) call this after sign-in
// to hand over an OAuth access token.
window.setExternalToken = function setExternalToken(token) {
  window.__externalToken = token;
};
window.setAndroidToken = window.setExternalToken;

const RENDER_SCALE = 1.4;

const statusEl = document.getElementById('status');
const viewerEl = document.getElementById('viewer');
const pageSelectEl = document.getElementById('page-select');
const imageInputEl = document.getElementById('image-input');
const saveBtnEl = document.getElementById('save-btn');

let fileId = null;
let originalPdfBytes = null;
let pageWrappers = [];
let overlays = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function getAuthToken(interactive) {
  if (window.__externalToken) {
    return Promise.resolve(window.__externalToken);
  }
  if (typeof AndroidTokenBridge !== 'undefined' && AndroidTokenBridge.getToken) {
    const bridgeToken = AndroidTokenBridge.getToken();
    if (bridgeToken) return Promise.resolve(bridgeToken);
  }
  return new Promise((resolve, reject) => {
    if (!hasChromeIdentity) {
      reject(new Error('Mekanisme login Google tidak tersedia di lingkungan ini.'));
      return;
    }
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Gagal mendapatkan token akses Google'));
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    if (!hasChromeIdentity) {
      window.__externalToken = null;
      resolve();
      return;
    }
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

async function fetchPdfBytes(id, token) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Gagal mengambil file dari Drive (HTTP ${resp.status})`);
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

async function fetchFileName(id, token) {
  try {
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.name;
  } catch {
    return null;
  }
}

async function renderPdf(bytesForRender) {
  viewerEl.innerHTML = '';
  pageWrappers = [];

  const pdf = await pdfjsLib.getDocument({ data: bytesForRender }).promise;

  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.height = `${viewport.height}px`;
      wrapper.dataset.pageIndex = String(i - 1);
      wrapper.appendChild(canvas);

      viewerEl.appendChild(wrapper);
      pageWrappers.push(wrapper);
    } catch (err) {
      throw new Error(`halaman ${i}: ${err.message}`);
    }
  }
}

function populatePageSelect() {
  pageSelectEl.innerHTML = '';
  pageWrappers.forEach((_, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `Halaman ${idx + 1}`;
    pageSelectEl.appendChild(opt);
  });
}

function getToolbarHeight() {
  return document.getElementById('toolbar').offsetHeight;
}

function updateActivePageFromScroll() {
  const toolbarH = getToolbarHeight();
  let activeIdx = 0;
  for (let i = 0; i < pageWrappers.length; i++) {
    const rect = pageWrappers[i].getBoundingClientRect();
    if (rect.top <= toolbarH + 10) {
      activeIdx = i;
    } else {
      break;
    }
  }
  if (pageSelectEl.value !== String(activeIdx)) {
    pageSelectEl.value = String(activeIdx);
  }
}

let scrollTicking = false;
window.addEventListener('scroll', () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    updateActivePageFromScroll();
    scrollTicking = false;
  });
}, { passive: true });

pageSelectEl.addEventListener('change', () => {
  const idx = Number(pageSelectEl.value);
  const wrapper = pageWrappers[idx];
  if (!wrapper) return;
  const toolbarH = getToolbarHeight();
  const targetY = window.scrollY + wrapper.getBoundingClientRect().top - toolbarH - 12;
  window.scrollTo({ top: targetY, behavior: 'smooth' });
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function updateSaveButton() {
  saveBtnEl.disabled = overlays.length === 0;
}

function makeDraggable(overlay) {
  const el = overlay.el;
  let startX, startY, startLeft, startTop;

  el.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('resize-handle') ||
        e.target.classList.contains('remove-handle') ||
        e.target.classList.contains('page-nav-handle')) {
      return;
    }
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startY = e.clientY;
    startLeft = el.offsetLeft;
    startTop = el.offsetTop;

    function onMove(ev) {
      const wrapper = overlay.pageWrapper;
      const newLeft = clamp(startLeft + (ev.clientX - startX), 0, wrapper.clientWidth - el.offsetWidth);
      const newTop = clamp(startTop + (ev.clientY - startY), 0, wrapper.clientHeight - el.offsetHeight);
      el.style.left = `${newLeft}px`;
      el.style.top = `${newTop}px`;
    }

    function onUp() {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    }

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

function makeResizable(overlay, handle) {
  const el = overlay.el;
  const img = el.querySelector('img');

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = el.offsetWidth;
    const aspect = (img.naturalHeight && img.naturalWidth) ? img.naturalHeight / img.naturalWidth : 0.4;

    function onMove(ev) {
      const wrapper = overlay.pageWrapper;
      const maxWidth = wrapper.clientWidth - el.offsetLeft;
      const newWidth = clamp(startWidth + (ev.clientX - startX), 30, maxWidth);
      el.style.width = `${newWidth}px`;
      el.style.height = `${newWidth * aspect}px`;
    }

    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

function computeCenterPosition(wrapper, width, height) {
  const rect = wrapper.getBoundingClientRect();
  const viewTop = Math.max(rect.top, 0);
  const viewBottom = Math.min(rect.bottom, window.innerHeight);
  const centerY = (viewTop + viewBottom) / 2 - rect.top;
  const centerX = window.innerWidth / 2 - rect.left;

  return {
    left: clamp(centerX - width / 2, 0, Math.max(0, wrapper.clientWidth - width)),
    top: clamp(centerY - height / 2, 0, Math.max(0, wrapper.clientHeight - height))
  };
}

function moveOverlayToPage(overlay, newIndex) {
  if (newIndex < 0 || newIndex >= pageWrappers.length) return;
  const newWrapper = pageWrappers[newIndex];
  overlay.pageWrapper = newWrapper;
  const pos = computeCenterPosition(newWrapper, overlay.el.offsetWidth, overlay.el.offsetHeight);
  overlay.el.style.left = `${pos.left}px`;
  overlay.el.style.top = `${pos.top}px`;
  newWrapper.appendChild(overlay.el);
}

function addImageOverlay(dataUrl, mimeType, bytes, pageIdx) {
  const targetPage = pageWrappers[pageIdx] || pageWrappers[0];

  const el = document.createElement('div');
  el.className = 'sig-overlay';
  el.style.left = '40px';
  el.style.top = '40px';
  el.style.width = '160px';

  const img = document.createElement('img');
  img.src = dataUrl;
  el.appendChild(img);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle';
  el.appendChild(resizeHandle);

  const removeHandle = document.createElement('div');
  removeHandle.className = 'remove-handle';
  removeHandle.textContent = '×';
  el.appendChild(removeHandle);

  const prevHandle = document.createElement('div');
  prevHandle.className = 'page-nav-handle page-nav-prev';
  prevHandle.textContent = '‹';
  prevHandle.title = 'Pindah ke halaman sebelumnya';
  el.appendChild(prevHandle);

  const nextHandle = document.createElement('div');
  nextHandle.className = 'page-nav-handle page-nav-next';
  nextHandle.textContent = '›';
  nextHandle.title = 'Pindah ke halaman berikutnya';
  el.appendChild(nextHandle);

  targetPage.appendChild(el);

  const overlay = { el, pageWrapper: targetPage, mimeType, bytes };
  overlays.push(overlay);

  img.addEventListener('load', () => {
    if (img.naturalWidth && img.naturalHeight) {
      const height = 160 * (img.naturalHeight / img.naturalWidth);
      el.style.height = `${height}px`;
      const pos = computeCenterPosition(targetPage, el.offsetWidth, height);
      el.style.left = `${pos.left}px`;
      el.style.top = `${pos.top}px`;
    }
  });

  makeDraggable(overlay);
  makeResizable(overlay, resizeHandle);

  removeHandle.addEventListener('click', () => {
    el.remove();
    overlays = overlays.filter((o) => o !== overlay);
    updateSaveButton();
  });

  prevHandle.addEventListener('click', () => {
    const idx = pageWrappers.indexOf(overlay.pageWrapper);
    moveOverlayToPage(overlay, idx - 1);
  });

  nextHandle.addEventListener('click', () => {
    const idx = pageWrappers.indexOf(overlay.pageWrapper);
    moveOverlayToPage(overlay, idx + 1);
  });

  updateSaveButton();
}

const signModalEl = document.getElementById('sign-modal');
const signPadEl = document.getElementById('sign-pad');
const signColorEl = document.getElementById('sign-color');
const signThicknessEl = document.getElementById('sign-thickness');
const signCtx = signPadEl.getContext('2d');

let strokePoints = [];
let isDrawing = false;
let hasInk = false;

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function getPadPoint(e) {
  const rect = signPadEl.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function clearSignPad() {
  signCtx.clearRect(0, 0, signPadEl.width, signPadEl.height);
  hasInk = false;
}

signPadEl.addEventListener('pointerdown', (e) => {
  signPadEl.setPointerCapture(e.pointerId);
  isDrawing = true;
  hasInk = true;
  const p = getPadPoint(e);
  strokePoints = [p];
  signCtx.strokeStyle = signColorEl.value;
  signCtx.lineWidth = Number(signThicknessEl.value);
  signCtx.lineJoin = 'round';
  signCtx.lineCap = 'round';
  signCtx.beginPath();
  signCtx.moveTo(p.x, p.y);
});

signPadEl.addEventListener('pointermove', (e) => {
  if (!isDrawing) return;
  const p = getPadPoint(e);
  strokePoints.push(p);

  if (strokePoints.length < 3) {
    signCtx.lineTo(p.x, p.y);
    signCtx.stroke();
    return;
  }

  const [p0, p1, p2] = strokePoints.slice(-3);
  const m1 = midpoint(p0, p1);
  const m2 = midpoint(p1, p2);
  signCtx.beginPath();
  signCtx.moveTo(m1.x, m1.y);
  signCtx.quadraticCurveTo(p1.x, p1.y, m2.x, m2.y);
  signCtx.stroke();
});

function endStroke() {
  isDrawing = false;
  strokePoints = [];
}

signPadEl.addEventListener('pointerup', endStroke);
signPadEl.addEventListener('pointercancel', endStroke);
signPadEl.addEventListener('pointerleave', () => { if (isDrawing) endStroke(); });

document.getElementById('sign-clear-btn').addEventListener('click', clearSignPad);

document.getElementById('draw-sign-btn').addEventListener('click', () => {
  clearSignPad();
  signModalEl.classList.remove('hidden');
});

function closeSignModal() {
  signModalEl.classList.add('hidden');
}

document.getElementById('sign-modal-close').addEventListener('click', closeSignModal);
document.getElementById('sign-cancel-btn').addEventListener('click', closeSignModal);

function trimCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;

  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const trimmedW = maxX - minX + 1;
  const trimmedH = maxY - minY + 1;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = trimmedW;
  outCanvas.height = trimmedH;
  outCanvas.getContext('2d').drawImage(canvas, minX, minY, trimmedW, trimmedH, 0, 0, trimmedW, trimmedH);
  return outCanvas;
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

document.getElementById('sign-use-btn').addEventListener('click', () => {
  if (!hasInk) {
    closeSignModal();
    return;
  }
  const trimmed = trimCanvas(signPadEl);
  if (!trimmed) {
    closeSignModal();
    return;
  }
  const dataUrl = trimmed.toDataURL('image/png');
  const bytes = dataUrlToBytes(dataUrl);
  const pageIdx = Number(pageSelectEl.value || 0);
  addImageOverlay(dataUrl, 'image/png', bytes, pageIdx);
  closeSignModal();
});

imageInputEl.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const [dataUrl, arrayBuffer] = await Promise.all([blobToDataUrl(file), file.arrayBuffer()]);
  const pageIdx = Number(pageSelectEl.value || 0);
  addImageOverlay(dataUrl, file.type, new Uint8Array(arrayBuffer), pageIdx);
  imageInputEl.value = '';
});

async function handleSave() {
  setStatus('Menyimpan ke Drive...');
  saveBtnEl.disabled = true;

  try {
    const pdfDoc = await PDFLib.PDFDocument.load(originalPdfBytes);
    const pages = pdfDoc.getPages();

    for (const overlay of overlays) {
      const pageIndex = Number(overlay.pageWrapper.dataset.pageIndex);
      const page = pages[pageIndex];
      const pageWidthPt = page.getWidth();
      const pageHeightPt = page.getHeight();

      const scaleX = pageWidthPt / overlay.pageWrapper.clientWidth;
      const scaleY = pageHeightPt / overlay.pageWrapper.clientHeight;

      const xPx = overlay.el.offsetLeft;
      const yPx = overlay.el.offsetTop;
      const wPx = overlay.el.offsetWidth;
      const hPx = overlay.el.offsetHeight;

      const embedded = overlay.mimeType === 'image/png'
        ? await pdfDoc.embedPng(overlay.bytes)
        : await pdfDoc.embedJpg(overlay.bytes);

      const wPt = wPx * scaleX;
      const hPt = hPx * scaleY;
      const xPt = xPx * scaleX;
      const yPt = pageHeightPt - (yPx * scaleY) - hPt;

      page.drawImage(embedded, { x: xPt, y: yPt, width: wPt, height: hPt });
    }

    const newBytes = await pdfDoc.save();

    let token = await getAuthToken(true);
    let resp = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/pdf'
      },
      body: newBytes
    });

    if (resp.status === 401) {
      await removeCachedToken(token);
      token = await getAuthToken(true);
      resp = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/pdf'
        },
        body: newBytes
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }

    setStatus('Tersimpan ke Google Drive.');
  } catch (err) {
    console.error(err);
    setStatus(`Gagal menyimpan: ${err.message}`);
  } finally {
    saveBtnEl.disabled = overlays.length === 0;
  }
}

saveBtnEl.addEventListener('click', handleSave);

async function init(overrideFileId) {
  const params = new URLSearchParams(location.search);
  fileId = overrideFileId || params.get('fileId');
  if (!fileId) {
    setStatus('fileId tidak ditemukan pada URL.');
    return;
  }

  setStatus('Meminta izin akun Google...');
  let token;
  try {
    token = await getAuthToken(true);
  } catch (err) {
    setStatus(`Gagal login Google: ${err.message}`);
    return;
  }

  setStatus('Mengambil file dari Drive...');
  try {
    originalPdfBytes = await fetchPdfBytes(fileId, token);
  } catch (err) {
    await removeCachedToken(token);
    try {
      token = await getAuthToken(true);
      originalPdfBytes = await fetchPdfBytes(fileId, token);
    } catch (err2) {
      setStatus(`Gagal mengambil file: ${err2.message}`);
      return;
    }
  }

  const name = await fetchFileName(fileId, token);
  if (name) document.title = `${name} - Drive PDF Signer`;

  setStatus('Merender PDF...');
  try {
    await renderPdf(originalPdfBytes.slice().buffer);
  } catch (err) {
    console.error(err);
    setStatus(`Gagal merender PDF: ${err.message}`);
    return;
  }
  populatePageSelect();
  setStatus(name ? `${name} — siap diedit` : 'Siap. Tambahkan gambar/tanda tangan lalu simpan.');
}

init();
