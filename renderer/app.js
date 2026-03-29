const audioCtx = new AudioContext();
const SHORTCUT_KEYS = '1234567890qwertyuiopasdfghjklzxcvbnm'.split('');
const FILE_LIBRARY = 'library.json';
const FILE_PRESETS = 'presets.json';
const FILE_ACTIVE = 'active-preset.json';
const SECTIONS = ['sfx', 'mr'];

// --- State ---

let library = [];
let presets = [];
// Preset shape: { id, name, sections: { sfx: [{filePath, name, volume}], mr: [...] } }
let activePresetId = null;
let pads = { sfx: [], mr: [] }; // runtime pads per section

// --- Audio Engine ---

const bufferCache = new Map();

async function loadAudioBuffer(filePath) {
  if (bufferCache.has(filePath)) return bufferCache.get(filePath);
  const response = await fetch(`file://${filePath}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = await audioCtx.decodeAudioData(arrayBuffer);
  bufferCache.set(filePath, buffer);
  return buffer;
}

function stopSectionPads(section) {
  pads[section].forEach(p => { stopPad(p); p.pausedAt = null; updatePadUI(p); });
}

function playSoundFromBuffer(pad, offset = 0) {
  if (pad.section === 'mr') stopSectionPads('mr');
  else stopPad(pad);

  const source = audioCtx.createBufferSource();
  const gainNode = audioCtx.createGain();
  source.buffer = pad.buffer;
  gainNode.gain.value = pad.volume;
  source.connect(gainNode).connect(audioCtx.destination);
  source.start(0, offset);
  pad.source = source;
  pad.gainNode = gainNode;
  pad.startTime = audioCtx.currentTime - offset;
  pad.duration = pad.buffer.duration;
  pad.pausedAt = null;
  source.onended = () => {
    pad.source = null;
    pad.gainNode = null;
    pad.startTime = null;
    pad.pausedAt = null;
    updatePadUI(pad);
  };
  updatePadUI(pad);
}

function pauseMR() {
  const playing = pads.mr.find(p => p.source);
  if (playing) {
    const elapsed = audioCtx.currentTime - playing.startTime;
    // Remove onended first so it doesn't clear pausedAt
    playing.source.onended = null;
    stopPad(playing);
    playing.pausedAt = elapsed;
    playing.startTime = playing.startTime; // keep for progress display
    updatePadUI(playing);
  }
}

function resumeMR() {
  const paused = pads.mr.find(p => p.pausedAt != null && p.pausedAt > 0);
  if (!paused) return;

  const offset = paused.pausedAt;
  const source = audioCtx.createBufferSource();
  const gainNode = audioCtx.createGain();
  source.buffer = paused.buffer;
  gainNode.gain.value = paused.volume;
  source.connect(gainNode).connect(audioCtx.destination);
  source.start(0, offset);
  paused.source = source;
  paused.gainNode = gainNode;
  paused.startTime = audioCtx.currentTime - offset;
  paused.pausedAt = null;
  source.onended = () => {
    paused.source = null;
    paused.gainNode = null;
    paused.startTime = null;
    paused.pausedAt = null;
    updatePadUI(paused);
  };
  updatePadUI(paused);
}

function seekMR(delta) {
  const playing = pads.mr.find(p => p.source);
  const paused = pads.mr.find(p => p.pausedAt != null && p.pausedAt > 0);

  if (playing) {
    const elapsed = audioCtx.currentTime - playing.startTime;
    const newPos = Math.max(0, Math.min(elapsed + delta, playing.duration));
    playing.source.onended = null;
    stopPad(playing);
    playSoundFromBuffer(playing, newPos);
  } else if (paused) {
    paused.pausedAt = Math.max(0, Math.min(paused.pausedAt + delta, paused.duration));
  }
}

function toggleMRPause() {
  const playing = pads.mr.find(p => p.source);
  if (playing) {
    pauseMR();
  } else {
    resumeMR();
  }
}

const FADE_OUT_MS = 80;

function stopPad(pad, immediate = false) {
  if (!pad.source) return;
  if (immediate || !pad.gainNode) {
    try { pad.source.stop(); } catch {}
    try { pad.source.disconnect(); } catch {}
    if (pad.gainNode) try { pad.gainNode.disconnect(); } catch {}
    pad.source = null;
    pad.gainNode = null;
    return;
  }
  // Fade out
  const gain = pad.gainNode;
  const src = pad.source;
  gain.gain.setValueAtTime(gain.gain.value, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + FADE_OUT_MS / 1000);
  setTimeout(() => {
    try { src.stop(); } catch {}
    try { src.disconnect(); } catch {}
    try { gain.disconnect(); } catch {}
  }, FADE_OUT_MS);
  pad.source = null;
  pad.gainNode = null;
}

function stopAll() {
  allPads().forEach(stopPad);
  updateAllPadUI();
}

function allPads() {
  return [...pads.sfx, ...pads.mr];
}

// --- Library ---

function addToLibrary(filePaths) {
  for (const filePath of filePaths) {
    if (library.find(l => l.filePath === filePath)) continue;
    const name = filePath.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
    library.push({ filePath, name });
  }
  saveLibrary();
  renderLibrary();
}

function removeFromLibrary(filePath) {
  library = library.filter(l => l.filePath !== filePath);
  saveLibrary();
  renderLibrary();
}

function saveLibrary() {
  window.electronAPI.saveData(FILE_LIBRARY, library);
}

async function loadLibrary() {
  const data = await window.electronAPI.loadData(FILE_LIBRARY);
  if (data) library = data;
}

// --- Presets ---

function createPreset(name) {
  const preset = {
    id: 'preset-' + Date.now(),
    name: name || 'New Preset',
    sections: { sfx: [], mr: [] },
  };
  presets.push(preset);
  savePresets();
  switchPreset(preset.id);
  renderPresetList();
}

function deletePreset(id) {
  presets = presets.filter(p => p.id !== id);
  if (activePresetId === id) {
    activePresetId = presets.length > 0 ? presets[0].id : null;
  }
  savePresets();
  renderPresetList();
  loadActivePreset();
}

function renamePreset(id, newName) {
  const preset = presets.find(p => p.id === id);
  if (preset) {
    preset.name = newName;
    savePresets();
    renderPresetList();
    if (activePresetId === id) {
      document.getElementById('preset-title').textContent = newName;
    }
  }
}

function switchPreset(id) {
  stopAll();
  activePresetId = id;
  saveActivePresetId();
  renderPresetList();
  loadActivePreset();
}

function getActivePreset() {
  return presets.find(p => p.id === activePresetId) || null;
}

function saveCurrentPresetPads() {
  const preset = getActivePreset();
  if (!preset) return;
  preset.sections = {};
  for (const sec of SECTIONS) {
    preset.sections[sec] = pads[sec].map(p => ({ filePath: p.filePath, name: p.name, volume: p.volume }));
  }
  savePresets();
}

function savePresets() {
  window.electronAPI.saveData(FILE_PRESETS, presets);
}

function saveActivePresetId() {
  window.electronAPI.saveData(FILE_ACTIVE, { id: activePresetId });
}

async function loadPresets() {
  const data = await window.electronAPI.loadData(FILE_PRESETS);
  if (data) presets = data;
  const activeData = await window.electronAPI.loadData(FILE_ACTIVE);
  activePresetId = activeData ? activeData.id : null;
  if (!presets.find(p => p.id === activePresetId)) {
    activePresetId = presets.length > 0 ? presets[0].id : null;
  }
}

async function loadActivePreset() {
  pads = { sfx: [], mr: [] };
  selectedPadIndex = -1;
  lastPlayedIndex = -1;
  activeSection = 'mr';
  const preset = getActivePreset();
  if (!preset) {
    document.getElementById('preset-title').textContent = '울림';
    renderAllSections();
    return;
  }
  // Migrate old flat pads → sections
  if (!preset.sections && preset.pads) {
    preset.sections = { sfx: [], mr: preset.pads };
    delete preset.pads;
    savePresets();
  }
  document.getElementById('preset-title').textContent = preset.name;

  // Show loading state
  const totalCount = SECTIONS.reduce((sum, sec) => sum + (preset.sections[sec] || []).length, 0);
  if (totalCount > 0) {
    document.getElementById('preset-title').textContent = `${preset.name} — Loading...`;
  }
  renderAllSections();

  // Load one by one with UI updates between
  let loaded = 0;
  for (const sec of SECTIONS) {
    const items = preset.sections[sec] || [];
    for (const item of items) {
      try {
        const buffer = await loadAudioBuffer(item.filePath);
        pads[sec].push({
          id: 'pad-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
          filePath: item.filePath,
          name: item.name,
          volume: item.volume ?? 1.0,
          section: sec, buffer, duration: buffer.duration, source: null, gainNode: null,
        });
      } catch { /* file missing */ }
      loaded++;
      if (totalCount > 0) {
        document.getElementById('preset-title').textContent = `${preset.name} — Loading ${loaded}/${totalCount}`;
      }
      renderSection(sec);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  document.getElementById('preset-title').textContent = preset.name;
}

// --- Pad management ---

async function addPadToSection(section, filePath) {
  if (pads[section].find(p => p.filePath === filePath)) return;
  const libItem = library.find(l => l.filePath === filePath);
  const name = libItem ? libItem.name : filePath.split('/').pop();
  try {
    const buffer = await loadAudioBuffer(filePath);
    pads[section].push({
      id: 'pad-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
      filePath, name, volume: 1.0, section, buffer, duration: buffer.duration, source: null, gainNode: null,
    });
    renderSection(section);
    saveCurrentPresetPads();
  } catch (err) {
    console.error('Failed to load:', filePath, err);
  }
}

async function replacePadInSection(section, index, filePath) {
  const libItem = library.find(l => l.filePath === filePath);
  const name = libItem ? libItem.name : filePath.split('/').pop();
  try {
    const buffer = await loadAudioBuffer(filePath);
    stopPad(pads[section][index]);
    pads[section][index] = {
      id: 'pad-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
      filePath, name, volume: 1.0, section, buffer, duration: buffer.duration, source: null, gainNode: null,
    };
    renderSection(section);
    saveCurrentPresetPads();
  } catch (err) {
    console.error('Failed to load:', filePath, err);
  }
}

function removePadFromSection(section, padId) {
  const idx = pads[section].findIndex(p => p.id === padId);
  if (idx !== -1) {
    stopPad(pads[section][idx]);
    pads[section].splice(idx, 1);
    renderSection(section);
    saveCurrentPresetPads();
  }
}

// --- UI: Sidebar ---

function renderPresetList() {
  const ul = document.getElementById('preset-list');
  ul.innerHTML = '';
  presets.forEach(preset => {
    const li = document.createElement('li');
    li.className = preset.id === activePresetId ? 'active' : '';
    li.innerHTML = `
      <span class="preset-name">${escapeHtml(preset.name)}</span>
      <span class="preset-actions">
        <button class="btn-rename" title="Rename">R</button>
        <button class="btn-delete" title="Delete">&times;</button>
      </span>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.preset-actions')) return;
      switchPreset(preset.id);
    });
    li.querySelector('.btn-rename').addEventListener('click', (e) => {
      e.stopPropagation();
      showRenameModal(preset);
    });
    li.querySelector('.btn-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deletePreset(preset.id);
    });
    ul.appendChild(li);
  });
}

