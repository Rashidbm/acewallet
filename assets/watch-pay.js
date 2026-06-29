import * as THREE from "./vendor/three/build/three.module.js";
import { GLTFLoader } from "./vendor/three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "./vendor/three/examples/jsm/loaders/DRACOLoader.js";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Touch / small-viewport devices get a lighter render path: a half-res screen texture redrawn at
// 30fps instead of a 1024² one re-uploaded at 60fps (~8x less per-frame GPU/raster work). Invisible
// at phone size, but it's what was making the scene heavy on mobile Safari. No 3D quality is lost.
const lowPower = window.matchMedia("(pointer: coarse)").matches
              || window.matchMedia("(max-width: 960px)").matches;
const stage = document.querySelector(".aw-stage") || document.querySelector(".stage");

// --- interactivity: cursor parallax + optional scroll-scrubbed playback ---------------
let pointerTX = 0, pointerTY = 0;   // pointer target (normalised -1..1 over the stage)
let paraX = 0, paraY = 0;           // smoothed parallax
let lastNow = 0;                    // for frame-rate-independent smoothing
let scrubTime = 0;                  // smoothed scroll-driven time
let scrollProgress = null;          // null = auto-loop; 0..1 = scroll-scrubbed
let onScreen = true;                // pause the loop when the stage is off-screen (perf)
const loading = document.getElementById("loading");
const phaseText = document.getElementById("phaseText");
const replayButton = document.getElementById("replayButton");

const renderer = new THREE.WebGLRenderer({
  antialias:true,
  alpha:true,
  powerPreference:"high-performance",
  preserveDrawingBuffer:true
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(stage.clientWidth, stage.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x060709, 0.02);

// --- Neutral studio environment (IBL) --------------------------------------------------
// Metals need something to REFLECT or they read as flat plastic. Build a soft studio
// equirectangular gradient + a few softbox highlights and PMREM it into scene.environment.
// (This is exactly what model-viewer's environment-image="neutral" gives the live watch.)
{
  const ec = document.createElement("canvas");
  ec.width = 1024; ec.height = 512;
  const ex = ec.getContext("2d");
  const g = ex.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0.00, "#ffffff");
  g.addColorStop(0.30, "#e9eef3");
  g.addColorStop(0.52, "#bcc5cd");
  g.addColorStop(0.72, "#6b737a");
  g.addColorStop(1.00, "#2d3338");
  ex.fillStyle = g; ex.fillRect(0, 0, 1024, 512);
  const softbox = (cx, cy, r, sy, a) => {
    const rg = ex.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, "rgba(255,255,255," + a + ")");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    ex.save(); ex.translate(cx, cy); ex.scale(1, sy); ex.translate(-cx, -cy);
    ex.fillStyle = rg; ex.beginPath(); ex.arc(cx, cy, r, 0, Math.PI * 2); ex.fill(); ex.restore();
  };
  softbox(340, 120, 250, .55, .95);   // big overhead softbox
  softbox(770, 150, 190, .6, .7);     // upper-right fill
  softbox(150, 320, 170, 1.3, .4);    // left side light
  const etex = new THREE.CanvasTexture(ec);
  etex.mapping = THREE.EquirectangularReflectionMapping;
  etex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromEquirectangular(etex).texture;
  etex.dispose(); pmrem.dispose();
}

const camera = new THREE.PerspectiveCamera(29, stage.clientWidth / stage.clientHeight, 0.05, 100);
camera.position.set(0, 0.08, 7.2);
camera.lookAt(0, 0.02, 0);

// The studio ENVIRONMENT does the heavy lifting now (soft reflections + fill). The lights
// just add a crisp key highlight, a cool rim, and a subtle emerald brand edge.
const ambient = new THREE.HemisphereLight(0xe6eef8, 0x0b0e12, 0.5);
scene.add(ambient);

const key = new THREE.DirectionalLight(0xfff6ec, 3.0);
key.position.set(4.2, 5.0, 4.8);
scene.add(key);

const rim = new THREE.DirectionalLight(0x86b4ff, 1.7);
rim.position.set(-4.8, 1.4, 2.6);
scene.add(rim);

// emerald brand accent grazing from the lower-left — a subtle green edge on the titanium
const accent = new THREE.DirectionalLight(0x2bd17e, 1.5);
accent.position.set(-3.0, -2.2, 3.4);
scene.add(accent);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(3.9, 96),
  new THREE.MeshBasicMaterial({
    color:0x1dd678,
    transparent:true,
    opacity:.055,
    depthWrite:false
  })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -1.94;
floor.scale.y = .34;
scene.add(floor);

const watchShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(2.9, .9),
  new THREE.MeshBasicMaterial({
    map:softShadowTexture(),
    color:0x000000,
    transparent:true,
    opacity:.18,
    depthWrite:false
  })
);
watchShadow.rotation.x = -Math.PI / 2;
watchShadow.position.y = -1.875;
watchShadow.renderOrder = -2;
scene.add(watchShadow);

const readerShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(1.7, .62),
  new THREE.MeshBasicMaterial({
    map:softShadowTexture(),
    color:0x000000,
    transparent:true,
    opacity:0,
    depthWrite:false
  })
);
readerShadow.rotation.x = -Math.PI / 2;
readerShadow.position.y = -1.872;
readerShadow.renderOrder = -1;
scene.add(readerShadow);

const watchRig = new THREE.Group();
const readerRig = new THREE.Group();
scene.add(watchRig, readerRig);

let watchModel;
let screenMaterials = [];
let readerMesh;
let readerFace;
let readerGlow;
let readerContactLight;
let screenCanvas;
let screenCtx;
let screenTexture;
let currentScreen = "";
let lastScreenFrame = -1;
let startTime = performance.now();
let ready = false;
let lastPhase = "";
let layout = {
  objectScale:1,
  xScale:1,
  readerX:-.36,
  readerStartX:-2.5,
  readerScale:.82,
  cameraZ:0,
  fov:0
};

