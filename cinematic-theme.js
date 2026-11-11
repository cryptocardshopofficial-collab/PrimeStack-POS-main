/* =============================================================================
   PrimeStack — "Laocoön" cinematic theme behaviour
   Injected by cinematic-theme.css consumers. Provides:
     1. liquid-metal WebGL backdrop (port of the CodePen fragment shader)
     2. editorial grid frame with drifting dots
     3. two-part custom cursor
     4. character-by-character blur reveal for headlines
   Degrades safely: without WebGL / on reduced motion / on small screens the
   page keeps its CSS-only bronze-on-black appearance.
   ============================================================================= */

(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const THREE_CDN = 'https://unpkg.com/three@0.160.0/build/three.module.js';

  /* ----------------------------------------------------------- grid frame */
  function mountFrame() {
    const frame = document.createElement('div');
    frame.className = 'cine-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.innerHTML =
      '<div class="cine-frame-h"></div>' +
      '<div class="cine-frame-lines">' +
      Array.from({ length: 5 }, () =>
        '<div class="cine-frame-line"><i class="cine-dot"></i></div>'
      ).join('') +
      '</div>';
    document.body.insertBefore(frame, document.body.firstChild);
    return frame;
  }

  function mountCursor() {
    if (!finePointer) return null;
    const inner = document.createElement('div');
    inner.className = 'cine-cursor-inner';
    inner.setAttribute('aria-hidden', 'true');
    const outer = document.createElement('div');
    outer.className = 'cine-cursor-outer';
    outer.setAttribute('aria-hidden', 'true');
    document.body.append(inner, outer);

    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let outerX = x;
    let outerY = y;

    document.addEventListener('pointermove', (event) => {
      x = event.clientX;
      y = event.clientY;
      // transform (compositor-only) instead of left/top (forces layout)
      inner.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      document.body.classList.add('cine-cursor-on');
    }, { passive: true });

    document.addEventListener('pointerover', (event) => {
      const interactive = event.target.closest('a, button, .card, .module-card, .filter, input, select, textarea');
      outer.classList.toggle('is-hover', Boolean(interactive));
    }, { passive: true });

    document.addEventListener('pointerdown', () => document.body.classList.add('cine-cursor-on'));

    document.addEventListener('mouseleave', () => {
      document.body.classList.remove('cine-cursor-on');
    });

    const loop = () => {
      requestAnimationFrame(loop);
      if (document.hidden) return;
      outerX += (x - outerX) * 0.2;
      outerY += (y - outerY) * 0.2;
      outer.style.transform = `translate3d(${outerX}px, ${outerY}px, 0) translate(-50%, -50%)`;
    };
    loop();

    return { inner, outer };
  }

  /* ------------------------------------------------ headline char reveal */
  function splitIntoChars(el) {
    if (!el || el.dataset.cineSplit === 'true') return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let index = 0;
    textNodes.forEach((node) => {
      const fragment = document.createDocumentFragment();
      const parts = node.nodeValue.match(/\s+|\S+/g) || [];
      for (const part of parts) {
        if (/^\s+$/.test(part)) {
          fragment.appendChild(document.createTextNode(part));
          continue;
        }
        const word = document.createElement('span');
        word.className = 'cine-word';
        for (const char of part) {
          const span = document.createElement('span');
          span.className = 'cine-char';
          span.style.transitionDelay = `${(index * 0.035).toFixed(3)}s`;
          span.textContent = char;
          word.appendChild(span);
          index += 1;
        }
        fragment.appendChild(word);
      }
      node.parentNode.replaceChild(fragment, node);
    });

    el.dataset.cineSplit = 'true';
    el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim());
  }

  function setupHeadlineReveal() {
    if (reduceMotion) return;
    const targets = document.querySelectorAll(
      '.hero h1, .hero h2, .section-heading h2, .section-title, .cta-box h2, ' +
      'h1, .story-details h2, .module-section > .section-heading h2'
    );
    if (!targets.length) return;

    const seen = new Set();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('cine-in');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px' });

    targets.forEach((el) => {
      if (seen.has(el) || !el.textContent.trim()) return;
      seen.add(el);
      splitIntoChars(el);
      if (!el.querySelector('.cine-char')) return;
      const alreadyVisible = el.getBoundingClientRect().top < window.innerHeight * 0.9;
      if (alreadyVisible) {
        requestAnimationFrame(() => el.classList.add('cine-in'));
      } else {
        observer.observe(el);
      }
    });
  }

  /* --------------------------------------------------------- grid dots */
  function setupGridDots(frame) {
    if (!frame || reduceMotion) return;
    const dots = Array.from(frame.querySelectorAll('.cine-dot'));
    if (!dots.length) return;

    let frameId = 0;
    let maxScroll = 1;
    const trackHeights = dots.map(() => 0);

    // Measure once (and on resize) so the scroll handler never reads layout.
    const measure = () => {
      maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
      dots.forEach((dot, i) => {
        trackHeights[i] = dot.parentElement ? dot.parentElement.clientHeight : 0;
      });
    };

    const apply = () => {
      frameId = 0;
      const progress = Math.min(window.scrollY / maxScroll, 1);
      dots.forEach((dot, i) => {
        const startY = ((i * 17) % 80) + 10;
        let speed = (90 + (i * 55)) % 180;
        if (i % 2 === 0) speed = -speed;
        const y = (((startY + progress * speed) % 100) + 100) % 100;
        // compositor-only translate, centred on the dot's -3px offset
        dot.style.transform = `translate3d(0, ${(y / 100) * trackHeights[i] - 3}px, 0)`;
      });
    };

    const onScroll = () => {
      if (!frameId) frameId = requestAnimationFrame(apply);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure, { passive: true });
    measure();
    apply();
  }

  /* ------------------------------------------------ liquid metal backdrop */
  async function mountBackdrop() {
    if (reduceMotion || window.innerWidth < 780) return;
    if (!window.WebGLRenderingContext) return;

    const canvas = document.createElement('canvas');
    canvas.id = 'cine-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild);

    const vertexShader = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      varying vec2 vUv;
      uniform float uTime;
      uniform vec2 uResolution;
      uniform vec2 uMouse;
      uniform float uScroll;

      float hash(float n) { return fract(sin(n) * 43758.5453123); }
      float noise(in vec3 x) {
        vec3 p = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        float n = p.x + p.y * 57.0 + 113.0 * p.z;
        return mix(mix(mix(hash(n + 0.0), hash(n + 1.0), f.x),
                       mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y),
                   mix(mix(hash(n + 113.0), hash(n + 114.0), f.x),
                       mix(hash(n + 170.0), hash(n + 171.0), f.x), f.y), f.z);
      }

      void main() {
        vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;
        float aspect = uResolution.x / uResolution.y;
        float time = uTime * 0.08;
        float scroll = uScroll;

        float angle1 = 0.6;
        float angle2 = -0.7;
        float angle3 = 1.2;
        float freq1 = 2.4;
        float freq2 = 3.2;
        float freq3 = 4.0;

        vec2 warpedUv = uv;
        float scrollDeform = scroll * 5.0;
        warpedUv.x += sin(uv.y * 2.5 + time * 0.2 + scrollDeform) * 0.35;
        warpedUv.y += cos(uv.x * 2.5 - time * 0.15 - scrollDeform * 0.8) * 0.35;
        warpedUv.x += sin(uv.y * 1.2 - time * 0.1 - scrollDeform * 1.5) * 0.25;
        warpedUv.y += cos(uv.x * 1.2 + time * 0.18 + scrollDeform * 1.2) * 0.25;

        vec2 scrollDrift = vec2(scroll * 0.04, -scroll * 0.02);
        vec2 mouseShift = vec2(uMouse.x * aspect * 0.05, uMouse.y * 0.05);
        warpedUv += scrollDrift + mouseShift;

        vec2 dir1 = vec2(cos(angle1), sin(angle1));
        vec2 dir2 = vec2(cos(angle2), sin(angle2));
        vec2 dir3 = vec2(cos(angle3), sin(angle3));
        float w1 = sin(dot(warpedUv, dir1) * freq1 + time);
        float w2 = cos(dot(warpedUv, dir2) * freq2 - time * 1.4 + w1 * 0.4);
        float w3 = sin(dot(warpedUv, dir3) * freq3 + time * 1.8 + w2 * 0.5);
        float waveField = w1 * 0.50 + w2 * 0.35 + w3 * 0.15;

        float wideSheen = pow(max(0.0, 1.0 - abs(waveField - 0.1)), 2.5);
        float crispSpecular = pow(max(0.0, 1.0 - abs(waveField - 0.15)), 8.0);
        float crest = wideSheen * 0.5 + crispSpecular * 0.9;

        vec3 c0_shadow = vec3(0.0010, 0.0006, 0.0004);
        vec3 c0_wave1 = vec3(0.085, 0.040, 0.015);
        vec3 c0_wave2 = vec3(0.050, 0.022, 0.008);
        vec3 c0_crest = vec3(0.45, 0.30, 0.18);
        vec3 c1_shadow = vec3(0.0004, 0.0006, 0.0012);
        vec3 c1_wave1 = vec3(0.015, 0.035, 0.065);
        vec3 c1_wave2 = vec3(0.008, 0.020, 0.045);
        vec3 c1_crest = vec3(0.18, 0.35, 0.55);

        float t = smoothstep(0.0, 1.0, scroll);
        vec3 colShadow = mix(c0_shadow, c1_shadow, t);
        vec3 colWave1 = mix(c0_wave1, c1_wave1, t);
        vec3 colWave2 = mix(c0_wave2, c1_wave2, t);
        vec3 colCrest = mix(c0_crest, c1_crest, t);

        vec3 color = colShadow;
        color = mix(color, colWave2, smoothstep(-0.6, 0.2, waveField));
        color = mix(color, colWave1, smoothstep(0.0, 0.8, waveField));
        color += colCrest * crest * 1.4;
        float vignette = 1.0 - dot(uv, uv) * 0.12;
        color *= vignette;
        gl_FragColor = vec4(color, 1.0);
      }
    `;

    let THREE;
    try {
      THREE = await import(/* @vite-ignore */ THREE_CDN);
    } catch (error) {
      console.warn('[cinematic-theme] WebGL backdrop unavailable:', error);
      canvas.remove();
      return;
    }

    try {
      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance'
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
      renderer.setSize(window.innerWidth, window.innerHeight);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#000000');
      const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
      camera.position.set(0, 0, 3);
      scene.add(camera);

      const uniforms = {
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uMouse: { value: new THREE.Vector2(0, 0) },
        uScroll: { value: 0 }
      };

      const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
        depthWrite: false,
        depthTest: false
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), material);
      mesh.position.set(0, 0, -8);
      mesh.renderOrder = -10;
      camera.add(mesh);

      let targetMouseX = 0;
      let targetMouseY = 0;
      let mouseX = 0;
      let mouseY = 0;
      let currentScroll = 0;

      window.addEventListener('pointermove', (event) => {
        targetMouseX = (event.clientX / window.innerWidth) * 2 - 1;
        targetMouseY = (event.clientY / window.innerHeight) * 2 - 1;
      }, { passive: true });

      const resize = () => {
        const width = window.innerWidth;
        const height = window.innerHeight;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
        uniforms.uResolution.value.set(width, height);
      };
      window.addEventListener('resize', resize);

      const clock = new THREE.Clock();
      // The backdrop is decorative: 30fps is visually identical to 60fps here
      // but leaves the main/compositor thread free so scrolling stays smooth.
      const frameInterval = 1000 / 30;
      let lastFrame = 0;

      const render = (now) => {
        requestAnimationFrame(render);
        if (document.hidden || now - lastFrame < frameInterval) return;
        lastFrame = now;

        const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
        const targetScroll = window.scrollY / maxScroll;
        // larger factors because the loop runs at half the frame budget
        currentScroll += (targetScroll - currentScroll) * 0.05;
        mouseX += (targetMouseX - mouseX) * 0.09;
        mouseY += (targetMouseY - mouseY) * 0.09;

        uniforms.uTime.value = clock.getElapsedTime();
        uniforms.uMouse.value.set(mouseX, -mouseY);
        uniforms.uScroll.value = currentScroll;

        renderer.render(scene, camera);
      };

      requestAnimationFrame(render);
    } catch (error) {
      console.warn('[cinematic-theme] WebGL backdrop failed to start:', error);
      canvas.remove();
    }
  }

  function boot() {
    const frame = mountFrame();
    mountCursor();
    setupGridDots(frame);
    setupHeadlineReveal();
    mountBackdrop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