function renderLibrary() {
  const ul = document.getElementById('library-list');
  ul.innerHTML = '';
  library.forEach(item => {
    const li = document.createElement('li');
    li.draggable = true;
    li.innerHTML = `
      <span class="lib-item-name" title="${escapeHtml(item.filePath)}">${escapeHtml(item.name)}</span>
      <button class="lib-item-remove" title="Remove from library">&times;</button>
    `;
    li.querySelector('.lib-item-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromLibrary(item.filePath);
    });
    li.addEventListener('dblclick', () => {
      if (getActivePreset()) addPadToSection('sfx', item.filePath);
    });
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/ulrim-library', item.filePath);
      e.dataTransfer.effectAllowed = 'copy';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    ul.appendChild(li);
  });
}

// --- Drag and Drop ---

let dragSrcSection = null;
let dragSrcIndex = null;

function setupGridDrop(grid, section) {
  grid.addEventListener('dragover', (e) => {
    e.preventDefault();
    const isLib = e.dataTransfer.types.includes('application/ulrim-library');
    e.dataTransfer.dropEffect = isLib ? 'copy' : 'move';
    grid.classList.add('drag-target-active');
  });
  grid.addEventListener('dragleave', (e) => {
    if (!grid.contains(e.relatedTarget)) grid.classList.remove('drag-target-active');
  });
  grid.addEventListener('drop', (e) => {
    e.preventDefault();
    grid.classList.remove('drag-target-active');
    if (e.target.closest('.pad')) return; // handled by pad's handleDrop

    const libFp = e.dataTransfer.getData('application/ulrim-library');
    if (libFp && getActivePreset()) {
      addPadToSection(section, libFp);
      cleanupDrag();
      return;
    }

    // Pad dropped on empty area of another section → move to end
    if (dragSrcSection && dragSrcSection !== section && dragSrcIndex !== null) {
      const [moved] = pads[dragSrcSection].splice(dragSrcIndex, 1);
      moved.section = section;
      pads[section].push(moved);
      saveCurrentPresetPads();
      renderSection(dragSrcSection);
      renderSection(section);
    }
    cleanupDrag();
  });
}