const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin("");
const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("./assets/vendor/three/examples/jsm/libs/draco/");
gltfLoader.setDRACOLoader(dracoLoader);
const textures = {};
const cardImages = {};
const cardBlur = {};            // pre-blurred copies for dimmed neighbour cards (no per-frame blur cost)
let contactlessIcon = null;     // the real EMV contactless mark (assets/contactless.webp)
const CARD_ASSETS = {
  cashplus:"cards/alrajhi-cashback-plus.png",
  cashback:"cards/sab-cashback.png",
  mazeed:"cards/enbd-mazeed-platinum.png",
  snbpremium:"cards/snb-alahli-premium.png",
  marriott:"cards/alrajhi-marriott.png",
  alfursan:"cards/alfursan-alinma.png",
  saib:"cards/saib-travel.png"
};
const REWARD_SCENES = [
  {
    id:"food",
    label:"Food delivery",
    icon:"Delivery",
    best:"cashplus",
    reward:"+15%",
    unit:"cashback",
    compared:[
      ["cashplus", "+15%", "Alrajhi"],
      ["mazeed", "10%", "ENBD"],
      ["cashback", "10%", "SAB"],
      ["snbpremium", "5%", "SNB"]
    ]
  },
  {
    id:"grocery",
    label:"Groceries",
    icon:"Market",
    best:"cashback",
    reward:"10%",
    unit:"cashback",
    compared:[
      ["cashback", "10%", "SAB"],
      ["mazeed", "5%", "ENBD"],
      ["cashplus", "1%", "Alrajhi"],
      ["snbpremium", "5%", "SNB"]
    ]
  },
  {
    id:"flights",
    label:"Flights",
    icon:"Travel",
    best:"alfursan",
    reward:"1mi/﷼1",
    unit:"miles",
    compared:[
      ["alfursan", "1mi", "Alinma"],
      ["cashback", "1%", "SAB"],
      ["marriott", "0x", "Marriott"],
      ["saib", "0%", "SAIB"]
    ]
  },
  {
    id:"hotels",
    label:"Hotels",
    icon:"Stay",
    best:"marriott",
    reward:"6x",
    unit:"points",
    compared:[
      ["marriott", "6x", "Marriott"],
      ["cashback", "1%", "SAB"],
      ["cashplus", "1%", "Alrajhi"],
      ["alfursan", "0x", "Alinma"]
    ]
  }
];
// One deliberate, slow-paced timeline (seconds). Every transition is named so the motion
// always knows what it is transitioning between — and has room to breathe (premium pacing).
const TL = {
  revealEnd:   1.3,   // cards slide in, all SHARP (no decision yet)
  chooseStart: 1.5,   // Ace starts comparing
  chooseEnd:   3.7,   // lands on the best card → focus sharpens, the rest blur + dim
  holdCard:    4.6,   // sit on the chosen card a beat
  turnStart:   4.6,
  turnEnd:     7.3,   // slow, deliberate turn to the reader
  tap:         7.3,   // face meets the reader
  pressEnd:    8.3,   // press + HOLD (emerald bloom swells) — the payment beat
  flipStart:   8.3,
  doneShown:   9.1,   // ✓ Done resolves on screen as it flips back into view
  flipEnd:     10.3,  // settled front, facing you, showing Done
  doneHold:    12.0,  // hold on Done
  resetStart:  12.0
};
const duration = 13.6;   // full loop
const debugTimeParam = new URLSearchParams(location.search).get("t");
const frozenQueryTime = debugTimeParam == null ? NaN : Number(debugTimeParam);

