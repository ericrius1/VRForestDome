import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, uniform, instancedArray, instanceIndex,
  float, vec3, vec4, mix, smoothstep, uv, dot,
} from 'three/tsl';
import { Pane } from 'tweakpane';
import { terrainHeight } from './terrain';

// World-space footprint of the dome (trees keep a clearing around it).
export const DOME = {
  x: -10, z: -1, r: 21,
};

// The simulation runs in the blog post's units (shell radius ~0.9) and is
// scaled up into world space for rendering and interaction.
const SIM_R = 0.9;
const SCALE = DOME.r / SIM_R;

// Forcer slots: 0 = mouse/gaze, 1 = left controller, 2 = right controller.
export const FORCER_SLOTS = 3;

export interface NBodyDomeParams {
  count: number;
  steps: number;
  paused: boolean;
  totalMass: number;
  gravity: number;
  dt: number;
  softening: number;
  damping: number;
  maxSpeed: number;
  shellK: number;
  shellR: number;
  floorK: number;
  spin: number;
  dispersion: number;
  massMin: number;
  massMax: number;
  pointerMode: 'attract' | 'repulse';
  strength: number;
  pointerSoftening: number;
  pointerMassScale: number;
  sizeScale: number;
  minSize: number;
  colorScale: number;
  colorLow: string;
  colorHigh: string;
  brightness: number;
}

export interface NBodyDome {
  update: (dt: number) => void;
  reseed: () => void;
  /** Reset all forcer slots; call once per frame before setForcer. */
  clearForcers: () => void;
  /** Apply attract (+1) / repulse (-1) at a sim-space point this frame. */
  setForcer: (slot: number, simPoint: THREE.Vector3, sign: number) => void;
  /** World-space ray vs dome shell. Returns sim-space hit point, or null. */
  intersectRay: (origin: THREE.Vector3, dir: THREE.Vector3) => THREE.Vector3 | null;
  /** Sim-space point -> world space (for cursors / ray endpoints). */
  simToWorld: (simPoint: THREE.Vector3, out?: THREE.Vector3) => THREE.Vector3;
  center: THREE.Vector3;
  params: NBodyDomeParams;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pane: any;
}

