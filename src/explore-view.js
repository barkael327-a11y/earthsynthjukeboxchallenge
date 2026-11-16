/** Presentation only for the shared Earth listening experience.
 * No arrays, sonification contracts or audio measurement are computed here.
 */
const LAYERS = [
  {id:'ocean',label:'Ocean temperature',short:'Ocean',description:'Ocean surface · NASA picture'},
  {id:'air',label:'Nitrogen oxides',short:'Air',description:'NOx · NASA model · global'},
  {id:'wind',label:'Wind speed',short:'Wind',description:'Near-surface · NASA model · global'},
];

/**
 * @param {HTMLElement} root
 * @param {{onToggle:Function,onIsolate:Function,onPlay:Function,onSeek:Function,onMute:Function,onFocus:Function}} callbacks
 */
export function mountExploreView(root, callbacks) {
  root.classList.add('earth-explore');
  root.innerHTML = `
    <header class="ex-mast"><a class="ex-brand" href="#earth-experience">EarthSynth</a><span>THE FOURIER COLLECTIVE / NASA SPACE APPS</span></header>
    <div class="ex-opening"><p class="ex-eyebrow">A PLANET, IN HARMONY</p><h1>One Earth. <br><em>Many ways to listen.</em></h1><p>Follow the ocean’s warmth, the air above us, and the wind that connects them. Listen together, or follow a single thread.</p></div>
    <div class="ex-workspace">
      <section class="ex-visual" aria-labelledby="ex-visual-title">
        <div class="ex-visual-head"><h2 id="ex-visual-title">Ocean temperature</h2><label class="ex-focus">Show <select id="experience-focus" aria-label="Layer shown in the picture"><option value="ocean">Ocean temperature</option><option value="air">Nitrogen oxides</option><option value="wind">Wind speed</option></select></label></div>
        <div class="ex-canvas-wrap"><canvas id="experience-globe" aria-hidden="true"></canvas><span class="ex-view-kind">GLOBAL VIEW</span></div>
        <p class="ex-visual-note" id="ex-visual-note">Picture and sound follow the same values. Missing data stays silent.</p>
        <div class="ex-transport"><button type="button" class="ex-play" id="experience-play" aria-pressed="false">Start listening</button><button type="button" class="ex-mute" id="experience-mute" aria-pressed="false">Mute sound</button><span id="experience-position">Ready to explore</span></div>
        <label class="ex-scrub-label" for="experience-seek">Position in the shared sweep <span id="experience-step">1 / 1</span></label>
        <input id="experience-seek" class="ex-seek" type="range" min="0" max="0" value="0" step="1">
      </section>
      <aside class="ex-listening" aria-labelledby="ex-layer-title">
        <div class="ex-listening-head"><div><p class="ex-eyebrow">YOUR EARTH MIX</p><h2 id="ex-layer-title">Find your balance.</h2></div><button type="button" id="experience-together" class="ex-together">All together</button></div>
        <p class="ex-layer-help">Switch a layer on or off. Choose “Listen alone” to hear what it contributes.</p>
        <div class="ex-layers">${LAYERS.map(layer=>`
          <section class="ex-layer" data-layer="${layer.id}" aria-labelledby="ex-title-${layer.id}">
            <div class="ex-layer-heading"><label class="ex-switch"><input type="checkbox" data-toggle="${layer.id}" checked aria-label="Include ${layer.label.toLowerCase()} in the sound"><span aria-hidden="true"></span></label><div><h3 id="ex-title-${layer.id}">${layer.label}</h3><p>${layer.description}</p></div><button type="button" data-isolate="${layer.id}" class="ex-isolate" aria-label="Listen to ${layer.label.toLowerCase()} alone">Listen alone</button></div>
            <div class="ex-reading"><strong data-value="${layer.id}">—</strong><span data-units="${layer.id}"></span><span class="ex-layer-state" data-status="${layer.id}">Waiting for data</span></div>
            <p class="ex-accuracy"><span>Sound difference</span><span data-residual="${layer.id}">Not measuring yet</span></p>
          </section>`).join('')}
        </div>
        <details class="ex-explain"><summary>What does “sound difference” mean?</summary><p>We measure the generated tones to recover the value carried in the sound. The difference compares that recovered value with the value encoded from the picture. Smaller is closer. It does not measure the accuracy of NASA’s source data.</p></details>
      </aside>
    </div>
    <section class="ex-source-section"><details class="ex-sources"><summary>Behind this view · sources & coverage</summary><div id="experience-sources"></div></details><p class="ex-footer-note">NASA observations and models, heard with care.</p></section>
    <p class="ex-sr" id="experience-announcement" aria-live="polite" aria-atomic="true"></p>`;
  const find = selector => root.querySelector(selector);
  let current = {playing:false,muted:false,index:0,count:1,focus:'ocean',enabled:{ocean:true,air:true,wind:true},readings:[],sources:[]};
  const isEnabled = (id) => Array.isArray(current.enabled) ? current.enabled.includes(id) : current.enabled?.[id] !== false;
  find('.ex-canvas-wrap').before(find('.ex-transport'));
  find('#experience-play').addEventListener('click',()=>callbacks.onPlay?.());
  find('#experience-mute').addEventListener('click',()=>callbacks.onMute?.());
  find('#experience-seek').addEventListener('input',event=>callbacks.onSeek?.(Number(event.currentTarget.value)));
  find('#experience-focus').addEventListener('change',event=>callbacks.onFocus?.(event.currentTarget.value));
  root.querySelectorAll('[data-toggle]').forEach(input=>input.addEventListener('change',()=>callbacks.onToggle?.(input.dataset.toggle,input.checked)));
  root.querySelectorAll('[data-isolate]').forEach(button=>button.addEventListener('click',()=>callbacks.onIsolate?.(button.dataset.isolate)));
  find('#experience-together').addEventListener('click',()=>LAYERS.forEach(layer=>callbacks.onToggle?.(layer.id,true)));
  let sourceSignature = '';
  const formatValue = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US',{maximumFractionDigits:Math.abs(value)<0.1?3:2}).format(value) : value == null ? '—' : String(value);
  const formatResidual = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US',{maximumFractionDigits:4}).format(value) : value == null ? null : String(value);
  function update(state) {
    const before = current;
    current = {...current,...state};
    const play = find('#experience-play');
    const hasLayers=LAYERS.some(layer=>isEnabled(layer.id));
    play.textContent = current.playing ? 'Pause listening' : hasLayers ? 'Start listening' : 'Choose a layer';
    play.disabled=!current.playing&&!hasLayers;
    play.setAttribute('aria-pressed',String(current.playing));
    const mute = find('#experience-mute');
    mute.textContent = current.muted ? 'Unmute sound' : 'Mute sound';
    mute.setAttribute('aria-pressed',String(current.muted));
    const count = Math.max(1,Number(current.count)||1);
    const index = Math.max(0,Math.min(count-1,Number(current.index)||0));
    const seek = find('#experience-seek');
    seek.max = String(count-1);
    seek.value = String(index);
    seek.setAttribute('aria-valuetext',`Step ${Math.floor(index)+1} of ${count}`);
    find('#experience-step').textContent = `${Math.floor(index)+1} / ${count}`;
    find('#experience-position').textContent = !hasLayers ? 'No layers selected · sound off' : current.muted ? (current.playing ? 'Sound muted · measurement continues' : 'Sound muted') : current.playing ? 'Listening to Earth' : index ? 'Paused · keep exploring' : 'Ready to explore';
    const focus = LAYERS.find(layer=>layer.id===current.focus) || LAYERS[0];
    find('#experience-focus').value = focus.id;
    find('#ex-visual-title').textContent = current.title || focus.label;
    find('.ex-view-kind').textContent = current.visualMode === 'map' ? 'GLOBAL PICTURE' : 'GLOBAL VIEW';
    find('#ex-visual-note').textContent = current.visualNote || 'Picture and sound follow the same values. Missing data stays silent.';
    for(const layer of LAYERS) {
      const enabled = isEnabled(layer.id);
      const row = find(`[data-layer="${layer.id}"]`);
      row.classList.toggle('ex-layer-off',!enabled);
      find(`[data-toggle="${layer.id}"]`).checked = enabled;
      const reading = current.readings?.find(item=>item.id===layer.id);
      find(`[data-value="${layer.id}"]`).textContent = reading?.observed === false ? '—' : formatValue(reading?.value);
      find(`[data-units="${layer.id}"]`).textContent = reading?.units || '';
      const coverage = typeof reading?.coverage === 'number' && Number.isFinite(reading.coverage) ? `${Math.round(reading.coverage<=1?reading.coverage*100:reading.coverage)}% coverage` : '';
      find(`[data-status="${layer.id}"]`).textContent = !enabled ? 'Layer off' : !reading ? 'Waiting for data' : reading.observed === false ? 'No usable data · silent' : coverage || 'In the mix';
      const residual = formatResidual(reading?.residual);
      find(`[data-residual="${layer.id}"]`).textContent = residual === null ? (reading?.measurementState === 'settling' ? 'Settling…' : reading?.measurementState === 'paused' ? 'Press play to measure' : reading?.measurementState === 'no-observation' ? 'No usable data' : 'Not measuring yet') : `${residual}${reading?.units?' '+reading.units:''}`;
      const isolated = enabled && LAYERS.every(other=>other.id===layer.id || !isEnabled(other.id));
      const isolate = find(`[data-isolate="${layer.id}"]`);
      isolate.setAttribute('aria-pressed',String(isolated));
      isolate.textContent = isolated ? 'Listening alone' : 'Listen alone';
    }
    const signature = JSON.stringify(current.sources || []);
    if(signature!==sourceSignature){
      sourceSignature=signature;
      const box=find('#experience-sources');box.replaceChildren();
      for(const source of current.sources || []) {
        const item=document.createElement('p');
        const label=source.label || source.title || source.name || 'NASA source';
        let url;
        try{url=new URL(source.url || source.href);if(url.protocol!=='https:')url=null;}catch{url=null;}
        if(url){const link=document.createElement('a');link.href=url.href;link.textContent=label;link.target='_blank';link.rel='noopener noreferrer';item.append(link);}else{item.textContent=label;}
        const detail=source.note || source.description || source.coverage || '';
        if(detail)item.append(document.createTextNode(` · ${detail}`));
        box.append(item);
      }
    }
    if(before.muted!==current.muted || before.playing!==current.playing || before.focus!==current.focus){
      find('#experience-announcement').textContent = `${current.muted?'Sound muted. ':''}${current.playing?'Playback continues. ':'Playback paused. '}Showing ${focus.label.toLowerCase()}.`;
    }
  }
  update(current);
  return {update,canvas:find('#experience-globe'),destroy(){root.replaceChildren();root.classList.remove('earth-explore');}};
}