function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function mix(a, b, t){ return a + (b - a) * t; }
function mixVec(a, b, t){ return a.map((v, i) => mix(v, b[i], t)); }
function easeOutQuint(t){ t = clamp01(t); return 1 - Math.pow(1 - t, 5); }
function easeOutCubic(t){ t = clamp01(t); return 1 - Math.pow(1 - t, 3); }
function easeInOutCubic(t){
  t = clamp01(t);
  return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function smoother(t){
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function easeOutBack(t){ t = clamp01(t); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
function between(t, a, b){ return clamp01((t - a) / (b - a)); }

const frontState = {
  pos:[.12, -.02, .02],
  rot:[.58, -.035, 0],
  scale:.76,
  camera:[0, .08, 7.28],
  fov:30,
  look:[.08, .03, 0]
};
const readerState = {
  pos:[0, -.13, -1.56],         // flies further back to the reader, sits a touch lower
  rot:[-.2, Math.PI, 0],        // back-to-camera, face angled a bit DOWNWARD onto the reader (natural wrist-tap tilt)
  scale:.44,                    // smaller → reads as travelling further into the scene
  camera:[0, -.08, 7.5],
  fov:31,
  look:[0, -.11, 0]             // camera looks straight at the lowered tap watch (x=0) → no left/right skew
};
const doneState = {
  pos:[.12, -.02, .02],
  rot:[.58, -.035, 0],
  scale:.76,
  camera:[0, .08, 7.22],
  fov:30,
  look:[.08, .03, 0]
};

function mixState(a, b, t){
  const u = easeInOutCubic(t);
  return {
    pos:mixVec(a.pos, b.pos, u),
    rot:mixVec(a.rot, b.rot, u),
    scale:mix(a.scale, b.scale, u),
    camera:mixVec(a.camera, b.camera, u),
    fov:mix(a.fov, b.fov, u),
    look:mixVec(a.look, b.look, u)
  };
}

function watchStateFor(t){
  const turnToReader = easeInOutCubic(between(t, TL.turnStart, TL.turnEnd));
  const resolve = easeInOutCubic(between(t, TL.flipStart, TL.flipEnd));
  const reset = easeInOutCubic(between(t, TL.resetStart, duration));
  const arc = Math.sin(turnToReader * Math.PI);
  const contact = mixState(frontState, readerState, turnToReader);
  contact.pos = [
    contact.pos[0] + .035 * arc,
    contact.pos[1] + .075 * arc,
    contact.pos[2]
  ];
  contact.rot = [
    contact.rot[0] + .03 * arc,
    contact.rot[1],
    contact.rot[2]              // NO z-roll during the arc — the press stays dead-straight
  ];

  let state = contact;
  if (t >= TL.flipStart) state = mixState(readerState, doneState, resolve);
  if (t >= TL.flipEnd) state = doneState;
  if (t >= TL.resetStart) state = mixState(doneState, frontState, reset);
  // soft press at first contact — a tiny push in/out only, NO roll (dead-straight)
  const tapWindow = between(t, TL.tap, TL.tap + .5);
  if (tapWindow > 0 && tapWindow < 1) {
    const damp = Math.pow(1 - tapWindow, 2);
    const tap = Math.sin(tapWindow * Math.PI * 2.3) * damp;
    state = {
      ...state,
      pos:[state.pos[0], state.pos[1] + tap * .006, state.pos[2] + tap * .012],
      scale:state.scale + Math.abs(tap) * .004
    };
  }
  return state;
}

function applyWatchState(state){
  watchRig.position.set(state.pos[0] * layout.xScale, state.pos[1], state.pos[2]);
  watchRig.rotation.set(state.rot[0], state.rot[1], state.rot[2]);
  // PRIMARY response: the watch tilts toward the pointer (cursor-side edge lifts toward you) — a clear,
  // obvious "it tracks my mouse" feel. Front-facing only (eases to straight at the tap). Symmetric L/R.
  const frontness = .5 + .5 * Math.cos(state.rot[1]);
  watchRig.rotation.y -= paraX * .16 * frontness;
  watchRig.rotation.x -= paraY * .12 * frontness;
  watchRig.scale.setScalar(state.scale * layout.objectScale);
  // SECONDARY: a small camera lean toward the pointer so there's still some response during the
  // turn/tap (when the watch faces away), plus a touch of foreground/background depth parallax.
  camera.position.set(state.camera[0] - paraX * .26, state.camera[1] + paraY * .18, state.camera[2]);
  camera.position.z += layout.cameraZ;
  camera.fov = state.fov + layout.fov;
  camera.updateProjectionMatrix();
  const lk = state.look || [.08, .03, 0];
  camera.lookAt(lk[0], lk[1], lk[2]);
}

function phaseFor(t){
  if (t < TL.chooseEnd) return "Ace picks best card";
  if (t < TL.pressEnd) return "Hold Near Reader";
  if (t < TL.doneHold) return "Done";
  return "Reset";
}

function bindScreenMaterials(){
  if (!screenTexture) return;
  screenMaterials.forEach(mat => {
    mat.map = screenTexture;
    mat.emissiveMap = screenTexture;
    if (mat.emissive) mat.emissive.set(0xffffff);
    mat.emissiveIntensity = .16;
    if (mat.color) mat.color.set(0xffffff);
    mat.needsUpdate = true;
  });
}

function screenFor(t){
  if (t < TL.doneShown) return "hold";   // ✓ Done resolves on screen as the watch flips back into view
  return "done";   // stays Done through the reset; drawWatchScreen fades it to black for a seamless loop
}

function updateWatchScreen(t){
  if (!screenTexture || !screenCtx) return;
  const nextScreen = screenFor(t);
  const frame = Math.floor(t * (lowPower ? 30 : 60));   // mobile: redraw/upload the screen at 30fps, not 60
  if (frame === lastScreenFrame && nextScreen === currentScreen) return;
  currentScreen = nextScreen;
  lastScreenFrame = frame;
  drawWatchScreen(t);
  screenTexture.needsUpdate = true;
}

function updateReader(t){
  // SOLID opaque reader = its own hard depth layer. It FLIES IN from off-screen left as the watch
  // turns out to meet it, settles centred for the tap, then slides back out to the left.
  const slideIn = easeOutQuint(clamp01(between(t, TL.turnStart + .05, 6.3)));
  const exitRaw = between(t, TL.flipStart + .2, TL.flipEnd - .5);
  const exit = easeInOutCubic(exitRaw);
  const present = slideIn * (1 - exitRaw);
  readerRig.visible = present > .002;
  if (!readerRig.visible) return;
  const distance = smoother(between(t, 6.1, TL.tap));
  // Reader auto-parks just behind the watch's pressed face (whatever the tap scale is), so the
  // whole watch is genuinely IN FRONT — no co-planar z-fighting, no see-through.
  const tapWorld = readerState.scale * layout.objectScale;
  const parkZ = readerState.pos[2] - 1.9 * tapWorld - .12;
  // exit: glide FULLY off-screen left + shrink + recede, so it leaves frame smoothly instead of
  // snapping off while still visible (an opaque body can't cross-fade, so it exits the frame).
  const x = mix(-4.4, 0, slideIn) + mix(0, -6.2, exit) * layout.xScale;
  readerRig.position.set(x, 0, parkZ - .55 * exit);
  readerRig.rotation.set(0, 0, 0);
  readerRig.scale.setScalar(layout.readerScale * mix(.85, 1, slideIn) * mix(1, .58, exit));
  const proximity = distance * (1 - smoother(between(t, TL.pressEnd, TL.pressEnd + .7)));
  // a single emerald bloom that SWELLS through the press-hold (no goofy rings)
  const bloom = Math.sin(smoother(between(t, TL.tap - .05, TL.pressEnd - .05)) * Math.PI);
  if (readerGlow) readerGlow.material.opacity = present * (.05 + .12 * proximity + .62 * bloom);
  if (readerContactLight) readerContactLight.intensity = present * (.18 + .38 * proximity + 2.2 * bloom);
}

function updateShadows(t, watchState){
  const turn = smoother(between(t, TL.turnStart, TL.turnEnd));
  const done = smoother(between(t, TL.flipStart, TL.flipEnd));
  const enter = easeOutCubic(between(t, TL.turnStart + .1, 5.9));
  const exit = easeInOutCubic(between(t, TL.flipStart + .2, TL.flipEnd - .6));
  const readerOpacity = .98 * enter * (1 - exit);
  const watchScale = watchState.scale * layout.objectScale;

  watchShadow.position.x = watchState.pos[0] * layout.xScale - .02;
  watchShadow.position.z = .1 + watchState.pos[2] * .12;
  watchShadow.rotation.z = mix(.035, -.08, turn) + .025 * done;
  watchShadow.scale.setScalar(mix(.95, .58, turn) * mix(.9, 1.02, done) * watchScale);
  watchShadow.material.opacity = mix(.2, .115, turn) * mix(.88, 1, done);

  readerShadow.visible = readerOpacity > .002;
  readerShadow.position.x = readerRig.position.x;
  readerShadow.position.z = readerRig.position.z - .02;
  readerShadow.rotation.z = readerRig.rotation.z;
  readerShadow.scale.setScalar(layout.readerScale * mix(.84, 1, enter) * mix(1, .92, exit));
  readerShadow.material.opacity = readerOpacity * mix(.18, .28, turn);
}

function resize(){
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const aspect = w / h;
  if (aspect < .62) {
    layout = { objectScale:.56, xScale:.68, readerX:-.22, readerStartX:-1.38, readerScale:.36, cameraZ:1.15, fov:3 };
  } else if (aspect < .95) {
    layout = { objectScale:.76, xScale:.82, readerX:-.32, readerStartX:-1.82, readerScale:.44, cameraZ:.65, fov:1.5 };
  } else {
    layout = { objectScale:1, xScale:1, readerX:-.62, readerStartX:-2.36, readerScale:.98, cameraZ:0, fov:0 };
  }
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
}

function animate(now){
  requestAnimationFrame(animate);
  if (!ready) {
    renderer.render(scene, camera);
    return;
  }
  if (!onScreen && window.__freezeT == null) return;   // paused off-screen (perf) — matches the live page

  const elapsed = (now - startTime) / 1000;
  // playback time: frozen (debug) → scroll-scrubbed (when the page drives it) → auto-loop
  let local;
  if (Number.isFinite(frozenQueryTime)) local = frozenQueryTime;
  else if (window.__freezeT != null) local = window.__freezeT;
  else if (reduceMotion) local = 6.7;
  else {
    const sp = (window.__scrubProgress != null) ? window.__scrubProgress : scrollProgress;
    if (sp != null) { scrubTime += (clamp01(sp) * duration - scrubTime) * .12; local = scrubTime; }
    else local = elapsed % duration;
  }
  // ease the cursor parallax toward the pointer — frame-rate independent (consistent on 60/120Hz)
  const dt = Math.min(.05, lastNow ? (now - lastNow) / 1000 : .016);
  lastNow = now;
  const k = 1 - Math.exp(-dt * 8.5);
  paraX += (pointerTX - paraX) * k;
  paraY += (pointerTY - paraY) * k;
  const phase = phaseFor(local);
  if (phase !== lastPhase) {
    lastPhase = phase;
    if (phaseText) phaseText.innerHTML = "<strong>" + phase + "</strong>";
  }

  updateWatchScreen(local);
  const watchState = watchStateFor(local);
  applyWatchState(watchState);
  updateReader(local);
  updateShadows(local, watchState);
  renderer.render(scene, camera);
}

function texture(url){
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const tex = new THREE.Texture(image);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      resolve(tex);
    };
    image.onerror = reject;
    image.src = url;
  });
}