function createPadDragHandlers(section) {
  return {
    handleDragStart(e) {
      const padEl = e.target.closest('.pad');
      if (!padEl) return;
      dragSrcSection = section;
      dragSrcIndex = [...padEl.parentNode.children].indexOf(padEl);
      padEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSrcIndex.toString());
    },
    handleDragOver(e) {
      e.preventDefault();
      const isLib = e.dataTransfer.types.includes('application/ulrim-library');
      e.dataTransfer.dropEffect = isLib ? 'copy' : 'move';
      const padEl = e.target.closest('.pad');
      if (padEl && !padEl.classList.contains('dragging')) {
        document.querySelectorAll('.pad.drag-over').forEach(el => el.classList.remove('drag-over'));
        padEl.classList.add('drag-over');
      }
    },
    handleDragLeave(e) {
      const padEl = e.target.closest('.pad');
      if (padEl) padEl.classList.remove('drag-over');
    },
    handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();

      // Library drop → replace
      const libFp = e.dataTransfer.getData('application/ulrim-library');
      if (libFp && getActivePreset()) {
        const padEl = e.target.closest('.pad');
        if (padEl) {
          const idx = [...padEl.parentNode.children].indexOf(padEl);
          replacePadInSection(section, idx, libFp);
        }
        cleanupDrag();
        return;
      }

      const padEl = e.target.closest('.pad');
      if (!padEl || dragSrcIndex === null) { cleanupDrag(); return; }
      const dropIndex = [...padEl.parentNode.children].indexOf(padEl);

      if (dragSrcSection === section) {
        // Reorder within same section
        if (dragSrcIndex !== dropIndex) {
          const temp = pads[section][dragSrcIndex];
          pads[section][dragSrcIndex] = pads[section][dropIndex];
          pads[section][dropIndex] = temp;
          saveCurrentPresetPads();
          renderSection(section);
        }
      } else if (dragSrcSection) {
        // Move from another section → insert at drop position
        const [moved] = pads[dragSrcSection].splice(dragSrcIndex, 1);
        moved.section = section;
        pads[section].splice(dropIndex, 0, moved);
        saveCurrentPresetPads();
        renderSection(dragSrcSection);
        renderSection(section);
      }
      cleanupDrag();
    },
    handleDragEnd() {
      cleanupDrag();
    },
  };
}

