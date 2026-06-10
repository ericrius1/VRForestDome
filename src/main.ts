import * as THREE from 'three/webgpu';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import Stats from 'three/addons/libs/stats.module.js';
import { createTerrain, terrainHeight } from './terrain';
import { createForest } from './trees';
import { createGrass } from './grass';
import { createFlowers } from './flowers';
import { createNBodyDome } from './nbodyDome';
import { createCursor } from './cursor';
import { createDayNight } from './sky';

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();

const EYE = 1.7;
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 400);
const camX = 7, camZ = 23.5;
camera.position.set(camX, terrainHeight(camX, camZ) + EYE, camZ);
camera.lookAt(-2, terrainHeight(-2, -4) + 3.2, -4);

// XR rig: in VR the headset drives the camera relative to this group, and
// thumbstick locomotion moves the group. On desktop it stays at the origin.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

const sun = new THREE.DirectionalLight(0xffe9c4, 3.8);
sun.position.set(-34, 26, -32);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -55;
sun.shadow.camera.right = 55;
sun.shadow.camera.top = 55;
sun.shadow.camera.bottom = -55;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 140;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
scene.add(sun);

const hemi = new THREE.HemisphereLight(0xd2ddd8, 0x4a5230, 0.85);
scene.add(hemi);

const sky = createDayNight(scene, sun, hemi);

scene.add(createTerrain());
scene.add(createForest());
scene.add(createGrass());
scene.add(createFlowers());

const cursor = createCursor();
const dome = createNBodyDome(renderer, scene);
sky.attachPane(dome.pane);

// ---------------- VR controllers ----------------

interface ControllerState {
  controller: THREE.Group;
  line: THREE.Line;
  sign: number; // +1 attract, -1 repulse, 0 idle
  handedness: XRHandedness;
}

const ATTRACT_COLOR = new THREE.Color('#4fd8ff');
const REPULSE_COLOR = new THREE.Color('#ffa14f');
const IDLE_COLOR = new THREE.Color(0xffffff);

function makeController(index: number): ControllerState {
  const controller = renderer.xr.getController(index);
  rig.add(controller);
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1),
  ]);
  const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
  const line = new THREE.Line(geo, mat);
  line.scale.z = 8;
  controller.add(line);
  const state: ControllerState = { controller, line, sign: 0, handedness: 'none' };
  // Role is fixed per hand: right attracts, left repulses. Trigger or grip
  // activates it, so both hands can run at once or solo.
  const roleSign = () => (state.handedness === 'left' ? -1 : 1);
  let pressed = 0;
  controller.addEventListener('connected', (e) => {
    state.handedness = (e as THREE.Event & { data?: XRInputSource }).data?.handedness ?? 'none';
  });
  controller.addEventListener('disconnected', () => { pressed = 0; state.sign = 0; });
  const press = () => { pressed++; state.sign = roleSign(); };
  const release = () => { pressed = Math.max(0, pressed - 1); if (pressed === 0) state.sign = 0; };
  controller.addEventListener('selectstart', press);
  controller.addEventListener('selectend', release);
  controller.addEventListener('squeezestart', press);
  controller.addEventListener('squeezeend', release);
  return state;
}

const controllers = [makeController(0), makeController(1)];

renderer.xr.addEventListener('sessionstart', () => {
  rig.position.set(camera.position.x, terrainHeight(camera.position.x, camera.position.z), camera.position.z);
  camera.position.set(0, 0, 0);
  overlay.style.display = 'none';
});

renderer.xr.addEventListener('sessionend', () => {
  camera.position.set(rig.position.x, terrainHeight(rig.position.x, rig.position.z) + EYE, rig.position.z);
  camera.rotation.set(0, 0, 0);
  rig.position.set(0, 0, 0);
  rig.rotation.set(0, 0, 0);
  if (!fallbackLook) overlay.style.display = '';
});

// ---------------- stats + tweakpane overlay toggle ----------------

const stats = new Stats();
stats.dom.style.zIndex = '25';
document.body.appendChild(stats.dom);

let overlaysVisible = true;

function setOverlaysVisible(visible: boolean) {
  overlaysVisible = visible;
  stats.dom.style.display = visible ? 'block' : 'none';
  dome.pane.element.parentElement!.style.display = visible ? '' : 'none';
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Slash' && !e.repeat) {
    setOverlaysVisible(!overlaysVisible);
  }
});

// ---------------- FPS controls ----------------

const controls = new PointerLockControls(camera, renderer.domElement);

const overlay = document.createElement('div');
overlay.style.cssText = `
  position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
  background:rgba(20,28,24,0.25); color:#eef3ee; cursor:pointer; user-select:none;
  font:500 18px/1.6 system-ui, sans-serif; text-align:center; letter-spacing:0.02em;`;
overlay.innerHTML = '<div>Click to walk<br><span style="font-size:14px;opacity:0.8">WASD move &middot; Shift run &middot; mouse look &middot; hold click for force &middot; t attract/repulse &middot; Esc release &middot; / toggle HUD<br>VR: right hand attracts &middot; left hand repulses &middot; left stick move &middot; right stick turn</span></div>';
document.body.appendChild(overlay);