async function loadTextures(){
  textures.screen = createWatchScreenTexture();
  await loadCardImages();
  await new Promise((res) => {
    contactlessIcon = new Image();
    contactlessIcon.onload = res;
    contactlessIcon.onerror = () => { contactlessIcon = null; res(); };
    contactlessIcon.src = "assets/contactless.webp";
  });
  drawWatchScreen(0);
  screenTexture.needsUpdate = true;
}

function createWatchScreenTexture(){
  // mobile: 512² backing store = 1/4 the texture bytes uploaded each redraw (invisible at phone size).
  // We keep the 1024 design space by base-scaling the context, so no draw code below has to change.
  const px = lowPower ? 512 : 1024;
  screenCanvas = document.createElement("canvas");
  screenCanvas.width = px;
  screenCanvas.height = px;
  screenCtx = screenCanvas.getContext("2d");
  if (px !== 1024) screenCtx.scale(px / 1024, px / 1024);
  drawWatchScreen(0);
  screenTexture = new THREE.CanvasTexture(screenCanvas);
  screenTexture.colorSpace = THREE.SRGBColorSpace;
  screenTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  screenTexture.minFilter = THREE.LinearFilter;
  screenTexture.magFilter = THREE.LinearFilter;
  return screenTexture;
}

function loadCardImage(key, url){
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      cardImages[key] = image;
      const w = image.naturalWidth || 720, h = image.naturalHeight || 454;
      const bc = document.createElement("canvas");
      bc.width = w; bc.height = h;
      const bx = bc.getContext("2d");
      bx.filter = "blur(11px)";
      bx.drawImage(image, 0, 0, w, h);
      cardBlur[key] = bc;
      resolve(image);
    };
    image.onerror = reject;
    image.src = url;
  });
}

async function loadCardImages(){
  await Promise.all(Object.keys(CARD_ASSETS).map(key => loadCardImage(key, CARD_ASSETS[key])));
}

function drawWatchScreen(t){
  const ctx = screenCtx;
  if (!ctx) return;
  // Done fades IN at doneShown, holds, then fades OUT through the reset so the loop ends on a clean
  // dark screen (matching t=0) — never snapping back to the chosen-wallet "Hold Near Reader" frame.
  const doneIn  = screenFor(t) === "done" ? smoother(between(t, TL.doneShown, TL.doneShown + .8)) : 0;
  const doneOut = smoother(between(t, TL.resetStart + .3, duration - .1));
  const done = doneIn * (1 - doneOut);
  const hold = 1 - doneIn;     // the chosen wallet only shows up to the Done crossfade, never during reset
  const viewT = t;
  const scene = REWARD_SCENES[0];

  ctx.clearRect(0, 0, 1024, 1024);
  ctx.save();
  // OLED-black screen body
  ctx.fillStyle = "#000";
  roundRect(ctx, 44, 54, 936, 916, 182);
  ctx.fill();
  // faint top+bottom glass sheen (curved-glass read)
  const glass = ctx.createLinearGradient(0, 64, 0, 980);
  glass.addColorStop(0, "rgba(255,255,255,.06)");
  glass.addColorStop(.24, "rgba(255,255,255,.01)");
  glass.addColorStop(.86, "rgba(255,255,255,.012)");
  glass.addColorStop(1, "rgba(255,255,255,.05)");
  ctx.fillStyle = glass;
  roundRect(ctx, 48, 58, 928, 908, 178);
  ctx.fill();

  if (done > .001) drawWatchDone(ctx, scene, done);
  if (hold > .001) drawWatchHold(ctx, scene, viewT, hold);

  ctx.restore();
}

