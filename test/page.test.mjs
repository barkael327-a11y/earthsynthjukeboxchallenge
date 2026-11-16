/** Integration checks for the shipped combined Earth listening experience.
 * Canvas and Web Audio are stubbed, but real modules, payloads and DOM events run.
 * Scientific audio behavior has separate scheduling and measurement tests.
 */
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** A 2D context that records nothing and refuses nothing. */
function fakeCanvas2D() {
  const noop = () => {};
  return new Proxy({
    canvas: { width: 600, height: 300 },
    measureText: () => ({ width: 40 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
    setTransform: noop,
  }, {
    get: (target, prop) => (prop in target ? target[prop] : noop),
    set: () => true,
  });
}

class FakeParam {
  constructor(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) {
    if (!(v > 0)) throw new RangeError('exponential ramp to a non-positive value');
    this.value = v; return this;
  }
  setTargetAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
const audioNode = (extra = {}) => ({ connect() {}, disconnect() {}, ...extra });

class FakeAudioContext {
  constructor() {
    this.currentTime = 0; this.sampleRate = 48000;
    this.state = 'suspended'; this.destination = audioNode();
  }
  async resume() { this.state = 'running'; }
  createGain() { return audioNode({ gain: new FakeParam(1) }); }
  createOscillator() {
    return audioNode({
      frequency: new FakeParam(440), detune: new FakeParam(0),
      type: 'sine', start() {}, stop() {}, setPeriodicWave() {},
    });
  }
  createBiquadFilter() { return audioNode({ frequency: new FakeParam(350), Q: new FakeParam(1), gain: new FakeParam(0), type: 'lowpass' }); }
  createBufferSource() { return audioNode({ buffer: null, loop: false, start() {}, stop() {} }); }
  createAnalyser() {
    return audioNode({
      fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0, context: this,
      // Two partials, at the bins 220 Hz and 880 Hz land on for a 48 kHz
      // 8192-point analysis, so the validator finds a real ratio.
      getFloatFrequencyData(a) {
        a.fill(-150);
        for (let k = 34; k <= 42; k++) a[k] = -30;
        for (let k = 146; k <= 154; k++) a[k] = -22;
      },
    });
  }
  createBuffer(ch, len) { return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) }; }
  createDelay() { return audioNode({ delayTime: new FakeParam(0.5) }); }
  createStereoPanner() { return audioNode({ pan: new FakeParam(0) }); }
  createWaveShaper() { return audioNode({ curve: null, oversample: 'none' }); }
  createConvolver() { return audioNode({ buffer: null, normalize: true }); }
  createPeriodicWave() { return {}; }
}

/** Serve the repo's own files to the page's fetch(). */
function fileFetch() {
  return async (url) => {
    const path = join(ROOT, String(url).replace(/^\.\//, ''));
    const body = await readFile(path);
    return {
      ok: true, status: 200,
      json: async () => JSON.parse(body.toString('utf8')),
      text: async () => body.toString('utf8'),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

async function openExperience() {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {url:'https://example.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const {window} = dom;
  const errors=[];
  window.addEventListener('error',event=>errors.push(event.message));
  window.HTMLCanvasElement.prototype.getContext=fakeCanvas2D;
  window.HTMLCanvasElement.prototype.getBoundingClientRect=()=>({width:240,height:180,left:0,top:0,right:240,bottom:180});
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  window.AudioContext=FakeAudioContext;
  window.fetch=fileFetch();
  window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
  const frames=[];
  window.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
  window.cancelAnimationFrame=()=>{};
  const saved=new Map();
  const replacements={document:window.document,window,fetch:window.fetch,AudioContext:FakeAudioContext,
    requestAnimationFrame:window.requestAnimationFrame,cancelAnimationFrame:window.cancelAnimationFrame,
    matchMedia:window.matchMedia,devicePixelRatio:1,getComputedStyle:window.getComputedStyle.bind(window),
    Path2D:class{moveTo(){}lineTo(){}}};
  for(const [name,value] of Object.entries(replacements)){saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});}
  function restore(){for(const [name,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}window.close();}
  try{
    await import('../src/explore-app.js?integration='+Date.now());
    for(let i=0;i<150 && !window.document.getElementById('experience-legend') && !window.document.getElementById('experience-error');i++)await new Promise(resolve=>setTimeout(resolve,10));
    const banner=window.document.getElementById('experience-error');
    assert.equal(banner,null,banner?.textContent);
    assert.ok(window.document.getElementById('experience-legend'),'experience did not finish loading real source payloads');
    return {document:window.document,window,errors,pump(){for(const callback of frames.splice(0))callback(performance.now());},restore};
  }catch(error){restore();throw error;}
}

test('the shipped shell has one accessible experience and every local asset/module resolves',async()=>{
  const html=await readFile(join(ROOT,'index.html'),'utf8');
  const dom=new JSDOM(html);
  try{
    const document=dom.window.document;
    assert.equal(document.querySelectorAll('main').length,1);
    assert.ok(document.querySelector('main#earth-experience[aria-label] [role="status"]'));
    assert.equal(document.querySelectorAll('script[type="module"]').length,1);
    assert.equal(document.querySelector('script[type="module"]').getAttribute('src'),'./src/explore-app.js');
    assert.ok(document.querySelector('meta[name="ai-assistance"]'));
    const locals=[...document.querySelectorAll('script[src],link[href]')].map(e=>e.getAttribute('src')||e.getAttribute('href')).filter(url=>url.startsWith('./'));
    for(const url of locals)await access(join(ROOT,url));
    const seen=new Set();
    async function visit(path){
      path=resolve(path);if(seen.has(path))return;seen.add(path);
      const source=await readFile(path,'utf8');
      for(const match of source.matchAll(/^\s*import\s+(?:[^'"\n]*?\s+from\s*)?['"]([^'"]+)['"]/gm)){
        assert.ok(match[1].startsWith('.'),'browser modules must resolve without a build step');
        await visit(resolve(dirname(path),match[1]));
      }
    }
    await visit(join(ROOT,'src/explore-app.js'));
    assert.ok(seen.has(resolve(ROOT,'src/layer-session.js')),'entry must load the measured shared session');
    assert.ok(seen.has(resolve(ROOT,'src/cinematic-view.js')),'entry must load the cinematic view');
  }finally{dom.window.close();}
});

test('the real combined controller loads sources and wires isolation, mute, seek and cinematic layers',async()=>{
  const page=await openExperience();
  const {document,window}=page;
  const find=selector=>{const el=document.querySelector(selector);assert.ok(el,`missing ${selector}`);return el;};
  const change=el=>el.dispatchEvent(new window.Event('change',{bubbles:true}));
  try{
    page.pump();
    assert.equal(document.querySelectorAll('.ex-layer').length,3);
    for(const id of ['ocean','air','wind']){
      assert.notEqual(find(`[data-value="${id}"]`).textContent,'—',`${id} source did not produce an initial reading`);
      assert.ok(find(`[data-units="${id}"]`).textContent);
      assert.equal(find(`[data-toggle="${id}"]`).checked,true);
    }
    assert.equal(document.querySelectorAll('#experience-sources a').length,3);
    for(const link of document.querySelectorAll('#experience-sources a'))assert.match(link.href,/^https:\/\/svs\.gsfc\.nasa\.gov\//);
    find('[data-isolate="air"]').click();
    assert.equal(find('[data-toggle="ocean"]').checked,false);
    assert.equal(find('[data-toggle="air"]').checked,true);
    assert.equal(find('[data-toggle="wind"]').checked,false);
    assert.equal(find('#experience-focus').value,'air');
    assert.match(find('#ex-visual-title').textContent,/air|nitrogen/i);
    find('#experience-together').click();
    assert.equal([...document.querySelectorAll('[data-toggle]')].filter(el=>el.checked).length,3);
    find('#experience-mute').click();
    assert.equal(find('#experience-mute').getAttribute('aria-pressed'),'true');
    find('#experience-play').click();
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(find('#experience-play').getAttribute('aria-pressed'),'true');
    assert.equal(find('#experience-mute').getAttribute('aria-pressed'),'true','starting playback must preserve mute');
    const seek=find('#experience-seek');seek.value='44';seek.dispatchEvent(new window.Event('input',{bubbles:true}));
    assert.match(find('#experience-step').textContent,/45\s*\/\s*90/);
    find('#experience-play').click();
    assert.equal(find('#experience-play').getAttribute('aria-pressed'),'false');
    find('#experience-focus').value='wind';change(find('#experience-focus'));
    assert.match(find('#experience-chart-description').textContent,/wind/i);
    assert.match(find('#experience-chart-description').textContent,/picture row/,'wind must retain image-row coordinates');
    assert.match(find('.experience-method').textContent,/wind stays in image coordinates/i);
    find('.experience-cinema-entry').click();
    const dialog=find('dialog');assert.equal(dialog.open,true);
    assert.ok(find('.cinema-image').getAttribute('src'));
    assert.match(find('.cinema-image-note').textContent,/illustrative/i);
    assert.equal(find('.cinema-mute').getAttribute('aria-pressed'),'true');
    const cinemaWind=find('[data-cinema-layer="wind"]');cinemaWind.checked=false;change(cinemaWind);
    assert.equal(find('[data-toggle="wind"]').checked,false,'cinematic controls must use the same session');
    find('.cinema-exit').click();assert.equal(dialog.open,false);
    assert.deepEqual(page.errors,[]);
  }finally{
    // Close any running session before restoring global browser shims.
    const play=document.getElementById('experience-play');
    if(play?.getAttribute('aria-pressed')==='true')play.click();
    page.restore();
  }
});