function randn(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function createNBodyDome(renderer: THREE.WebGPURenderer, scene: THREE.Scene): NBodyDome {
  const params: NBodyDomeParams = {
    count: 16384,
    steps: 2,
    paused: false,
    totalMass: 40960,
    gravity: 0.0000016,
    dt: 0.016,
    softening: 0.05,
    // The post's pairing: dome spring on, gentle damping so the shell
    // settles instead of ringing forever.
    damping: 0.999,
    maxSpeed: 1.5,
    shellK: 6,
    shellR: SIM_R,
    floorK: 4,
    spin: 1.0,
    dispersion: 0.08,
    massMin: 1,
    massMax: 3,
    pointerMode: 'attract',
    strength: 1.2,
    pointerSoftening: 0.02,
    pointerMassScale: 1.0,
    sizeScale: 0.004,
    minSize: 0.002,
    colorScale: 1.6,
    colorLow: '#1b3cff',
    colorHigh: '#ff4d2e',
    brightness: 1.5,
  };

  // Seat the dome's equator just below the lowest terrain around its rim so
  // the floor spring keeps every star above ground.
  const { x: cx, z: cz, r: R } = DOME;
  let baseY = Infinity;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    baseY = Math.min(baseY, terrainHeight(cx + Math.cos(a) * R * 0.95, cz + Math.sin(a) * R * 0.95));
  }
  baseY -= 0.25;
  const center = new THREE.Vector3(cx, baseY, cz);

  const uG = uniform(params.gravity);
  const uDt = uniform(params.dt);
  const uSoftening = uniform(params.softening);
  const uDamping = uniform(params.damping);
  const uMaxSpeed = uniform(params.maxSpeed);
  const uShellK = uniform(params.shellK);
  const uShellR = uniform(params.shellR);
  const uFloorK = uniform(params.floorK);
  const uPtrSoft = uniform(params.pointerSoftening);
  const uPtrPos = Array.from({ length: FORCER_SLOTS }, () => uniform(new THREE.Vector3()));
  // One strength per slot, packed into a vec3 uniform (x, y, z = slots 0..2).
  const uPtrG = uniform(new THREE.Vector3());
  const uSizeScale = uniform(params.sizeScale);
  const uMinSize = uniform(params.minSize);
  const uColorScale = uniform(params.colorScale);
  const uColLow = uniform(new THREE.Color(params.colorLow));
  const uColHigh = uniform(new THREE.Color(params.colorHigh));
  const uBrightness = uniform(params.brightness);
  const uCenter = uniform(center.clone());

  // Archimedes seeding: uniform height + random angle lands uniformly on the
  // hemisphere. Swirl about the vertical axis, faster near the rim.
  function generateInitData(n: number) {
    const pos = new Float32Array(n * 4);
    const vel = new Float32Array(n * 4);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const m = params.massMin + Math.random() * Math.max(0, params.massMax - params.massMin);
      pos[i * 4 + 3] = m;
      total += m;
    }
    const norm = params.totalMass / total;
    for (let i = 0; i < n; i++) pos[i * 4 + 3] *= norm;

    const Rs = params.shellR;
    for (let i = 0; i < n; i++) {
      const y = Math.random();
      const rho = Math.sqrt(Math.max(0, 1 - y * y));
      const a = Math.random() * Math.PI * 2;
      pos[i * 4 + 0] = Math.cos(a) * rho * Rs;
      pos[i * 4 + 1] = y * Rs;
      pos[i * 4 + 2] = Math.sin(a) * rho * Rs;
      const ringR = rho * Rs;
      const vCirc = Math.sqrt((params.gravity * params.totalMass * 0.5) / Math.sqrt(ringR * ringR + 0.05 * 0.05));
      const v = params.spin * vCirc * rho;
      vel[i * 4 + 0] = Math.sin(a) * v + randn() * params.dispersion * vCirc;
      vel[i * 4 + 1] = randn() * 0.04 * vCirc * (1 + params.dispersion);
      vel[i * 4 + 2] = -Math.cos(a) * v + randn() * params.dispersion * vCirc;
    }
    return { pos, vel };
  }

  let n = params.count;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let posA: any, posB: any, velA: any, velB: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stepAB: any, stepBA: any, copyBA: any;
  let sprite: THREE.Sprite | null = null;

  function makeStep(srcP: typeof posA, srcV: typeof velA, dstP: typeof posB, dstV: typeof velB) {
    return Fn(() => {
      const pm = srcP.element(instanceIndex);
      const pos = pm.xyz.toVar();
      const mass = pm.w;
      const vel = srcV.element(instanceIndex).xyz.toVar();
      const acc = vec3(0).toVar();
      const eps2 = uSoftening.mul(uSoftening);

      // All-pairs gravity, straight through 3D space — clusters on opposite
      // sides of the dome pull along the chord, not the surface.
      Loop(n, ({ i }: { i: any }) => {
        const o = srcP.element(i);
        const d = o.xyz.sub(pos);
        const r2 = dot(d, d).add(eps2);
        const w = uG.mul(o.w).div(r2.mul(r2.sqrt()));
        acc.addAssign(d.mul(w));
      });

      // The entire dome — the post's four lines. Radial spring sticks bodies
      // to the shell; the stiffer floor spring keeps them in the upper half.
      const r = pos.length();
      const rhat = pos.div(r.max(1e-6));
      acc.subAssign(rhat.mul(r.sub(uShellR)).mul(uShellK));
      If(pos.y.lessThan(0), () => {
        acc.assign(acc.sub(vec3(0, pos.y.mul(uShellK).mul(uFloorK), 0)));
      });

      // Pointer / VR controller penalty forces (one slot per hand + mouse).
      const gains = [uPtrG.x, uPtrG.y, uPtrG.z];
      for (let s = 0; s < FORCER_SLOTS; s++) {
        const pd = uPtrPos[s].sub(pos);
        const pr2 = dot(pd, pd).add(uPtrSoft.mul(uPtrSoft));
        acc.addAssign(pd.mul(gains[s]).div(pr2.mul(pr2.sqrt())));
      }

      vel.assign(vel.add(acc.mul(uDt)).mul(uDamping));
      const sp = vel.length();
      If(sp.greaterThan(uMaxSpeed), () => {
        vel.mulAssign(uMaxSpeed.div(sp));
      });
      pos.addAssign(vel.mul(uDt));
      dstP.element(instanceIndex).assign(vec4(pos, mass));
      dstV.element(instanceIndex).assign(vec4(vel, 0));
    })().compute(n);
  }

  function build() {
    n = params.count;
    const init = generateInitData(n);
    posA = instancedArray(init.pos, 'vec4');
    posB = instancedArray(init.pos.slice(), 'vec4');
    velA = instancedArray(init.vel, 'vec4');
    velB = instancedArray(init.vel.slice(), 'vec4');
    stepAB = makeStep(posA, velA, posB, velB);
    stepBA = makeStep(posB, velB, posA, velA);
    copyBA = Fn(() => {
      posA.element(instanceIndex).assign(posB.element(instanceIndex));
      velA.element(instanceIndex).assign(velB.element(instanceIndex));
    })().compute(n);

    const material = new THREE.SpriteNodeMaterial();
    const p = posA.toAttribute();
    const v = velA.toAttribute();
    material.positionNode = uCenter.add(p.xyz.mul(SCALE));
    const rad = uMinSize.max(uSizeScale.mul(p.w.pow(1 / 3)));
    material.scaleNode = rad.mul(2 * SCALE);
    const speed = v.xyz.length();
    const t = speed.mul(uColorScale).saturate();
    const col = mix(uColLow, uColHigh, t);
    const d = uv().sub(0.5).length().mul(2);
    const a = smoothstep(1, 0, d);
    material.colorNode = vec4(col.mul(a).mul(uBrightness), a);
    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.depthTest = true;
    material.fog = false;

    sprite = new THREE.Sprite(material);
    sprite.count = n;
    sprite.frustumCulled = false;
    scene.add(sprite);
  }

  function teardown() {
    if (!sprite) return;
    scene.remove(sprite);
    sprite.material.dispose();
    sprite = null;
  }

  function reseed() {
    const init = generateInitData(n);
    for (const [buf, data] of [[posA, init.pos], [posB, init.pos], [velA, init.vel], [velB, init.vel]] as const) {
      buf.value.array.set(data);
      buf.value.needsUpdate = true;
    }
  }

  build();

  // ---------------- forcers ----------------

  const ptrGains = [0, 0, 0];

  function clearForcers() {
    ptrGains[0] = ptrGains[1] = ptrGains[2] = 0;
  }

  function setForcer(slot: number, simPoint: THREE.Vector3, sign: number) {
    uPtrPos[slot].value.copy(simPoint);
    ptrGains[slot] = sign * params.strength * params.gravity * params.totalMass * params.pointerMassScale;
  }

  const oc = new THREE.Vector3();
  function intersectRay(origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
    const Rw = params.shellR * SCALE;
    oc.copy(origin).sub(center);
    const b = oc.dot(dir);
    const c = oc.lengthSq() - Rw * Rw;
    const disc = b * b - c;
    if (disc <= 0) return null;
    const sq = Math.sqrt(disc);
    // Nearest hit on the upper hemisphere; fall through to the far side so
    // pointing across the dome from outside still works.
    for (const tHit of [-b - sq, -b + sq]) {
      if (tHit <= 0) continue;
      const hit = new THREE.Vector3().copy(dir).multiplyScalar(tHit).add(origin).sub(center).divideScalar(SCALE);
      if (hit.y > -0.05 * params.shellR) return hit;
    }
    return null;
  }

  function simToWorld(simPoint: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(simPoint).multiplyScalar(SCALE).add(center);
  }

  // ---------------- tweakpane ----------------

  // tweakpane v4 typings omit folder helpers used at runtime
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pane = new Pane({ title: 'N-Body Dome' }) as any;
  pane.element.parentElement!.style.zIndex = '20';

  const fSim = pane.addFolder({ title: 'Simulation' });
  fSim.addBinding(params, 'count', {
    options: {
      '4k': 4096,
      '8k': 8192,
      '16k': 16384,
      '32k': 32768,
      '64k': 65536,
      '128k': 131072,
    },
  }).on('change', () => { teardown(); build(); });
  fSim.addBinding(params, 'steps', { min: 1, max: 8, step: 1, label: 'steps / frame' });
  fSim.addBinding(params, 'paused');
  fSim.addButton({ title: 'reseed (r)' }).on('click', reseed);

  const fPhys = pane.addFolder({ title: 'Gravity & Integration' });
  fPhys.addBinding(params, 'totalMass', { min: 1000, max: 100000, step: 500, label: 'total mass' });
  fPhys.addBinding(params, 'gravity', { min: 0, max: 0.00002, step: 0.0000002 });
  fPhys.addBinding(params, 'dt', { min: 0.001, max: 0.05, step: 0.0005, label: 'timestep' });
  fPhys.addBinding(params, 'softening', { min: 0.001, max: 0.5, step: 0.001, label: 'softening ε' });
  fPhys.addBinding(params, 'damping', { min: 0.9, max: 1.0, step: 0.0005 });
  fPhys.addBinding(params, 'maxSpeed', { min: 0.05, max: 5.0, step: 0.05 });

  const fDome = pane.addFolder({ title: 'Dome Constraint' });
  fDome.addBinding(params, 'shellK', { min: 0, max: 20, step: 0.5, label: 'dome strength' });
  fDome.addBinding(params, 'shellR', { min: 0.4, max: 1.1, step: 0.01, label: 'shell radius' });
  fDome.addBinding(params, 'floorK', { min: 0, max: 8, step: 0.5, label: 'floor stiffness ×' });

  const fSeed = pane.addFolder({ title: 'Initial Conditions' });
  fSeed.addBinding(params, 'spin', { min: 0, max: 2.0, step: 0.01, label: 'orbital spin' });
  fSeed.addBinding(params, 'dispersion', { min: 0, max: 1.0, step: 0.01, label: 'velocity noise' });
  fSeed.addBinding(params, 'massMin', { min: 0.1, max: 10, step: 0.1, label: 'mass min' });
  fSeed.addBinding(params, 'massMax', { min: 0.1, max: 20, step: 0.1, label: 'mass max' });

  const fPtr = pane.addFolder({ title: 'Pointer & Controllers' });
  fPtr.addBinding(params, 'pointerMode', {
    label: 'mouse mode (t)',
    options: { attract: 'attract', repulse: 'repulse' },
  });
  fPtr.addBinding(params, 'strength', { min: 0, max: 16, step: 0.1, label: 'force strength' });
  fPtr.addBinding(params, 'pointerSoftening', { min: 0.001, max: 0.5, step: 0.001, label: 'pointer ε' });
  fPtr.addBinding(params, 'pointerMassScale', { min: 0, max: 4, step: 0.05, label: 'mass coupling' });

  const fLook = pane.addFolder({ title: 'Particle Appearance' });
  fLook.addBinding(params, 'sizeScale', { min: 0, max: 0.02, step: 0.0001, label: 'size ∝ mass^⅓' });
  fLook.addBinding(params, 'minSize', { min: 0, max: 0.01, step: 0.0001 });
  fLook.addBinding(params, 'colorScale', { min: 0, max: 12, step: 0.01, label: 'speed → color' });
  fLook.addBinding(params, 'colorLow', { label: 'slow color' });
  fLook.addBinding(params, 'colorHigh', { label: 'fast color' });
  fLook.addBinding(params, 'brightness', { min: 0, max: 6, step: 0.05 });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyT') {
      params.pointerMode = params.pointerMode === 'attract' ? 'repulse' : 'attract';
      pane.refresh();
    } else if (e.code === 'KeyR') {
      reseed();
    } else if (e.code === 'KeyP') {
      params.paused = !params.paused;
      pane.refresh();
    }
  });

  function update() {
    uPtrG.value.set(ptrGains[0], ptrGains[1], ptrGains[2]);
    if (params.paused) return;
    uG.value = params.gravity;
    uDt.value = params.dt;
    uSoftening.value = params.softening;
    uDamping.value = params.damping;
    uMaxSpeed.value = params.maxSpeed;
    uShellK.value = params.shellK;
    uShellR.value = params.shellR;
    uFloorK.value = params.floorK;
    uPtrSoft.value = params.pointerSoftening;
    uSizeScale.value = params.sizeScale;
    uMinSize.value = params.minSize;
    uColorScale.value = params.colorScale;
    uColLow.value.set(params.colorLow);
    uColHigh.value.set(params.colorHigh);
    uBrightness.value = params.brightness;

    for (let k = 0; k < params.steps; k++) {
      renderer.compute(k % 2 === 0 ? stepAB : stepBA);
    }
    if (params.steps % 2 === 1) renderer.compute(copyBA);
  }

  return { update, reseed, clearForcers, setForcer, intersectRay, simToWorld, center, params, pane };
}
