import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

const canvas = document.getElementById("bankingThemeScene");
const loader = document.getElementById("bankingThemeLoader");
const loaderFill = loader.querySelector(".banking-loader-fill");
const loaderCount = loader.querySelector(".banking-loader-count");
const loaderStatus = loader.querySelector(".banking-loader-status");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const palettes = {
  roseGold: {
    label: "Royal Blue & Pearl",
    description: "Cobalt spheres in soft white-blue light.",
    background: "radial-gradient(circle at center,#fff 0%,#ecefff 35%,#c2d1ff 100%)",
    colors: ["#ecefff", "#a8c1ff", "#2f69ff", "#0a33bf", "#4d80ff"],
  },
  pinkBlush: {
    label: "Rose Blush & Crème",
    description: "Warm rose highlights on a pale blush field.",
    background: "radial-gradient(circle at center,#fff 0%,#fff0f1 38%,#ffd1d5 100%)",
    colors: ["#fff5f4", "#ffeceb", "#ffa6b3", "#ff4d6d", "#ffa6b3"],
  },
  voltLime: {
    label: "Volt Lime & Slate",
    description: "Electric lime against a clean, light horizon.",
    background: "radial-gradient(circle at center,#fff 0%,#fbffe5 38%,#e8ff9c 100%)",
    colors: ["#fbffe2", "#efff69", "#e1fc03", "#b1e200", "#dcff32"],
  },
  arcticBlue: {
    label: "Arctic Sky & Crystal",
    description: "Cool arctic blue tones with glassy highlights.",
    background: "radial-gradient(circle at center,#fff 0%,#effaff 38%,#c9f1ff 100%)",
    colors: ["#f0f9ff", "#c9f1ff", "#96e5ff", "#2ba5ff", "#98e4ff"],
  },
};

const selectedPalette = "roseGold";
const paletteColors = Object.fromEntries(
  Object.keys(palettes).map(key => [key, palettes[key].colors.map(color => new THREE.Color(color))]),
);
const currentColors = palettes.roseGold.colors.map(() => new THREE.Color());
let activePalette = selectedPalette;
let scene;
let camera;
let renderer;
let hemiLight;
let balls = [];
let frameId = 0;
let clock;
let progress = 0;
let viewportWidth = 1;
let viewportHeight = 1;
let meanRadius = 0;
let ready = false;
let loaderExiting = false;
let started = false;
let entranceStart = 0;
const mouse = { x: 99, y: 99, down: false };
const temp = {
  mouseProjected: new THREE.Vector3(),
  mouseWorld: new THREE.Vector3(),
  previousMouseWorld: new THREE.Vector3(),
  delta: new THREE.Vector3(),
  collision: new THREE.Vector3(),
  relativeVelocity: new THREE.Vector3(),
  rotationAxis: new THREE.Vector3(),
};

const clamp01 = value => Math.max(0, Math.min(1, value));
const smoothstep = (start, end, value) => {
  const amount = clamp01((value - start) / (end - start));
  return amount * amount * (3 - 2 * amount);
};
const lerp = (from, to, amount) => from + (to - from) * amount;
const colorRoles = key => palettes[key].colors.map(color => new THREE.Color(color));

function updateFrustum() {
  const fov = THREE.MathUtils.degToRad(camera.fov);
  viewportHeight = 2 * Math.tan(fov / 2) * camera.position.z;
  viewportWidth = viewportHeight * (innerWidth / innerHeight);
}

function assignHeartTargets() {
  if (!balls.length) return;
  const size = Math.min(viewportWidth * 0.3, viewportHeight * 0.27);
  const centerX = innerWidth > 900 ? viewportWidth * 0.2 : 0;
  const centerY = -viewportHeight * 0.03;
  const scale = Math.max(0.3, Math.min(1, (size * 0.45) / 2.3 / meanRadius));

  balls.forEach(ball => {
    let x = 0;
    let y = 0;
    let attempts = 0;
    do {
      x = (Math.random() * 2 - 1) * 1.25;
      y = Math.random() * 2.55 - 1.4;
      attempts += 1;
    } while ((x * x + y * y - 1) ** 3 - x * x * y ** 3 > 0 && attempts < 60);
    ball.shapeTarget.set(
      centerX + x * size,
      (y + 0.12) * size + centerY,
      (Math.random() - 0.5) * 0.35,
    );
    ball.visualScale = ball.radius * (1 - (1 - scale) * 0.8);
  });
}

