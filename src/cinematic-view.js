/** Cinematic presentation synchronized to the instrument's shared sweep.
 * Photographs illustrate a theme; they never pretend to be the measured field.
 */
export function createCinematicView({
  onTogglePlay, onMute, onEnabledChange, onExit
}
= {
}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'earth-cinema';
  dialog.setAttribute('aria-label', 'EarthSynth cinematic listening');
  dialog.setAttribute('tabindex', '-1');
  dialog.innerHTML = `
    <img class="cinema-image" alt="">
    <img class="cinema-image-previous" alt="" aria-hidden="true">
    <div class="cinema-top"><span class="cinema-brand">EarthSynth <small>LISTENING ROOM</small></span><button type="button" class="cinema-exit" aria-label="Exit cinematic listening">Exit</button></div>
    <div class="cinema-caption"><p class="cinema-kicker">OUR PLANET, IN HARMONY</p><h2 class="cinema-title">A closer listen.</h2><p class="cinema-subtitle"></p></div>
    <div class="cinema-bottom">
      <div class="cinema-controls" role="group" aria-label="Listening controls"><button type="button" class="cinema-play" autofocus>Start listening</button><button type="button" class="cinema-mute" aria-pressed="false">Mute sound</button><button type="button" class="cinema-layers-toggle" aria-expanded="false" aria-controls="cinema-layer-panel">Layers</button><button type="button" class="cinema-about-toggle" aria-expanded="false" aria-controls="cinema-about-panel">About this scene</button></div>
      <div class="cinema-panels">
        <section class="cinema-layer-panel" id="cinema-layer-panel" hidden aria-label="Sound layers"><h3>Choose your Earth mix</h3><p>Listen together, or leave one layer on to follow it alone.</p><div class="cinema-layer-options">${[['ocean','Ocean'],['air','Air'],['wind','Wind']].map(([id,label])=>`<label><input type="checkbox" data-cinema-layer="${id}" checked><span>${label}</span></label>`).join('')}</div></section>
        <section class="cinema-about-panel" id="cinema-about-panel" hidden aria-label="About this scene"><h3 class="cinema-about-title"></h3><p class="cinema-description"></p><p class="cinema-image-note">Illustrative NASA imagery. The picture sets the scene; the measured sound comes from the instrument’s data layers.</p><p class="cinema-attribution"></p></section>
      </div>
      <p class="cinema-hint">Move your pointer or press Tab to show controls.</p>
      <p class="cinema-spoken-summary" aria-live="polite" aria-atomic="true"></p>
    </div>`;
  const query = selector => dialog.querySelector(selector);
  let scenes = [];
  let cinemaState = {
    playing: false,
    muted: false,
    enabled: { ocean: true, air: true, wind: true },
    focus: 'ocean',
    index: 0
  };
  let previousFocus = null;
  let controlsHideTimer = null;
  let displayedSceneId = null;
  let destroyed = false;
  let keyboardMode = false;
  const selectedLayerIds = () => Array.isArray(cinemaState.enabled)
    ? cinemaState.enabled
    : ['ocean', 'air', 'wind'].filter(id => cinemaState.enabled?.[id] !== false);
  function isPanelOpen(){
    return !query('#cinema-layer-panel').hidden || !query('#cinema-about-panel').hidden;
  }
  function reveal(){
    dialog.classList.remove('cinema-controls-hidden');
    clearTimeout(controlsHideTimer);
    if (!dialog.open || !cinemaState.playing || isPanelOpen())return;
    controlsHideTimer = setTimeout(() => {
      // Never hide a focused control or an expanded panel from keyboard users.
      if (!keyboardMode || !dialog.contains(document.activeElement) || document.activeElement === dialog){
        if (!isPanelOpen())dialog.classList.add('cinema-controls-hidden');
      }
    }, 3400);
  }
  function close(){
    clearTimeout(controlsHideTimer);
    dialog.classList.remove('cinema-controls-hidden');
    if (dialog.open)dialog.close();
    if (previousFocus?.isConnected)previousFocus.focus();
  }
  function exit(){
    close();
    onExit?.();
  }
  query('.cinema-exit').addEventListener('click', exit);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    exit();
  });
  query('.cinema-play').addEventListener('click', () => {
    onTogglePlay?.();
    reveal();
  });
  query('.cinema-mute').addEventListener('click', () => {
    onMute?.();
    reveal();
  });
  function togglePanel(buttonSelector, panelSelector, otherButton, otherPanel){
    const button = query(buttonSelector);
    const panel = query(panelSelector);
    button.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      query(otherPanel).hidden = true;
      query(otherButton).setAttribute('aria-expanded', 'false');
      reveal();
    });
  }
  togglePanel('.cinema-layers-toggle', '#cinema-layer-panel', '.cinema-about-toggle', '#cinema-about-panel');
  togglePanel('.cinema-about-toggle', '#cinema-about-panel', '.cinema-layers-toggle', '#cinema-layer-panel');
  dialog.querySelectorAll('[data-cinema-layer]').forEach(input => input.addEventListener('change', () => {
    const enabled = {
    };
    dialog.querySelectorAll('[data-cinema-layer]').forEach(control => {
      enabled[control.dataset.cinemaLayer] = control.checked;
    });
    cinemaState = {
      ...cinemaState, enabled
    };
    onEnabledChange?.(enabled);
    updateScene();
    reveal();
  }));
  dialog.addEventListener('pointermove', reveal);
  dialog.addEventListener('pointerdown', () => {
    keyboardMode = false;
    reveal();
  });
  dialog.addEventListener('keydown', () => {
    keyboardMode = true;
    reveal();
  });
  dialog.addEventListener('focusin', reveal);
  dialog.addEventListener('focusout', () => setTimeout(reveal, 0));
  function themeOf(scene){
    return scene.layer || scene.theme || ['ocean', 'air', 'wind'].find(id => String(scene.id).includes(id));
  }
  function showScene(scene){
    if (!scene || displayedSceneId === scene.id)return;
    displayedSceneId = scene.id;
    const image = query('.cinema-image');
    const previous = query('.cinema-image-previous');
    const hadScene = Boolean(image.getAttribute('src'));
    if (hadScene){
      previous.src = image.src;
      previous.style.transform = getComputedStyle(image).transform;
      previous.classList.add('cinema-fading');
    }
    image.onload = () => {
      requestAnimationFrame(() => previous.classList.remove('cinema-fading'));
    };
    image.onerror = () => previous.classList.remove('cinema-fading');
    image.src = scene.image;
    image.alt = scene.description || scene.title || 'NASA view of Earth';
    // Restart only at a shared phrase boundary, never with an independent timer.
    image.classList.remove('cinema-drift');
    void image.offsetWidth;
    image.classList.add('cinema-drift');
    query('.cinema-title').textContent = scene.title || 'A closer listen.';
    query('.cinema-subtitle').textContent = scene.subtitle || '';
    query('.cinema-about-title').textContent = scene.title || 'About this scene';
    query('.cinema-description').textContent = scene.description || '';
    query('.cinema-image-note').textContent = scene.illustrative === false
    ? 'This scene shows the source frame. Sound accuracy is available in the instrument view.'
    : 'Illustrative NASA imagery. The picture sets the scene; the measured sound comes from the instrument’s data layers.';
    const credit = query('.cinema-attribution');
    credit.replaceChildren();
    credit.append(document.createTextNode(scene.credit || 'NASA'));
    let url;
    try{
      url = new URL(scene.sourceUrl);
      if (url.protocol !== 'https:')url = null;
    } catch{
      url = null;
    }
    if (url){
      const link = document.createElement('a');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'View NASA source';
      credit.append(document.createTextNode(' · '), link);
    }
  }
  function updateScene(){
    if (!scenes.length)return;
    if (cinemaState.scene){
      showScene(typeof cinemaState.scene === 'object'?cinemaState.scene: scenes.find(scene => scene.id === cinemaState.scene));
      return;
    }
    const layers = selectedLayerIds();
    const themes = layers.length?layers: [cinemaState.focus || 'ocean'];
    const phrase = Math.floor(Math.max(0, Number(cinemaState.index) || 0)/32);
    const theme = themes[phrase%themes.length];
    const candidates = scenes.filter(scene => themeOf(scene) === theme);
    const pool = candidates.length?candidates: scenes;
    const cycle = Math.floor(phrase/themes.length);
    showScene(pool[cycle%pool.length]);
  }
  function update(next = {
  }){
    cinemaState = {
      ...cinemaState, ...next
    };
    if (Object.hasOwn(next, 'spokenSummary'))query('.cinema-spoken-summary').textContent = next.spokenSummary || '';
    query('.cinema-play').textContent = cinemaState.playing?'Pause listening': 'Start listening';
    query('.cinema-play').setAttribute('aria-label', cinemaState.playing?'Pause listening': 'Start listening');
    query('.cinema-mute').textContent = cinemaState.muted?'Unmute sound': 'Mute sound';
    query('.cinema-mute').setAttribute('aria-pressed', String(cinemaState.muted));
    const layers = selectedLayerIds();
    dialog.querySelectorAll('[data-cinema-layer]').forEach(input => {
      input.checked = layers.includes(input.dataset.cinemaLayer);
    });
    dialog.classList.toggle('cinema-paused', !cinemaState.playing);
    updateScene();
    if (!cinemaState.playing)reveal();
  }
  function open(){
    if (destroyed)return;
    previousFocus = document.activeElement;
    if (!dialog.isConnected)document.body.append(dialog);
    if (!dialog.open)dialog.showModal();
    updateScene();
    reveal();
  }
  function setScenes(next){
    scenes = Array.isArray(next)?next.filter(scene => scene?.image): [];
    displayedSceneId = null;
    updateScene();
  }
  function destroy(){
    destroyed = true;
    close();
    dialog.remove();
  }
  return {
    element: dialog, open, close, update, setScenes, destroy
  };
}