// The wallet SCROLLS DOWN through the user's cards and lands on the Ace pick (which sits a few
// down the list). A real carousel: the card at the focus row is big, the next peeks below
// (narrower, a card behind), cards above fade up behind the title. The best card grows into
// focus and gains the emerald glow + reward as it lands.
function drawWatchHold(ctx, scene, t, alpha){
  const reveal = smoother(between(t, .12, TL.revealEnd));
  const choose = smoother(between(t, TL.chooseStart, TL.chooseEnd));     // scroll progress → lands on the best
  const a = alpha * (1 - .12 * smoother(between(t, TL.turnStart, TL.turnStart + 1.4)));
  if (a <= .001) return;

  const focusW = 712, focusH = focusW * 454 / 720, peekW = focusW * .82;
  const focusCY = 472;                 // centre of the focus row
  const spacing = 430;                 // distance between card centres → next only peeks below

  // wallet order with the BEST card a few DOWN the list, so we scroll down to reach it
  const all = scene.compared.map(c => c[0]);
  const bestKey = scene.best;
  const others = all.filter(k => k !== bestKey);
  const walletOrder = [others[0], others[1], bestKey, others[2] || others[0]];
  const bestIndex = walletOrder.indexOf(bestKey);

  const scroll = mix(0, bestIndex, choose);   // 0 = first card focused → bestIndex = best focused
  const slide = mix(46, 0, reveal);

  // collect visible cards, then draw least-prominent first so the focus card sits on top
  const items = [];
  for (let i = 0; i < walletOrder.length; i++) {
    const rel = i - scroll, dist = Math.abs(rel);
    if (dist > 1.5) continue;
    const p = clamp01(1 - dist);                 // 1 at focus, 0 one row away
    const w = mix(peekW, focusW, p), h = w * 454 / 720;
    items.push({ key:walletOrder[i], i, p, w, h, top:(focusCY + rel * spacing + slide) - h / 2 });
  }
  items.sort((u, v) => u.p - v.p);

  // Clip EVERYTHING to the screen shape FIRST, so cards can't bleed past the screen edge — the
  // peek is cut at the rounded bottom edge (that was the real bug: cards drawn below the screen).
  ctx.save();
  roundRect(ctx, 44, 54, 936, 916, 182);
  ctx.clip();

  items.forEach(it => {
    const isBest = it.key === bestKey, focusNow = it.p > .9;
    const landed = isBest ? smoother(between(t, TL.chooseEnd - .45, TL.chooseEnd)) : 0;
    drawRealCard(ctx, it.key, (1024 - it.w) / 2, it.top, it.w, reveal * a, 1, {
      dim: mix(.45, 0, it.p),
      selected: isBest && focusNow,
      badgeProgress: landed,
      focus: it.p > .8
    });
  });

  // bottom scrim — softens the cut where the peek meets the screen edge (solid #000)
  const bs = ctx.createLinearGradient(0, 838, 0, 950);
  bs.addColorStop(0, "rgba(0,0,0,0)");
  bs.addColorStop(.5, "rgba(0,0,0,.7)");
  bs.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalAlpha = a; ctx.fillStyle = bs; ctx.fillRect(44, 838, 936, 132);
  // top scrim — hides cards as they scroll up past the title (nothing crowds the title)
  const ts = ctx.createLinearGradient(0, 54, 0, 246);
  ts.addColorStop(0, "rgba(0,0,0,1)"); ts.addColorStop(.78, "rgba(0,0,0,.96)"); ts.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = ts; ctx.fillRect(44, 54, 936, 200);
  // title + reward
  ctx.textAlign = "center";
  ctx.fillStyle = "#f4f7fb";
  ctx.font = "640 56px -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";
  ctx.globalAlpha = a * reveal;
  ctx.fillText("Hold Near Reader", 512, 150);
  ctx.fillStyle = "#3ce4a3";
  ctx.font = "700 44px -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";
  ctx.globalAlpha = a * smoother(between(t, TL.chooseEnd - .5, TL.chooseEnd));
  ctx.fillText(scene.reward + " " + scene.unit, 512, 208);
  ctx.restore();

  // scroll indicator (right) — thumb travels DOWN the list as the wallet scrolls to the pick
  const scrollVis = smoother(between(t, TL.chooseStart - .35, TL.chooseStart + .25))
                  * (1 - smoother(between(t, TL.chooseEnd + .1, TL.chooseEnd + .9)));
  if (scrollVis > .01) {
    const trackX = 947, trackY = 280, trackH = 440, barW = 8;
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = a * scrollVis * .1;
    roundRect(ctx, trackX, trackY, barW, trackH, barW / 2); ctx.fill();
    const thumbH = trackH / walletOrder.length;
    ctx.globalAlpha = a * scrollVis * .6;
    roundRect(ctx, trackX, trackY + (trackH - thumbH) * (scroll / (walletOrder.length - 1)), barW, thumbH, barW / 2); ctx.fill();
    ctx.restore();
  }
}

function drawWatchDone(ctx, scene, done){
  const cardW = 712, cardH = cardW * 454 / 720, cardX = (1024 - cardW) / 2;
  const cardY = mix(250, 232, done);     // the pick stays, lifts slightly to make room for the checkmark
  drawRealCard(ctx, scene.best, cardX, cardY, cardW, done, 1, { selected:true, badgeProgress:1, focus:true });
  drawDoneBadge(ctx, done, cardY + cardH + 56);
}