function scatterFar(inward) {
  const radius = Math.max(viewportWidth, viewportHeight) * 1.5;
  for (const ball of balls) {
    const angle = Math.random() * Math.PI * 2;
    const x = Math.cos(angle) * radius * 1.25;
    const y = Math.sin(angle) * radius * 0.85;
    const z = (Math.random() - 0.5) * 4;
    ball.position.set(x, y, z);
    ball.mesh.position.copy(ball.position);
    ball.velocity.set(0, 0, 0);
    if (inward) {
      ball.velocity.set(-x, -y, -z).normalize().multiplyScalar(0.08 + Math.random() * 0.05);
    }
  }
}

function createScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 0, 11);
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, innerWidth < 768 ? 1.25 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const palette = colorRoles(activePalette);
  hemiLight = new THREE.HemisphereLight(0xffffff, palette[2], 1.6);
  scene.add(hemiLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
  keyLight.position.set(-6, 10, 8);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 30;
  keyLight.shadow.camera.left = -8;
  keyLight.shadow.camera.right = 8;
  keyLight.shadow.camera.top = 8;
  keyLight.shadow.camera.bottom = -8;
  keyLight.shadow.bias = -0.0003;
  keyLight.shadow.radius = 8;
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0xffffff, 1.25);
  rimLight.position.set(8, 7, -8);
  scene.add(rimLight);
  const frontLight = new THREE.DirectionalLight(0xffffff, 0.4);
  frontLight.position.set(0, 0, 11);
  scene.add(frontLight);

  updateFrustum();
  const count = innerWidth < 768 ? 48 : 78;
  const geometry = new THREE.SphereGeometry(1, 32, 32);
  balls = [];
  for (let id = 0; id < count; id += 1) {
    const random = Math.random();
    const radius = random < 0.3
      ? 0.27 + Math.random() * 0.12
      : random < 0.8
        ? 0.42 + Math.random() * 0.18
        : 0.66 + Math.random() * 0.21;
    const isGlass = Math.random() < 0.22;
    const roleIndex = isGlass ? 4 : Math.min(3, Math.floor(Math.random() * 4));
    const color = palette[roleIndex];
    const material = new THREE.MeshPhysicalMaterial({
      color,
      roughness: isGlass ? 0.08 : 0.44,
      metalness: 0,
      clearcoat: isGlass ? 1 : 0.24,
      clearcoatRoughness: isGlass ? 0.03 : 0.35,
      transmission: isGlass ? 0.86 : 0,
      ior: 1.485,
      thickness: isGlass ? 1.8 : 0,
      emissive: color,
      emissiveIntensity: isGlass ? 0.1 : 0.08,
      transparent: isGlass,
      opacity: isGlass ? 0.92 : 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.setScalar(radius);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    balls.push({
      id,
      radius,
      mass: radius ** 3,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      mesh,
      material,
      roleIndex,
      isGlass,
      visualScale: radius,
      shapeTarget: new THREE.Vector3(),
    });
  }
  meanRadius = balls.reduce((total, ball) => total + ball.radius, 0) / balls.length;
  assignHeartTargets();
  scatterFar(false);
  clock = new THREE.Clock();
  requestAnimationFrame(animate);
}

function updatePalette(progressLime, progressPink) {
  const base = paletteColors[activePalette];
  const lime = paletteColors.voltLime;
  const pink = paletteColors.pinkBlush;
  currentColors.forEach((color, index) => color.copy(base[index]).lerp(lime[index], progressLime).lerp(pink[index], progressPink));
  hemiLight.groundColor.copy(currentColors[2]);
  balls.forEach(ball => {
    const color = currentColors[ball.roleIndex];
    ball.material.color.copy(color);
    ball.material.emissive.copy(color);
  });
}

function updateMouseWorld() {
  temp.mouseProjected.set(mouse.x, mouse.y, 0.5).unproject(camera);
  const direction = temp.mouseProjected.sub(camera.position).normalize();
  const distance = -camera.position.z / direction.z;
  temp.mouseWorld.copy(camera.position).add(direction.multiplyScalar(distance));
}

function animate(now) {
  frameId = 0;
  if (!reducedMotion.matches && !document.hidden) frameId = requestAnimationFrame(animate);
  const elapsed = clock.getDelta();
  const time = clock.elapsedTime;
  const delta = Math.min(elapsed || 0.016, 0.05) * 60;
  updateMouseWorld();

  if (!started) {
    started = true;
    entranceStart = time;
    if (reducedMotion.matches) {
      balls.forEach(ball => {
        ball.position.copy(ball.shapeTarget);
        ball.mesh.position.copy(ball.position);
      });
    } else {
      scatterFar(true);
    }
  }

  const heroFactor = 1 - smoothstep(0.3, 0.8, progress);
  const dropFactor = smoothstep(0.4, 0.95, progress) * (1 - smoothstep(1.25, 1.75, progress));
  const flyFactor = smoothstep(2.7, 3.45, progress);
  const shapeFactor = smoothstep(1.4, 2.05, progress) * (1 - smoothstep(2.55, 3, progress));
  updatePalette(smoothstep(0.55, 1.05, progress), smoothstep(1.4, 1.95, progress));

  const entrance = 1 - Math.pow(1 - clamp01((time - entranceStart) / 2.2), 3);
  const attraction = lerp(7.5, 1, entrance);
  const interacting = Math.abs(mouse.x) < 0.99 || Math.abs(mouse.y) < 0.99;
  const mouseSpeed = interacting
    ? Math.min(temp.mouseWorld.distanceTo(temp.previousMouseWorld), 3)
    : 0;
  temp.previousMouseWorld.copy(temp.mouseWorld);
  const damping = lerp(0.91, 0.992, dropFactor) * (1 - 0.1 * shapeFactor);
  const focusX = innerWidth > 900 ? viewportWidth * 0.2 : 0;
  const clusterActive = Math.max(heroFactor, entrance < 1 ? 1 : 0);

  for (const ball of balls) {
    if (heroFactor > 0.01) {
      ball.velocity.x += Math.sin(time * 0.4 + ball.id * 1.5) * 0.0004 * ball.radius * heroFactor;
      ball.velocity.y += Math.cos(time * 0.5 + ball.id * 1.2) * 0.0004 * ball.radius * heroFactor;
      ball.velocity.z += Math.sin(time * 0.35 + ball.id) * 0.0001 * heroFactor;
    }
    const centerForce = 0.0035 * attraction * clusterActive;
    ball.velocity.x += (focusX - ball.position.x) * centerForce * 0.38;
    ball.velocity.y += -ball.position.y * centerForce * 1.85;
    ball.velocity.z += -ball.position.z * centerForce * 1.8;
    if (dropFactor > 0.001) ball.velocity.y -= 0.011 * dropFactor;
    if (shapeFactor > 0.001) {
      const spring = 0.06 * shapeFactor;
      ball.velocity.add(temp.delta.subVectors(ball.shapeTarget, ball.position).multiplyScalar(spring));
    }
    if (flyFactor > 0.001) {
      const stagger = (ball.id * 0.6180339887) % 1;
      const local = smoothstep(stagger * 0.55, stagger * 0.55 + 0.45, flyFactor);
      ball.velocity.z += 0.05 * local;
      ball.velocity.x += ball.position.x * 0.006 * local;
      ball.velocity.y += ball.position.y * 0.006 * local;
    }
    if (interacting) {
      temp.delta.subVectors(ball.position, temp.mouseWorld);
      const distance = temp.delta.length();
      const radius = mouse.down ? 6.16 : 4.4;
      if (distance < radius && distance > 0.0001) {
        const ratio = distance / radius;
        const force = (1 - ratio * ratio * (3 - 2 * ratio)) * (mouse.down ? 0.085 : 0.05) * (1 + mouseSpeed * 3.2);
        temp.delta.normalize();
        temp.delta.z *= 0.12;
        temp.delta.normalize();
        ball.velocity.addScaledVector(temp.delta, force);
      }
    }
    ball.velocity.multiplyScalar(Math.pow(damping, delta));
    ball.position.addScaledVector(ball.velocity, delta);
    const targetScale = ball.radius * (1 - 0.5 * shapeFactor);
    ball.visualScale += (targetScale - ball.visualScale) * 0.12;
    ball.mesh.scale.setScalar(ball.visualScale);
  }

  const collisionScale = 0.28 * (1 - 0.93 * shapeFactor) * (1 - flyFactor);
  for (let step = 0; step < 2; step += 1) {
    for (let i = 0; i < balls.length; i += 1) {
      for (let j = i + 1; j < balls.length; j += 1) {
        const first = balls[i];
        const second = balls[j];
        temp.collision.subVectors(second.position, first.position);
        const distance = temp.collision.length();
        const minimumDistance = first.visualScale + second.visualScale;
        if (distance >= minimumDistance || distance <= 0.001) continue;
        const overlap = minimumDistance - distance;
        temp.collision.multiplyScalar(1 / distance);
        const totalMass = first.mass + second.mass;
        first.position.addScaledVector(temp.collision, -overlap * (second.mass / totalMass) * collisionScale);
        second.position.addScaledVector(temp.collision, overlap * (first.mass / totalMass) * collisionScale);
        temp.relativeVelocity.subVectors(second.velocity, first.velocity);
        const along = temp.relativeVelocity.dot(temp.collision);
        if (along < -0.0001) {
          const impulse = -(1.02 * along) / (1 / first.mass + 1 / second.mass);
          first.velocity.addScaledVector(temp.collision, -impulse / first.mass);
          second.velocity.addScaledVector(temp.collision, impulse / second.mass);
        }
      }
    }
  }

  const xBound = viewportWidth / 2 - 0.2;
  const floor = -viewportHeight / 2 + 0.05;
  const ceiling = viewportHeight / 2 - 0.05;
  for (const ball of balls) {
    const radius = ball.visualScale;
    if (flyFactor < 0.5) {
      if (ball.position.x < -xBound - radius || ball.position.x > xBound + radius) ball.velocity.x *= -0.3;
      if (ball.position.y - radius < floor) {
        ball.position.y = floor + radius;
        if (ball.velocity.y < 0) ball.velocity.y = -ball.velocity.y * (0.3 + 0.35 * dropFactor);
        if (dropFactor > 0.3) ball.velocity.x *= 0.86;
      }
      if (ball.position.y + radius > ceiling) {
        ball.position.y = ceiling - radius;
        if (ball.velocity.y > 0) ball.velocity.y *= -0.3;
      }
    }
    ball.mesh.position.copy(ball.position);
    ball.mesh.rotation.x += ball.velocity.y * 0.08;
    ball.mesh.rotation.y += ball.velocity.x * 0.08;
  }

  renderer.render(scene, camera);
  if (!ready) {
    ready = true;
    beginLoaderExit();
  }
}

function beginLoaderExit() {
  if (loaderExiting) return;
  loaderExiting = true;
  loaderFill.style.width = "100%";
  loaderCount.textContent = "100%";
  loaderStatus.textContent = "Entering orbit";
  setTimeout(() => {
    document.body.classList.add("banking-animation-ready");
    document.body.classList.remove("banking-animation-loading");
    document.querySelector(".banking-theme .hero").classList.add("image-live", "revealed");
  }, 650);
}

function mountPaletteControls() {
  const navActions = document.querySelector(".banking-theme .nav-actions");
  const button = document.createElement("button");
  button.className = "banking-theme-controls-button";
  button.type = "button";
  button.setAttribute("aria-label", "Open theme controls");
  button.setAttribute("aria-expanded", "false");
  button.textContent = "✳";
  navActions.prepend(button);

  const drawer = document.getElementById("bankingThemeControls");
  const scrim = document.getElementById("bankingThemeScrim");
  drawer.setAttribute("aria-label", "Theme controls");
  drawer.innerHTML = `<div class="banking-controls-head"><span>Hero palette</span><button class="banking-controls-close" type="button" aria-label="Close theme controls">×</button></div><p class="banking-controls-note">Choose the sphere palette. Scroll the page to see the scene respond to its sections.</p><div class="banking-palette-list">${Object.entries(palettes).map(([id, palette]) => `<button class="banking-palette-option" type="button" data-palette="${id}" aria-pressed="${id === activePalette}"><strong>${palette.label}<i class="banking-palette-swatch" style="--swatch:${palette.colors[2]}"></i></strong><p>${palette.description}</p></button>`).join("")}</div>`;
  const closeButton = drawer.querySelector(".banking-controls-close");
  const close = () => {
    drawer.classList.remove("open");
    scrim.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", () => {
    drawer.classList.add("open");
    scrim.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    button.setAttribute("aria-expanded", "true");
    closeButton.focus();
  });
  closeButton.addEventListener("click", close);
  scrim.addEventListener("click", close);
  addEventListener("keydown", event => {
    if (event.key === "Escape") close();
  });
  drawer.querySelectorAll("[data-palette]").forEach(option => {
    option.addEventListener("click", () => {
      activePalette = option.dataset.palette;
      drawer.querySelectorAll("[data-palette]").forEach(item => {
        item.setAttribute("aria-pressed", String(item === option));
      });
      document.body.style.setProperty("--banking-scene-bg", palettes[activePalette].background);
      hemiLight.groundColor.set(palettes[activePalette].colors[2]);
    });
  });
}