function cleanupDrag() {
  dragSrcSection = null;
  dragSrcIndex = null;
  document.querySelectorAll('.pad.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.pad.drag-over').forEach(el => el.classList.remove('drag-over'));
  document.querySelectorAll('.drag-target-active').forEach(el => el.classList.remove('drag-target-active'));
}

// --- UI: Pads ---

function renderAllSections() {
  for (const sec of SECTIONS) renderSection(sec);
}

function renderSection(section) {
  const grid = document.querySelector(`.pad-grid[data-section="${section}"]`);
  grid.innerHTML = '';

  const sectionPads = pads[section];
  const offset = section === 'mr' ? pads.sfx.length : 0;
  const handlers = createPadDragHandlers(section);

  sectionPads.forEach((pad, index) => {
    const globalIndex = offset + index;
    const el = document.createElement('div');
    el.className = 'pad' + (pad.source ? ' playing' : '') + (globalIndex === selectedPadIndex ? ' selected' : '');
    el.dataset.padId = pad.id;
    el.dataset.section = section;

    const shortcut = globalIndex < SHORTCUT_KEYS.length ? SHORTCUT_KEYS[globalIndex] : '';

    el.innerHTML = `
      <div class="drag-handle" title="Drag to reorder">&#x2630;</div>
      <button class="btn-remove" title="Remove">&times;</button>
      <div class="name">${escapeHtml(pad.name)}</div>
      <div class="time-display"></div>
      ${shortcut ? `<div class="shortcut">${shortcut.toUpperCase()}</div>` : ''}
      <input type="range" class="volume-slider" min="0" max="1" step="0.05" value="${pad.volume}" title="Volume">
    `;

    const handle = el.querySelector('.drag-handle');
    handle.addEventListener('mousedown', () => { el.draggable = true; });
    el.addEventListener('dragend', () => { el.draggable = false; });

    el.addEventListener('click', (e) => {
      if (e.target.closest('.btn-remove') || e.target.closest('.volume-slider')) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (pad.source) {
        stopPad(pad);
        updatePadUI(pad);
      } else {
        playSoundFromBuffer(pad);
      }
    });

    el.querySelector('.btn-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removePadFromSection(section, pad.id);
    });

    const slider = el.querySelector('.volume-slider');
    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      pad.volume = parseFloat(e.target.value);
      if (pad.gainNode) pad.gainNode.gain.value = pad.volume;
      saveCurrentPresetPads();
    });
    slider.addEventListener('click', (e) => e.stopPropagation());

    el.addEventListener('dragstart', handlers.handleDragStart);
    el.addEventListener('dragover', handlers.handleDragOver);
    el.addEventListener('dragleave', handlers.handleDragLeave);
    el.addEventListener('drop', handlers.handleDrop);
    el.addEventListener('dragend', handlers.handleDragEnd);

    grid.appendChild(el);
  });
}