// SF "checkmark.circle.fill" + Done, centred — matches the real watchOS done state
function drawDoneBadge(ctx, alpha, y){
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(0, mix(28, 0, alpha));
  const label = "Done";
  ctx.font = "680 66px -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";
  const tw = ctx.measureText(label).width;
  const r = 31, gap = 22, total = 2 * r + gap + tw, startX = 512 - total / 2;
  const ccx = startX + r;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(ccx, y, r, 0, Math.PI * 2);
  ctx.fill();
  // centred, balanced checkmark (matches SF checkmark.circle.fill — vertex just below centre)
  ctx.strokeStyle = "#0a0a0b";
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(ccx - 12.5, y + 1.5);
  ctx.lineTo(ccx - 3.5, y + 10.5);
  ctx.lineTo(ccx + 13.5, y - 10.5);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, startX + 2 * r + gap, y + 3);
  ctx.restore();
}

function drawBestHeader(ctx, scene, reveal){
  ctx.save();
  ctx.globalAlpha *= reveal;
  ctx.translate(0, mix(14, 0, reveal));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,.58)";
  ctx.font = "800 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillText("Best card for", 512, 222);
  ctx.fillStyle = "#f7f8fb";
  ctx.font = "800 34px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillText(scene.label, 512, 258);
  ctx.restore();
}

function drawBestCardPanel(ctx, scene, choose, settle){
  const y = mix(368, 342, choose);
  const scale = mix(.925, .985, choose);
  const x = 150;
  const w = 724;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,.045)";
  roundRect(ctx, 120, 312, 784, 440, 48);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.09)";
  ctx.lineWidth = 2;
  roundRect(ctx, 121, 313, 782, 438, 47);
  ctx.stroke();
  drawRealCard(ctx, scene.best, x, y, w, 1, scale, {
    selected:true,
    badge:scene.reward,
    badgeLabel:"Ace picked",
    badgeProgress:choose
  });
  drawSelectionCallout(ctx, choose, scene);
  if (settle > .01) {
    ctx.globalAlpha = settle * .38;
    const shimmer = ctx.createLinearGradient(150, 330, 874, 700);
    shimmer.addColorStop(0, "rgba(255,255,255,0)");
    shimmer.addColorStop(.48, "rgba(255,255,255,.26)");
    shimmer.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = shimmer;
    roundRect(ctx, 150, y, w, w * 454 / 720, 40);
    ctx.fill();
  }
  ctx.restore();
}

function drawComparisonStrip(ctx, scene, alpha){
  if (alpha <= .001) return;
  const y = 804;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = "rgba(255,255,255,.075)";
  roundRect(ctx, 122, y, 780, 90, 30);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 2;
  roundRect(ctx, 123, y + 1, 778, 88, 29);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.64)";
  ctx.font = "800 17px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("Compared", 154, y + 45);
  scene.compared.slice(0, 4).forEach((item, index) => {
    const [card, reward, label] = item;
    const x = 284 + index * 146;
    const active = index === 0;
    ctx.fillStyle = active ? "rgba(43,209,126,.94)" : "rgba(255,255,255,.09)";
    roundRect(ctx, x, y + 18, 126, 54, 18);
    ctx.fill();
    ctx.fillStyle = active ? "#06170f" : "rgba(255,255,255,.9)";
    ctx.font = "900 20px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(reward, x + 14, y + 36);
    ctx.globalAlpha *= active ? .72 : .56;
    ctx.font = "800 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(label, x + 14, y + 57);
    ctx.globalAlpha /= active ? .72 : .56;
    const image = cardImages[card];
    if (image) {
      ctx.save();
      roundRect(ctx, x + 76, y + 22, 38, 25, 5);
      ctx.clip();
      ctx.drawImage(image, x + 76, y + 22, 38, 25);
      ctx.restore();
    }
  });
  ctx.restore();
}

function drawRealCard(ctx, key, x, y, width, alpha, scale, options){
  options = options || {};
  const sharp = cardImages[key];
  if (!sharp || alpha <= .001) return;
  const blurred = cardBlur[key] || sharp;
  // blurMix 0 = sharp, 1 = fully blurred; crossfades the two (so focus engages over time)
  const blurMix = options.blurMix != null ? options.blurMix : (options.blur ? 1 : 0);
  const height = width * 454 / 720;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x + width / 2, y + height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-width / 2, -height / 2);
  if (options.selected) {
    // the pick casts an EMERALD glow (not a dark shadow) — reads as "chosen" on ANY card colour,
    // instead of a green ring that blends into green/cyan cards.
    const p = options.badgeProgress == null ? 1 : options.badgeProgress;
    ctx.shadowColor = "rgba(54,224,158," + (.6 * p) + ")";
    ctx.shadowBlur = 52 * p;
    ctx.shadowOffsetY = 6;
  } else {
    ctx.shadowColor = options.focus ? "rgba(0,0,0,.6)" : "rgba(0,0,0,.4)";
    ctx.shadowBlur = options.focus ? 34 : 16;
    ctx.shadowOffsetY = options.focus ? 20 : 10;
  }
  roundRect(ctx, 0, 0, width, height, 34);
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.save();
  roundRect(ctx, 0, 0, width, height, 34);
  ctx.clip();
  ctx.drawImage(blurMix >= .999 ? blurred : sharp, 0, 0, width, height);
  if (blurMix > .001 && blurMix < .999) {     // crossfade sharp → blurred as focus engages
    ctx.globalAlpha = alpha * blurMix;
    ctx.drawImage(blurred, 0, 0, width, height);
    ctx.globalAlpha = alpha;
  }
  const sheen = ctx.createLinearGradient(0, 0, width, height);
  sheen.addColorStop(0, "rgba(255,255,255,.16)");
  sheen.addColorStop(.42, "rgba(255,255,255,.03)");
  sheen.addColorStop(1, "rgba(255,255,255,.08)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, width, height);
  // subtle inner vignette → gives every card the same depth + helps the chip/logos read
  const vig = ctx.createRadialGradient(width * .5, height * .42, height * .25, width * .5, height * .58, width * .62);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,.2)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, width, height);
  if (options.dim > 0) {                 // out-of-focus neighbour: darken toward the OLED black
    ctx.fillStyle = "rgba(3,5,8," + options.dim + ")";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
  if (options.selected) {                // crisp thin light edge for definition (no thick colour ring)
    const p = options.badgeProgress == null ? 1 : options.badgeProgress;
    ctx.strokeStyle = "rgba(255,255,255," + (.5 * p) + ")";
    ctx.lineWidth = 2;
    roundRect(ctx, 1, 1, width - 2, height - 2, 33);
    ctx.stroke();
  }
  if (options.badge) {
    drawCardBadge(ctx, width - 164, 18, options.badge, options.badgeLabel || "", options.selected);
  }
  ctx.restore();
}

