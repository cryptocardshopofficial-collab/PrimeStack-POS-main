/* ============================================================================
   PrimeStack developer pages — "To The Stars" ocean theme
   Adapted from the Christopher Lis CodePen (THREE.js + GSAP).
   Safe: runs only if THREE + GSAP are available; never throws on failure.
   ========================================================================== */
(function () {
  'use strict';
  if (typeof THREE === 'undefined' || typeof TweenMax === 'undefined') return;
  if (document.querySelector('#ocean-canvas')) return;

  document.documentElement.classList.add('has-ocean');

  // Build canvas + scrim
  var canvas = document.createElement('canvas');
  canvas.id = 'ocean-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);

  var scrim = document.createElement('div');
  scrim.id = 'ocean-scrim';
  document.body.insertBefore(scrim, canvas.nextSibling);

  // Inject the intro/sky/x-mark markup into the page. The intro is the
  // cinematic cover hero; existing page content follows below unchanged.
  function ensureIntro() {
    if (document.querySelector('.ocean-intro')) return;
    var intro = document.createElement('section');
    intro.className = 'ocean-intro';
    intro.innerHTML =
      '<p class="fancy-text">PrimeStack GSN</p>' +
      '<h1>One network.<br><span>Every payment.</span></h1>' +
      '<div class="ocean-button" data-shift>' +
        '<div class="ocean-button__border">' +
          '<span class="ocean-button__plane ocean-button__plane--left"></span>' +
          '<span class="ocean-button__plane ocean-button__plane--right"></span>' +
        '</div>' +
        '<div class="ocean-button__text">To The Stars</div>' +
      '</div>';
    // Place the intro above the navigation (or at the top if no nav exists).
    var nav = document.querySelector('nav');
    document.body.insertBefore(intro, nav || document.body.firstChild);
  }

  // THREE scene -------------------------------------------------------------
  var camera, scene, renderer, plane;
  var raycaster = new THREE.Raycaster();
  var normalizedMouse = { x: 0, y: -180 };

  var darkBlue = { r: 0, g: 52, b: 74 };
  var baseColorRGB = darkBlue;
  var baseColor = 'rgb(' + baseColorRGB.r + ',' + baseColorRGB.g + ',' + baseColorRGB.b + ')';
  var nearStars, farStars, farthestStars;

  function init() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });

    camera.position.z = 50;
    renderer.setClearColor('#121212', 1.0);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // Lights
    var topLight = new THREE.DirectionalLight(0xffffff, 1);
    topLight.position.set(0, 1, 1).normalize();
    scene.add(topLight);

    var bottomLight = new THREE.DirectionalLight(0xffffff, 0.4);
    bottomLight.position.set(1, -1, 1).normalize();
    scene.add(bottomLight);

    var skyLightRight = new THREE.DirectionalLight(0x666666, 0.2);
    skyLightRight.position.set(-1, -1, 0.2).normalize();
    scene.add(skyLightRight);

    var skyLightCenter = new THREE.DirectionalLight(0x666666, 0.2);
    skyLightCenter.position.set(0, -1, 0.2).normalize();
    scene.add(skyLightCenter);

    var skyLightLeft = new THREE.DirectionalLight(0x666666, 0.2);
    skyLightLeft.position.set(1, -1, 0.2).normalize();
    scene.add(skyLightLeft);

    // Ocean plane
    var geometry = new THREE.PlaneGeometry(400, 400, 70, 70);
    var material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      flatShading: true,
      side: THREE.DoubleSide,
      vertexColors: THREE.FaceColors
    });

    geometry.vertices.forEach(function (vertice) {
      vertice.x += (Math.random() - 0.5) * 4;
      vertice.y += (Math.random() - 0.5) * 4;
      vertice.z += (Math.random() - 0.5) * 4;
      vertice.dx = Math.random() - 0.5;
      vertice.dy = Math.random() - 0.5;
      vertice.randomDelay = Math.random() * 5;
    });

    for (var i = 0; i < geometry.faces.length; i++) {
      geometry.faces[i].color.setStyle(baseColor);
      geometry.faces[i].baseColor = baseColorRGB;
    }

    plane = new THREE.Mesh(geometry, material);
    scene.add(plane);

    // Stars
    farthestStars = createStars(1200, 420, '#0952BD');
    farStars = createStars(1200, 370, '#A5BFF0');
    nearStars = createStars(1200, 290, '#118CD6');
    scene.add(farthestStars);
    scene.add(farStars);
    scene.add(nearStars);
    farStars.rotation.x = 0.25;
    nearStars.rotation.x = 0.25;
  }

  function createStars(amount, yDistance, color) {
    var opacity = Math.random();
    var starGeometry = new THREE.Geometry();
    var starMaterial = new THREE.PointsMaterial({ color: color || 0x000000, opacity: opacity });
    for (var i = 0; i < amount; i++) {
      var vertex = new THREE.Vector3();
      vertex.z = (Math.random() - 0.5) * 1500;
      vertex.y = yDistance;
      vertex.x = (Math.random() - 0.5) * 1500;
      starGeometry.vertices.push(vertex);
    }
    return new THREE.Points(starGeometry, starMaterial);
  }

  var timer = 0;

  function render() {
    requestAnimationFrame(render);
    timer += 0.01;
    var vertices = plane.geometry.vertices;
    for (var i = 0; i < vertices.length; i++) {
      vertices[i].x -= (Math.sin(timer + vertices[i].randomDelay) / 40) * vertices[i].dx;
      vertices[i].y += (Math.sin(timer + vertices[i].randomDelay) / 40) * vertices[i].dy;
    }

    raycaster.setFromCamera(normalizedMouse, camera);
    var intersects = raycaster.intersectObjects([plane]);
    if (intersects.length > 0) {
      var faceBaseColor = intersects[0].face.baseColor;
      plane.geometry.faces.forEach(function (face) {
        face.color.r *= 255;
        face.color.g *= 255;
        face.color.b *= 255;
        face.color.r += (faceBaseColor.r - face.color.r) * 0.01;
        face.color.g += (faceBaseColor.g - face.color.g) * 0.01;
        face.color.b += (faceBaseColor.b - face.color.b) * 0.01;
        var newColor = 'rgb(' + Math.floor(face.color.r) + ',' + Math.floor(face.color.g) + ',' + Math.floor(face.color.b) + ')';
        face.color.setStyle(newColor);
      });
      plane.geometry.colorsNeedUpdate = true;
      intersects[0].face.color.setStyle('#006ea0');
      plane.geometry.colorsNeedUpdate = true;
    }

    plane.geometry.verticesNeedUpdate = true;
    plane.geometry.elementsNeedUpdate = true;

    farthestStars.rotation.y -= 0.00001;
    farStars.rotation.y -= 0.00005;
    nearStars.rotation.y -= 0.00011;

    renderer.render(scene, camera);
  }

  init();

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('mousemove', function (event) {
    normalizedMouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    normalizedMouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  });

  render();

  // Interactions ------------------------------------------------------------
  var skyContainer = document.querySelector('.ocean-sky');
  var xMark = document.querySelector('.ocean-xmark');

  function shiftToSky() {
    var timeline = new TimelineMax();
    timeline.add([
      TweenLite.to(camera.rotation, 3, { x: Math.PI / 2, ease: Power3.easeInOut }),
      TweenLite.to(camera.position, 2.5, { z: 20, ease: Power3.easeInOut }),
      TweenLite.to(camera.position, 3, { y: 120, ease: Power3.easeInOut }),
      TweenLite.to(plane.scale, 3, { x: 2, ease: Power3.easeInOut })
    ]);
    timeline.add(function () {
      if (skyContainer) skyContainer.classList.add('is-visible');
      if (xMark) xMark.classList.add('is-visible');
    });
  }

  function returnToOcean() {
    if (skyContainer) skyContainer.classList.remove('is-visible');
    if (xMark) xMark.classList.remove('is-visible');
    var timeline = new TimelineMax();
    timeline.add([
      TweenLite.to(camera.rotation, 3, { x: 0, ease: Power3.easeInOut }),
      TweenLite.to(camera.position, 3, { z: 50, ease: Power3.easeInOut }),
      TweenLite.to(camera.position, 2.5, { y: 0, ease: Power3.easeInOut }),
      TweenLite.to(plane.scale, 3, { x: 1, ease: Power3.easeInOut })
    ]);
  }

  document.addEventListener('click', function (event) {
    var shiftBtn = event.target.closest('[data-shift]');
    if (shiftBtn) { shiftToSky(); return; }
    if (event.target.closest('.ocean-xmark')) { returnToOcean(); }
  });

  // Add sky + x-mark markup if absent
  if (!skyContainer) {
    skyContainer = document.createElement('div');
    skyContainer.className = 'ocean-sky';
    skyContainer.innerHTML =
      '<div class="ocean-sky__col ocean-sky__col--left">' +
        '<h2>PrimeStack</h2><h2 class="ocean-sky__track">Global</h2>' +
      '</div>' +
      '<div class="ocean-sky__col ocean-sky__col--right">' +
        '<h2>GSN</h2><h2>2026</h2>' +
      '</div>';
    document.body.appendChild(skyContainer);
  }
  if (!xMark) {
    xMark = document.createElement('div');
    xMark.className = 'ocean-xmark';
    xMark.innerHTML = '<div class="ocean-xmark__inner"><span class="ocean-xmark__bar ocean-xmark__bar--left"></span><span class="ocean-xmark__bar ocean-xmark__bar--right"></span></div>';
    document.body.appendChild(xMark);
  }

  ensureIntro();
})();