function updateStopAllButton() {
  const isPlaying = allPads().some(p => p.source || (p.pausedAt != null && p.pausedAt > 0));
  document.getElementById('btn-stop-all').disabled = !isPlaying;
}

function updatePadUI(pad) {
  const el = document.querySelector(`[data-pad-id="${pad.id}"]`);
  if (!el) return;
  el.classList.toggle('playing', !!pad.source);
  updateStopAllButton();
}

function updateAllPadUI() {
  allPads().forEach(updatePadUI);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- Progress Update Loop ---

function updateProgress() {
  for (const pad of allPads()) {
    const el = document.querySelector(`[data-pad-id="${pad.id}"]`);
    if (!el) continue;
    const time = el.querySelector('.time-display');

    if (pad.pausedAt != null) {
      // Paused: show frozen progress
      const pct = Math.min(pad.pausedAt / pad.duration * 100, 100);
      el.style.background = `linear-gradient(to right, rgba(233,69,96,0.4) ${pct}%, #16213e ${pct}%)`;
      el.classList.add('playing');
      if (time) time.textContent = `${formatTime(pad.pausedAt)} / ${formatTime(pad.duration)}`;
      continue;
    }
    if (!pad.source || pad.startTime == null) {
      el.style.background = '';
      el.classList.remove('playing');
      if (time) time.textContent = formatTime(pad.duration);
      continue;
    }
    const elapsed = audioCtx.currentTime - pad.startTime;
    const pct = Math.min(elapsed / pad.duration * 100, 100);
    el.style.background = `linear-gradient(to right, rgba(233,69,96,0.6) ${pct}%, #16213e ${pct}%)`;
    if (time) time.textContent = `${formatTime(elapsed)} / ${formatTime(pad.duration)}`;
  }
  requestAnimationFrame(updateProgress);
}
requestAnimationFrame(updateProgress);

// --- Modals ---

function showRenameModal(preset) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Rename Preset</h2>
      <input type="text" id="rename-input" value="${escapeHtml(preset.name)}">
      <div class="modal-buttons">
        <button class="btn-cancel">Cancel</button>
        <button class="btn-confirm">Save</button>
      </div>
    </div>
  `;
  const input = overlay.querySelector('#rename-input');
  setTimeout(() => { input.focus(); input.select(); }, 50);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { renamePreset(preset.id, input.value.trim() || preset.name); overlay.remove(); }
    if (e.key === 'Escape') overlay.remove();
  });
  overlay.querySelector('.btn-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.btn-confirm').addEventListener('click', () => {
    renamePreset(preset.id, input.value.trim() || preset.name);
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function showNewPresetModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>New Preset</h2>
      <input type="text" id="new-preset-input" placeholder="Preset name">
      <div class="modal-buttons">
        <button class="btn-cancel">Cancel</button>
        <button class="btn-confirm">Create</button>
      </div>
    </div>
  `;
  const input = overlay.querySelector('#new-preset-input');
  setTimeout(() => input.focus(), 50);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { createPreset(input.value.trim()); overlay.remove(); }
    if (e.key === 'Escape') overlay.remove();
  });
  overlay.querySelector('.btn-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.btn-confirm').addEventListener('click', () => {
    createPreset(input.value.trim());
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// --- Keyboard Shortcuts ---

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.repeat) return;

  if (e.key === 'Escape') {
    stopAll();
    return;
  }

  const key = e.key.toLowerCase();
  const idx = SHORTCUT_KEYS.indexOf(key);
  const all = allPads();
  if (idx !== -1 && idx < all.length) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const pad = all[idx];
    if (pad.source) {
      stopPad(pad);
      updatePadUI(pad);
    } else {
      playSoundFromBuffer(pad);
    }
  }
});