function drawCardBadge(ctx, x, y, value, label, selected){
  ctx.save();
  const w = selected ? 142 : 116;
  const h = 54;
  ctx.fillStyle = selected ? "rgba(43,209,126,.95)" : "rgba(12,14,16,.72)";
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.strokeStyle = selected ? "rgba(255,255,255,.2)" : "rgba(255,255,255,.24)";
  ctx.lineWidth = 2;
  roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 15);
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = selected ? "#06160f" : "#f5f7f8";
  ctx.font = "800 26px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillText(value, x + 16, y + 23);
  ctx.globalAlpha = selected ? .72 : .62;
  ctx.font = "800 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillText(label, x + 18, y + 40);
  ctx.restore();
}

function drawSelectionCallout(ctx, alpha, scene){
  if (alpha <= .001) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const x = 326;
  const y = 708;
  const w = 372;
  const h = 58;
  ctx.fillStyle = "rgba(43,209,126,.96)";
  roundRect(ctx, x, y, w, h, 22);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.22)";
  ctx.lineWidth = 2;
  roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 21);
  ctx.stroke();
  ctx.fillStyle = "#06160f";
  ctx.font = "800 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Ace picked " + scene.reward, x + w / 2, y + h / 2 + 1);
  ctx.restore();
}

function drawDoneState(ctx, alpha){
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(0, mix(42, 0, alpha));
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(346, 764, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 13;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(326, 763);
  ctx.lineTo(344, 782);
  ctx.lineTo(376, 742);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "700 84px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText("Done", 420, 766);
  ctx.restore();
}

async function loadWatch(){
  const gltf = await gltfLoader.loadAsync("assets/watch.glb");
  watchModel = gltf.scene;
  const staleScreenMeshes = new Set([
    "KsxIrenucRYdQlx",
    "scpcAfQFCzMwocy",
    "dutMHxWYxKkWoIl"
  ]);
  watchModel.traverse(node => {
    if (!node.isMesh) return;
    node.renderOrder = 10;
    if (staleScreenMeshes.has(node.name)) {
      node.visible = false;
      return;
    }
    if (node.name === "wmnqxNpNCdRfDfA") {
      node.visible = true;
      screenMaterials = Array.isArray(node.material) ? node.material : [node.material];
      screenMaterials.forEach(mat => {
        if (!mat) return;
        mat.map = textures.screen;
        mat.emissiveMap = textures.screen;
        if (mat.emissive) mat.emissive.set(0xffffff);
        mat.emissiveIntensity = .16;
        if (mat.color) mat.color.set(0xffffff);
        if ("roughness" in mat) mat.roughness = .42;
        if ("metalness" in mat) mat.metalness = 0;
        mat.transparent = false;
        mat.opacity = 1;
        mat.needsUpdate = true;
      });
      return;
    }
    node.castShadow = false;
    node.receiveShadow = false;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach(mat => {
      if (!mat) return;
      mat.envMapIntensity = 1.18;
      if ("roughness" in mat) mat.roughness = Math.max(.28, mat.roughness ?? .5);
      if ("metalness" in mat) mat.metalness = Math.min(.82, mat.metalness ?? .5);
    });
  });

  const box = new THREE.Box3().setFromObject(watchModel);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  watchModel.position.sub(center);
  watchModel.scale.setScalar(3.45 / size.y);
  watchRig.add(watchModel);

  bindScreenMaterials();
}

function roundRect(ctx, x, y, width, height, radius){
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function roundedRectShape(width, height, radius){
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

function softShadowTexture(){
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d");
  const shadow = ctx.createRadialGradient(256, 128, 10, 256, 128, 242);
  shadow.addColorStop(0, "rgba(0,0,0,.72)");
  shadow.addColorStop(.38, "rgba(0,0,0,.34)");
  shadow.addColorStop(.72, "rgba(0,0,0,.11)");
  shadow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = shadow;
  ctx.fillRect(0, 0, 512, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function readerFaceTexture(){
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 1024;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, 1024, 1024);

  // soft, top-lit white surface (premium contactless terminal face)
  const bg = ctx.createLinearGradient(0, 40, 0, 984);
  bg.addColorStop(0, "rgba(255,255,255,.99)");
  bg.addColorStop(.5, "rgba(244,247,248,.99)");
  bg.addColorStop(1, "rgba(232,237,239,.99)");
  ctx.fillStyle = bg;
  roundRect(ctx, 26, 26, 972, 972, 150);
  ctx.fill();

  ctx.strokeStyle = "rgba(200,208,210,.6)";
  ctx.lineWidth = 6;
  roundRect(ctx, 30, 30, 964, 964, 146);
  ctx.stroke();

  // The real EMV contactless mark (assets/contactless.webp), centred on the reader face.
  if (contactlessIcon && contactlessIcon.naturalWidth) {
    const iw = 690, ih = iw * contactlessIcon.naturalHeight / contactlessIcon.naturalWidth;
    ctx.drawImage(contactlessIcon, 512 - iw / 2, 512 - ih / 2, iw, ih);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function readerGlowTexture(){
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d");
  const glow = ctx.createRadialGradient(256, 256, 20, 256, 256, 250);
  glow.addColorStop(0, "rgba(108,250,200,.30)");   // soft emerald core (low alpha → no white blow-out)
  glow.addColorStop(.26, "rgba(54,224,158,.30)");  // saturated AceWallet emerald through the mid
  glow.addColorStop(.6, "rgba(43,209,126,.13)");
  glow.addColorStop(1, "rgba(43,209,126,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function readerIconTexture(){
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, 512, 512);
  ctx.strokeStyle = "rgba(50,62,65,.82)";
  ctx.lineWidth = 34;
  ctx.lineCap = "round";
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(196 - i * 18, 256, 58 + i * 66, -.82, .82);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(50,62,65,.82)";
  ctx.beginPath();
  ctx.arc(194, 256, 17, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

async function loadReader(){
  const geometry = new THREE.ExtrudeGeometry(roundedRectShape(1.58, 1.58, .18), {
    depth:.12,
    bevelEnabled:true,
    bevelSize:.035,
    bevelThickness:.028,
    bevelSegments:10,
    curveSegments:18
  });
  geometry.center();

  // SOLID, fully opaque body — this is the reader's own hard depth layer. It writes
  // depth and never blends, so anything in front of it (the watch) occludes cleanly and
  // nothing is ever seen "through" it. Entrance is animated by SCALE, not opacity.
  const material = new THREE.MeshPhysicalMaterial({
    color:0xf8f9f9,
    roughness:.58,
    metalness:0,
    transmission:0,
    transparent:false,
    opacity:1,
    depthWrite:true,
    depthTest:true,
    clearcoat:.5,
    clearcoatRoughness:.42
  });

  readerMesh = new THREE.Mesh(geometry, material);
  readerMesh.renderOrder = -30;
  readerRig.add(readerMesh);

  // Visible face decal (white surface + recessed housing + contactless symbol). Sits a hair
  // in front of the solid body, so its transparent rounded corners reveal the solid body
  // behind it — never the scene. Opaque-equivalent: no see-through.
  readerFace = new THREE.Mesh(
    new THREE.PlaneGeometry(1.58, 1.58),
    new THREE.MeshBasicMaterial({
      map:readerFaceTexture(),
      side:THREE.DoubleSide,
      transparent:true,
      opacity:1,
      depthWrite:false,
      depthTest:true
    })
  );
  readerFace.position.z = .12;     // clearly IN FRONT of the solid body's beveled front (~.088) so the decal is never occluded by it
  readerFace.renderOrder = -29;
  readerRig.add(readerFace);

  readerGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 2.2),
    new THREE.MeshBasicMaterial({
      map:readerGlowTexture(),
      color:0x49e6a4,
      side:THREE.DoubleSide,
      transparent:true,
      opacity:0,
      depthWrite:false,
      depthTest:true,
      blending:THREE.AdditiveBlending,
      toneMapped:false
    })
  );
  readerGlow.position.z = .14;
  readerGlow.renderOrder = -28;
  readerRig.add(readerGlow);

  readerContactLight = new THREE.PointLight(0x72ffd0, 0, 2.4);
  readerContactLight.position.set(.16, .08, .34);
  readerRig.add(readerContactLight);
}

function finishLoad(){
  ready = true;
  if (loading) { loading.classList.add("is-hidden"); loading.hidden = true; }
  try { dracoLoader.dispose(); } catch (e) {}   // free decoder workers
  if (reduceMotion && phaseText) {
    phaseText.innerHTML = "<strong>Done</strong>";
  }
  stage.dispatchEvent(new CustomEvent("watchpay:ready"));   // host page fades its poster
}

function replay(){
  startTime = performance.now();
}

function seek(seconds){
  startTime = performance.now() - seconds * 1000;
}

if (replayButton) replayButton.addEventListener("click", replay);
window.addEventListener("resize", resize);

// cursor parallax — track a real MOUSE over the stage (ignore touch so scrolling doesn't jerk it)
stage.addEventListener("pointermove", (e) => {
  if (e.pointerType && e.pointerType !== "mouse") return;
  const r = stage.getBoundingClientRect();
  pointerTX = clamp01((e.clientX - r.left) / r.width) * 2 - 1;
  pointerTY = clamp01((e.clientY - r.top) / r.height) * 2 - 1;
});
stage.addEventListener("pointerleave", () => { pointerTX = 0; pointerTY = 0; });

// scroll-scrubbed playback — OPT-IN via data-scrub on the stage (auto-loop is the default, which is
// better for a normal section). Only scrubs when the page is scrollable.
const scrubEnabled = stage.hasAttribute("data-scrub");
function updateScroll(){
  if (!scrubEnabled) { scrollProgress = null; return; }
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  if (scrollable < 60) { scrollProgress = null; return; }
  const range = Math.max(1, stage.offsetHeight + window.innerHeight * .6);
  scrollProgress = clamp01((window.scrollY - (stage.offsetTop - window.innerHeight * .8)) / range);
}
if (scrubEnabled) {
  window.addEventListener("scroll", updateScroll, { passive:true });
  window.addEventListener("resize", updateScroll);
  updateScroll();
}

// pause the render loop when the stage scrolls off-screen (GPU/perf — matches the live page)
if ("IntersectionObserver" in window) {
  new IntersectionObserver((ents) => { onScreen = ents[0].isIntersecting; }, { threshold:.01 }).observe(stage);
}

window.__aceWatchMotion = {
  get ready(){ return ready; },
  get phase(){ return lastPhase; },
  get screen(){ return currentScreen; },
  replay,
  seek,
  renderer,
  scene,
  camera,
  // synchronous render of an exact timeline moment (works even in a backgrounded tab)
  renderAt(t){
    updateWatchScreen(t);
    const ws = watchStateFor(t);
    applyWatchState(ws);
    updateReader(t);
    updateShadows(t, ws);
    renderer.render(scene, camera);
    return true;
  }
};

loadTextures()
  .then(() => Promise.all([loadWatch(), loadReader()]))
  .then(finishLoad)
  .catch(error => {
    console.error("[AceWallet motion] load failed", error);
    if (loading) loading.textContent = "Motion failed to load. Check console.";
    stage.dispatchEvent(new CustomEvent("watchpay:error"));   // host page keeps its poster
  });

resize();
requestAnimationFrame(animate);