let fallbackLook = false;
let dragLooking = false;

document.addEventListener('pointerlockerror', () => {
  if (fallbackLook) return;
  fallbackLook = true;
  overlay.style.display = 'none';
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  renderer.domElement.addEventListener('mousedown', () => { dragLooking = true; });
  window.addEventListener('mouseup', () => { dragLooking = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragLooking) return;
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= e.movementX * 0.0025;
    euler.x = THREE.MathUtils.clamp(euler.x - e.movementY * 0.0025, -1.4, 1.4);
    camera.quaternion.setFromEuler(euler);
  });
});

overlay.addEventListener('click', () => { if (!fallbackLook) controls.lock(); });
controls.addEventListener('lock', () => { overlay.style.display = 'none'; });
renderer.domElement.addEventListener('click', () => {
  if (!fallbackLook && !controls.isLocked && !renderer.xr.isPresenting) controls.lock();
});

const keys = new Set<string>();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

let pointerDown = false;
window.addEventListener('mousedown', (e) => { if (e.button === 0) pointerDown = true; });
window.addEventListener('mouseup', () => { pointerDown = false; });

let velF = 0, velR = 0;

const clock = new THREE.Clock();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------- forcer input (mouse + VR controllers) ----------------

const rayOrigin = new THREE.Vector3();
const rayDir = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

function updateForcers() {
  dome.clearForcers();

  if (renderer.xr.isPresenting) {
    cursor.set(null);
    for (let i = 0; i < controllers.length; i++) {
      const { controller, line, sign } = controllers[i];
      controller.getWorldPosition(rayOrigin);
      controller.getWorldQuaternion(tmpQuat);
      rayDir.set(0, 0, -1).applyQuaternion(tmpQuat);
      const hit = dome.intersectRay(rayOrigin, rayDir);
      const mat = line.material as THREE.LineBasicMaterial;
      if (hit) {
        line.scale.z = dome.simToWorld(hit, rayDir).sub(rayOrigin).length();
        mat.color.copy(sign > 0 ? ATTRACT_COLOR : sign < 0 ? REPULSE_COLOR : IDLE_COLOR);
        mat.opacity = sign !== 0 ? 1.0 : 0.6;
        if (sign !== 0) dome.setForcer(i + 1, hit, sign);
      } else {
        line.scale.z = 8;
        mat.color.copy(IDLE_COLOR);
        mat.opacity = 0.3;
      }
    }
    return;
  }

  camera.getWorldPosition(rayOrigin);
  camera.getWorldDirection(rayDir);
  const hit = dome.intersectRay(rayOrigin, rayDir);
  if (!hit) {
    cursor.set(null);
    return;
  }
  cursor.set(dome.params.pointerMode, pointerDown);
  if (pointerDown) {
    dome.setForcer(0, hit, dome.params.pointerMode === 'attract' ? 1 : -1);
  }
}

// ---------------- VR locomotion ----------------

const headYaw = new THREE.Vector3();

function updateLocomotion(dt: number) {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const source of session.inputSources) {
    const axes = source.gamepad?.axes;
    if (!axes || axes.length < 4) continue;
    const ax = axes[2], ay = axes[3];
    if (Math.abs(ax) < 0.1 && Math.abs(ay) < 0.1) continue;
    if (source.handedness === 'right') {
      rig.rotation.y -= ax * dt * 2.0;
    } else {
      camera.getWorldDirection(headYaw);
      headYaw.y = 0;
      headYaw.normalize();
      const speed = 3.5;
      rig.position.addScaledVector(headYaw, -ay * speed * dt);
      headYaw.cross(new THREE.Vector3(0, 1, 0));
      rig.position.addScaledVector(headYaw, -ax * speed * dt);
    }
  }
  rig.position.y = terrainHeight(rig.position.x, rig.position.z);
}

if (import.meta.env.DEV) {
  (window as unknown as { __debug: object }).__debug = {
    camera, rig, scene, sky, controls, keys, dome, isFallback: () => fallbackLook,
  };
}

renderer.setAnimationLoop(() => {
  stats.begin();
  const dt = Math.min(clock.getDelta(), 0.05);

  if (renderer.xr.isPresenting) {
    updateLocomotion(dt);
  } else {
    if (controls.isLocked || fallbackLook) {
      const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 10 : 4.5;
      const tF = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      const tR = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      const k = Math.min(1, dt * 9);
      velF += (tF * speed - velF) * k;
      velR += (tR * speed - velR) * k;
      controls.moveForward(velF * dt);
      controls.moveRight(velR * dt);
    }
    camera.position.y = terrainHeight(camera.position.x, camera.position.z) + EYE;
  }

  updateForcers();
  dome.update(dt);
  sky.update(dt);

  renderer.render(scene, camera);
  stats.end();
});