function resize() {
  if (!renderer) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, innerWidth < 768 ? 1.25 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  updateFrustum();
  assignHeartTargets();
}

function onVisibilityChange() {
  if (document.hidden) {
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
  } else if (renderer && !frameId) {
    frameId = requestAnimationFrame(animate);
  }
}

function onScroll() {
  progress = scrollY / Math.max(innerHeight, 1);
  const stage = progress > 1.55 ? 2 : progress > 0.7 ? 1 : 0;
  const background = stage === 0
    ? palettes[activePalette].background
    : stage === 1
      ? palettes.voltLime.background
      : palettes.pinkBlush.background;
  document.body.style.setProperty("--banking-scene-bg", background);
}

try {
  if (!canvas || !loader) throw new Error("Banking theme canvas or loader is missing.");
  createScene();
  mountPaletteControls();
  setTimeout(() => {
    if (ready) return;
    ready = true;
    if (!started) {
      balls.forEach(ball => {
        ball.position.copy(ball.shapeTarget);
        ball.mesh.position.copy(ball.position);
      });
    }
    renderer.render(scene, camera);
    beginLoaderExit();
  }, 2500);
  addEventListener("resize", resize);
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("pointermove", event => {
    mouse.x = (event.clientX / innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / innerHeight) * 2 + 1;
  }, { passive: true });
  addEventListener("pointerdown", () => { mouse.down = true; });
  addEventListener("pointerup", () => { mouse.down = false; });
  addEventListener("blur", () => { mouse.down = false; });
  document.addEventListener("visibilitychange", onVisibilityChange);
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches && frameId) {
      cancelAnimationFrame(frameId);
      frameId = 0;
      renderer.render(scene, camera);
    } else if (!reducedMotion.matches && !frameId) {
      frameId = requestAnimationFrame(animate);
    }
  });
  onScroll();
} catch (error) {
  console.error("Banking theme animation initialization failed:", error);
  document.body.classList.remove("banking-animation-loading");
  if (renderer) renderer.dispose();
}