// --- JX-11 Bluetooth Remote ---

let selectedPadIndex = -1;
let lastPlayedIndex = -1;
let activeSection = 'mr'; // which section the JX-11 navigates

function selectPad(index) {
  const all = allPads();
  if (all.length === 0) return;
  selectedPadIndex = Math.max(0, Math.min(index, all.length - 1));
  document.querySelectorAll('.pad').forEach((el, i) => {
    el.classList.toggle('selected', i === selectedPadIndex);
  });
}

if (window.electronAPI && window.electronAPI.onInputEvent) {
  window.electronAPI.onInputEvent((data) => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const all = allPads();

    if (data.type === 'jx11-button') {
      switch (data.key) {
        case 'play-pause':
        case 'volume-up':
        case 'volume-down': {
          if (all.length === 0) break;
          const selected = (selectedPadIndex >= 0 && selectedPadIndex < all.length)
            ? all[selectedPadIndex] : null;
          if (selected && selected.source) {
            stopPad(selected);
            updatePadUI(selected);
          } else if (selected) {
            // MR → stop other MRs only, SFX → just stop itself (handled in playSoundFromBuffer)
            playSoundFromBuffer(selected);
            lastPlayedIndex = selectedPadIndex;
          } else {
            selectPad(0);
            playSoundFromBuffer(all[0]);
            lastPlayedIndex = 0;
          }
          break;
        }
        case 'bottom-click': {
          toggleMRPause();
          break;
        }
        case 'left-click': {
          seekMR(-5);
          break;
        }
        case 'right-click': {
          seekMR(5);
          break;
        }
        case 'next-track': {
          const next = (lastPlayedIndex + 1) % all.length;
          if (all.length > 0) {
            stopAll();
            selectPad(next);
            playSoundFromBuffer(all[next]);
            lastPlayedIndex = next;
          }
          break;
        }
        case 'prev-track': {
          const prev = (lastPlayedIndex - 1 + all.length) % all.length;
          if (all.length > 0) {
            stopAll();
            selectPad(prev);
            playSoundFromBuffer(all[prev]);
            lastPlayedIndex = prev;
          }
          break;
        }
      }
    }

    if (data.type === 'jx11-wheel') {
      if (data.key === 'wheel-up') {
        selectPad((selectedPadIndex - 1 + all.length) % all.length);
      } else if (data.key === 'wheel-down') {
        selectPad((selectedPadIndex + 1) % all.length);
      }
    }
  });
}

