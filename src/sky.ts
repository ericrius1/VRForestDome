import * as THREE from 'three/webgpu';
import {
  color, vec3, mix, smoothstep, uniform, Fn,
  positionWorldDirection, mx_noise_float, time,
} from 'three/tsl';

export interface DayNightParams {
  cycleMinutes: number;
  timeOfDay: number; // hours, 0..24 (0 = midnight, 12 = noon)
  running: boolean;
  auroraStrength: number;
}

// Palettes lerped on the CPU each frame and fed to the sky shader as uniforms.
const DAY_HORIZON = new THREE.Color(0xe9efee);
const DAY_ZENITH = new THREE.Color(0xa9c3d2);
const DUSK_HORIZON = new THREE.Color(0xff9d5c);
const DUSK_ZENITH = new THREE.Color(0x35466e);
const NIGHT_HORIZON = new THREE.Color(0x0d1626);
const NIGHT_ZENITH = new THREE.Color(0x020409);

const DAY_FOG = new THREE.Color(0xd2dad2);
const DUSK_FOG = new THREE.Color(0x6e5a64);
const NIGHT_FOG = new THREE.Color(0x070b12);

const SUN_NOON = new THREE.Color(0xffe9c4);
const SUN_LOW = new THREE.Color(0xff9a55);

const HEMI_SKY_DAY = new THREE.Color(0xd2ddd8);
const HEMI_SKY_NIGHT = new THREE.Color(0x16213a);
const HEMI_GND_DAY = new THREE.Color(0x4a5230);
const HEMI_GND_NIGHT = new THREE.Color(0x0f1410);

export function createDayNight(
  scene: THREE.Scene,
  sun: THREE.DirectionalLight,
  hemi: THREE.HemisphereLight,
) {
  const params: DayNightParams = {
    cycleMinutes: 5,
    timeOfDay: 0, // night by default
    running: true,
    auroraStrength: 0.5,
  };

  const uHorizon = uniform(NIGHT_HORIZON.clone());
  const uZenith = uniform(NIGHT_ZENITH.clone());
  const uNight = uniform(1); // deep-night factor gating aurora
  const uAurora = uniform(params.auroraStrength);

  scene.backgroundNode = Fn(() => {
    const dir = positionWorldDirection;
    const sky = mix(uHorizon, uZenith, smoothstep(-0.05, 0.5, dir.y)).toVar();

    // Aurora: slow ribbon noise shaped by faster vertical curtain streaks.
    const ap = dir.xz.div(dir.y.add(0.32));
    const drift = time.mul(0.025);
    const ribbon = smoothstep(0.08, 0.7, mx_noise_float(vec3(
      ap.x.mul(0.8).add(drift),
      ap.y.mul(0.8).sub(drift.mul(0.6)),
      time.mul(0.04),
    )));
    const curtain = mx_noise_float(vec3(ap.x.mul(4.5), ap.y.mul(0.7), time.mul(0.1)))
      .mul(0.5).add(0.5);
    const heightFade = smoothstep(0.06, 0.3, dir.y).mul(smoothstep(0.95, 0.45, dir.y));
    const hueShift = mx_noise_float(vec3(ap.mul(0.35), 7.7)).mul(0.5).add(0.5);
    const auroraCol = mix(color(0x23e8a4), color(0x6d4fd8), hueShift);
    const aurora = ribbon.mul(curtain.mul(0.65).add(0.35)).mul(heightFade).mul(uNight).mul(uAurora).mul(1.6);
    sky.addAssign(auroraCol.mul(aurora));

    return sky;
  })();

  scene.fog = new THREE.FogExp2(NIGHT_FOG.clone(), 0.012);

  // Dim bluish moonlight from opposite the sun keeps the night readable.
  const moon = new THREE.DirectionalLight(0x96aacd, 0.3);
  scene.add(moon);

  const sunBaseIntensity = sun.intensity;
  const azimuth = new THREE.Vector3(-0.73, 0, -0.69).normalize();
  const sunDir = new THREE.Vector3();
  const tmpColor = new THREE.Color();

  function apply() {
    const t = params.timeOfDay / 24;
    const theta = (t - 0.25) * Math.PI * 2;
    const elev = Math.sin(theta);
    const horiz = Math.cos(theta);
    sunDir.set(azimuth.x * horiz, elev, azimuth.z * horiz).normalize();
    sun.position.copy(sunDir).multiplyScalar(60);
    moon.position.copy(sunDir).multiplyScalar(-60);

    const day = THREE.MathUtils.smoothstep(elev, -0.03, 0.22);
    const dusk = 1 - THREE.MathUtils.smoothstep(Math.abs(elev), 0.0, 0.3);
    const deepNight = THREE.MathUtils.smoothstep(-elev, 0.04, 0.2);

    sun.intensity = sunBaseIntensity * day;
    sun.color.lerpColors(SUN_LOW, SUN_NOON, THREE.MathUtils.smoothstep(elev, 0.05, 0.5));
    sun.castShadow = day > 0.01;
    moon.intensity = 0.3 * deepNight;

    hemi.intensity = 0.12 + 0.73 * day;
    hemi.color.lerpColors(HEMI_SKY_NIGHT, HEMI_SKY_DAY, day);
    hemi.groundColor.lerpColors(HEMI_GND_NIGHT, HEMI_GND_DAY, day);

    tmpColor.lerpColors(NIGHT_HORIZON, DAY_HORIZON, day).lerp(DUSK_HORIZON, dusk * 0.85);
    (uHorizon.value as THREE.Color).copy(tmpColor);
    tmpColor.lerpColors(NIGHT_ZENITH, DAY_ZENITH, day).lerp(DUSK_ZENITH, dusk * 0.6);
    (uZenith.value as THREE.Color).copy(tmpColor);
    tmpColor.lerpColors(NIGHT_FOG, DAY_FOG, day).lerp(DUSK_FOG, dusk * 0.5);
    (scene.fog as THREE.FogExp2).color.copy(tmpColor);

    uNight.value = deepNight;
    uAurora.value = params.auroraStrength;
  }

  apply();

  // tweakpane v4 typings omit refresh on bindings
  let timeBinding: { refresh(): void } | null = null;
  let refreshTimer = 0;

  function attachPane(pane: any) {
    const f = pane.addFolder({ title: 'Day / Night' });
    f.addBinding(params, 'running', { label: 'auto cycle' });
    f.addBinding(params, 'cycleMinutes', { label: 'cycle (min)', min: 0.5, max: 30, step: 0.5 });
    timeBinding = f.addBinding(params, 'timeOfDay', { label: 'time (h)', min: 0, max: 24, step: 0.01 });
    f.addBinding(params, 'auroraStrength', { label: 'aurora', min: 0, max: 1, step: 0.01 });
  }

  function update(dt: number) {
    if (params.running) {
      params.timeOfDay = (params.timeOfDay + (dt / (params.cycleMinutes * 60)) * 24) % 24;
      refreshTimer += dt;
      if (timeBinding && refreshTimer > 0.2) {
        refreshTimer = 0;
        timeBinding.refresh();
      }
    }
    apply();
  }

  return { params, update, attachPane };
}