// --- Init ---

// --- Titlebar ---

document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.windowMinimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.windowMaximize());
document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.windowClose());

// --- Init ---

document.getElementById('btn-add-library').addEventListener('click', async () => {
  const files = await window.electronAPI.selectSoundFiles();
  if (files.length > 0) addToLibrary(files);
});

document.getElementById('btn-new-preset').addEventListener('click', () => showNewPresetModal());
document.getElementById('btn-stop-all').addEventListener('click', stopAll);

// HID status
const hidStatusEl = document.getElementById('hid-status');
let currentHidStatus = 'disconnected';

hidStatusEl.addEventListener('click', () => {
  if (currentHidStatus === 'disconnected') {
    window.electronAPI.reconnectHid();
  }
});

if (window.electronAPI && window.electronAPI.onHidStatus) {
  window.electronAPI.onHidStatus((status) => {
    currentHidStatus = status;
    hidStatusEl.className = 'hid-status ' + status;
    hidStatusEl.style.cursor = status === 'disconnected' ? 'pointer' : 'default';
  });
}

// Setup drop targets for each section grid
for (const sec of SECTIONS) {
  const grid = document.querySelector(`.pad-grid[data-section="${sec}"]`);
  setupGridDrop(grid, sec);
}

// Migrate old data
function migrateOldData() {
  const oldPads = localStorage.getItem('oplayer-pads');
  if (oldPads && library.length === 0 && presets.length === 0) {
    const items = JSON.parse(oldPads);
    items.forEach(item => {
      if (!library.find(l => l.filePath === item.filePath)) {
        library.push({ filePath: item.filePath, name: item.name });
      }
    });
    saveLibrary();
    const preset = {
      id: 'preset-' + Date.now(),
      name: 'Default',
      sections: { sfx: [], mr: items.map(i => ({ filePath: i.filePath, name: i.name, volume: i.volume ?? 1.0 })) },
    };
    presets.push(preset);
    activePresetId = preset.id;
    savePresets();
    saveActivePresetId();
    localStorage.removeItem('oplayer-pads');
  }
}

async function init() {
  await loadLibrary();
  await loadPresets();
  migrateOldData();
  renderLibrary();
  renderPresetList();
  await loadActivePreset();
}

init();
