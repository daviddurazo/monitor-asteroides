// Simulador 3D del sobrevuelo: posiciones reales de JPL Horizons (guardadas en MySQL por el
// ingestor) y texturas de la NASA para la Tierra, la Luna y el cielo. El asteroide es una roca
// genérica: no existen imágenes de estos objetos.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

// Unidades de escena: 1 = 1000 km. Marco: eclíptica J2000 con la Tierra en el origen (el mismo
// que devuelve Horizons), con +z hacia el norte de la eclíptica.
const KM = 1 / 1000;
const DL_KM = 384400;
const R_TIERRA_KM = 6371;
const R_LUNA_KM = 1737.4;
const R_SOL_KM = 696000;
const EXAGERACION = 10;             // Tierra y Luna en modo "tamaños exagerados"
const R_ASTEROIDE_EXAGERADO = 12;   // unidades de escena (12 000 km)
const OBLICUIDAD = THREE.MathUtils.degToRad(23.4392911);
const NORTE_ECLIPTICA = new THREE.Vector3(0, 0, 1);

const $ = (selector) => document.querySelector(selector);
const id = new URLSearchParams(location.search).get('id');

function avisar(texto) {
  $('#cargando').textContent = texto;
  $('#cargando').hidden = false;
}

if (!id) {
  avisar('Elige un asteroide en el selector para ver su sobrevuelo.');
} else {
  iniciar().catch((error) => {
    console.error(error);
    avisar('No se pudo cargar el sobrevuelo. Revisa que el dashboard pueda leer MySQL.');
  });
}

// --------------------------------------------------------------------------- Utilidades

const numero = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
const fechaUTC = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function cuentaAtras(ms) {
  const minutos = Math.round(Math.abs(ms) / 60000);
  const horas = Math.floor(minutos / 60);
  const texto = horas >= 48 ? `${Math.floor(horas / 24)} d ${horas % 24} h`
    : `${horas} h ${String(minutos % 60).padStart(2, '0')} min`;
  return ms < 0 ? `Faltan ${texto} para la máxima aproximación`
    : `${texto} después de la máxima aproximación`;
}

/** Ángulo de rotación de la Tierra (tiempo sidéreo medio de Greenwich) en radianes. */
function anguloSideral(ms) {
  const dias = ms / 86400000 + 2440587.5 - 2451545.0;
  return THREE.MathUtils.degToRad((280.46061837 + 360.98564736629 * dias) % 360);
}

function aleatorio(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roca irregular y reproducible a partir del id del asteroide. */
function geometriaRoca(semilla) {
  const azar = aleatorio(semilla);
  const geometria = new THREE.IcosahedronGeometry(1, 5);
  const ondas = Array.from({ length: 7 }, () => ({
    direccion: new THREE.Vector3(azar() - 0.5, azar() - 0.5, azar() - 0.5).normalize(),
    frecuencia: 2 + azar() * 9, amplitud: 0.03 + azar() * 0.07, fase: azar() * Math.PI * 2,
  }));
  const estiramiento = new THREE.Vector3(1 + azar() * 0.5, 0.75 + azar() * 0.2, 0.65 + azar() * 0.2);
  const posiciones = geometria.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < posiciones.count; i++) {
    v.fromBufferAttribute(posiciones, i);
    let radio = 1;
    for (const o of ondas) radio += o.amplitud * Math.sin(o.frecuencia * v.dot(o.direccion) + o.fase);
    v.multiplyScalar(radio).multiply(estiramiento);
    posiciones.setXYZ(i, v.x, v.y, v.z);
  }
  geometria.computeVertexNormals();
  return geometria;
}

function texturaResplandor() {
  const lienzo = document.createElement('canvas');
  lienzo.width = lienzo.height = 128;
  const ctx = lienzo.getContext('2d');
  const degradado = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  degradado.addColorStop(0, 'rgba(255,255,255,1)');
  degradado.addColorStop(0.12, 'rgba(255,246,220,0.95)');
  degradado.addColorStop(0.35, 'rgba(255,205,130,0.25)');
  degradado.addColorStop(1, 'rgba(255,180,90,0)');
  ctx.fillStyle = degradado;
  ctx.fillRect(0, 0, 128, 128);
  const textura = new THREE.CanvasTexture(lienzo);
  textura.colorSpace = THREE.SRGBColorSpace;
  return textura;
}

// Tierra: textura de día iluminada por el Sol, luces de ciudades en el lado nocturno y
// un borde azulado de atmósfera.
const SOMBREADOR_TIERRA = {
  vertexShader: /* glsl */ `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPos;
    void main() {
      vUv = uv;
      vNormal = normalize(mat3(modelMatrix) * normal);
      vec4 mundo = modelMatrix * vec4(position, 1.0);
      vPos = mundo.xyz;
      gl_Position = projectionMatrix * viewMatrix * mundo;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    #include <logdepthbuf_pars_fragment>
    uniform sampler2D mapaDia;
    uniform sampler2D mapaNoche;
    uniform sampler2D mapaNubes;
    uniform vec3 dirSol;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPos;
    void main() {
      #include <logdepthbuf_fragment>
      vec3 n = normalize(vNormal);
      float luz = dot(n, dirSol);
      float nubes = texture2D(mapaNubes, vUv).r;
      vec3 dia = mix(texture2D(mapaDia, vUv).rgb, vec3(0.9), nubes * 0.8);
      dia *= clamp(luz, 0.0, 1.0) * 1.1 + 0.015;
      vec3 noche = texture2D(mapaNoche, vUv).rgb * (1.0 - nubes * 0.6);
      vec3 color = mix(noche, dia, smoothstep(-0.12, 0.12, luz));
      vec3 vista = normalize(cameraPosition - vPos);
      float borde = pow(1.0 - clamp(dot(n, vista), 0.0, 1.0), 3.0);
      color += vec3(0.25, 0.5, 1.0) * borde * smoothstep(-0.25, 0.4, luz);
      gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
    }`,
};

// --------------------------------------------------------------------------- Escena

async function iniciar() {
  const respuesta = await fetch(`/api/trayectoria/${encodeURIComponent(id)}`);
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
  const datos = await respuesta.json();

  const lienzo = $('#lienzo');
  const renderer = new THREE.WebGLRenderer({ canvas: lienzo, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(45, 1, 1e-6, 1e7);
  camara.up.copy(NORTE_ECLIPTICA);
  const controles = new OrbitControls(camara, lienzo);
  controles.enableDamping = true;
  controles.enablePan = false;  // la cámara siempre gira alrededor del cuerpo que sigue

  // Zona vertical que no tapan los paneles anchos (en móvil, la ficha y la barra de tiempo).
  let fraccionLibre = 1;
  function ajustar() {
    const { clientWidth: ancho, clientHeight: alto } = lienzo;
    let arriba = 0;
    let abajo = alto;
    for (const caja of document.querySelectorAll('.caja:not([hidden])')) {
      const r = caja.getBoundingClientRect();
      if (r.width < ancho * 0.5) continue;
      if (r.top + r.height / 2 < alto / 2) arriba = Math.max(arriba, r.bottom);
      else abajo = Math.min(abajo, r.top);
    }
    fraccionLibre = Math.max(0.3, (abajo - arriba) / alto);
    renderer.setSize(ancho, alto, false);
    camara.aspect = ancho / alto;
    // Desplaza el centro de la imagen al centro de la zona libre.
    camara.setViewOffset(ancho, alto, 0, alto / 2 - (arriba + abajo) / 2, ancho, alto);
    camara.updateProjectionMatrix();
  }
  new ResizeObserver(ajustar).observe(lienzo);
  ajustar();

  // Texturas
  const gestor = new THREE.LoadingManager();
  const texturasListas = new Promise((resolver, rechazar) => {
    gestor.onLoad = resolver;
    gestor.onError = (url) => rechazar(new Error(`No se pudo cargar ${url}`));
  });
  const cargador = new THREE.TextureLoader(gestor);
  const anisotropia = renderer.capabilities.getMaxAnisotropy();
  function textura(archivo, esColor = true) {
    const t = cargador.load(`texturas/${archivo}`);
    if (esColor) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = anisotropia;
    return t;
  }
  // Esfera con el polo norte en +z y la longitud 0 (centro de la textura) en +x.
  function esfera(segmentos) {
    const geometria = new THREE.SphereGeometry(1, segmentos, segmentos / 2);
    geometria.rotateX(Math.PI / 2);
    return geometria;
  }

  // Cielo: el mapa de estrellas está en coordenadas ecuatoriales (ascensión recta creciendo
  // hacia la izquierda), así que se invierte en horizontal y se inclina a la eclíptica.
  const texturaCielo = textura('estrellas.jpg');
  texturaCielo.wrapS = THREE.RepeatWrapping;
  texturaCielo.repeat.x = -1;
  const cielo = new THREE.Mesh(esfera(64), new THREE.MeshBasicMaterial({
    map: texturaCielo, side: THREE.BackSide, depthWrite: false, color: new THREE.Color().setScalar(1.6),
  }));
  cielo.scale.setScalar(1e6);
  cielo.rotation.x = -OBLICUIDAD;
  cielo.renderOrder = -1;
  escena.add(cielo);

  // Tierra: el grupo inclina el ecuador respecto a la eclíptica y la malla gira con la hora.
  const uniformesTierra = {
    mapaDia: { value: textura('tierra_dia.jpg') },
    mapaNoche: { value: textura('tierra_noche.jpg') },
    mapaNubes: { value: textura('nubes.jpg', false) },
    dirSol: { value: new THREE.Vector3(1, 0, 0) },
  };
  const tierra = new THREE.Mesh(esfera(128), new THREE.ShaderMaterial({ uniforms: uniformesTierra, ...SOMBREADOR_TIERRA }));
  const ejeTierra = new THREE.Group();
  ejeTierra.rotation.x = -OBLICUIDAD;
  ejeTierra.add(tierra);
  escena.add(ejeTierra);

  const luna = new THREE.Mesh(esfera(64), new THREE.MeshStandardMaterial({ map: textura('luna.jpg'), roughness: 1, metalness: 0 }));
  escena.add(luna);

  const semilla = [...String(datos.id_neo)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);
  const asteroide = new THREE.Mesh(geometriaRoca(semilla), new THREE.MeshStandardMaterial({
    color: 0x8a8178, roughness: 1, metalness: 0, flatShading: true,
  }));
  const ejeGiro = new THREE.Vector3(0.3, 0.2, 1).normalize();
  escena.add(asteroide);

  const sol = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texturaResplandor(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  sol.scale.setScalar(R_SOL_KM * KM * 2 * 8);
  escena.add(sol);
  const luzSol = new THREE.DirectionalLight(0xffffff, 3);
  escena.add(luzSol, new THREE.AmbientLight(0xffffff, 0.04));

  // Trayectorias
  const vectores = (lista) => lista.map(([x, y, z]) => new THREE.Vector3(x * KM, y * KM, z * KM));
  const pAsteroide = vectores(datos.asteroide);
  const pLuna = vectores(datos.luna);
  const pSol = datos.sol ? vectores(datos.sol) : null;
  function linea(puntos, color, opacidad) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(puntos),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: opacidad, depthWrite: false }));
    l.frustumCulled = false;
    return l;
  }
  const rutaAsteroide = linea(pAsteroide, 0xd95926, 0.28);
  const estela = linea(pAsteroide, 0xff8a55, 0.95);
  escena.add(rutaAsteroide, estela, linea(pLuna, 0xc3c2b7, 0.35));

  const t = datos.t;
  const n = t.length;
  const t0 = t[0];
  const t1 = t[n - 1];
  const iPaso = pAsteroide.reduce((mejor, p, i) => (p.lengthSq() < pAsteroide[mejor].lengthSq() ? i : mejor), 0);
  const centroGeneral = new THREE.Vector3();  // lo calcula encuadrarGeneral()

  function interpolar(puntos, ms, destino) {
    const f = THREE.MathUtils.clamp((ms - t0) / (t1 - t0), 0, 1) * (n - 1);
    const i = Math.min(Math.floor(f), n - 2);
    return destino.lerpVectors(puntos[i], puntos[i + 1], f - i);
  }

  // Ficha
  $('#nombre').textContent = datos.nombre;
  $('#fecha-paso').textContent = fechaUTC(datos.fecha_ms);
  $('#distancia-min').textContent = `${numero.format(datos.distancia_km)} km (${(datos.distancia_km / DL_KM).toFixed(2)} DL)`;
  $('#diametro').textContent = `≈ ${numero.format(datos.diametro_m)} m`;
  $('#clasificacion').textContent = datos.peligroso ? 'Potencialmente peligroso' : 'No peligroso';

  // Etiquetas HTML que siguen a los cuerpos, en orden de prioridad (si se tapan, gana la primera).
  const etiquetas = [];
  function etiqueta(texto, clase, posicion, cuerpo = null) {
    const el = document.createElement('div');
    el.className = `etiqueta ${clase}`;
    el.textContent = texto;
    $('#etiquetas').append(el);
    etiquetas.push({ el, posicion, cuerpo });
  }

  // Estado
  const posiciones = { tierra: new THREE.Vector3(), luna: new THREE.Vector3(), asteroide: new THREE.Vector3(), sol: new THREE.Vector3(1e5, 0, 0) };
  let exagerado = true;
  let seguir = 'general';
  let tiempo = t0;
  let reproduciendo = true;
  let velocidad = Number($('#velocidad').value);

  function radioVisual(cuerpo) {
    if (cuerpo === 'tierra') return R_TIERRA_KM * KM * (exagerado ? EXAGERACION : 1);
    if (cuerpo === 'luna') return R_LUNA_KM * KM * (exagerado ? EXAGERACION : 1);
    if (cuerpo === 'sol') return R_SOL_KM * KM;
    if (cuerpo === 'asteroide') return exagerado ? R_ASTEROIDE_EXAGERADO : (datos.diametro_m / 2000) * KM;
    return 0;
  }

  etiqueta(datos.nombre, 'asteroide', posiciones.asteroide, 'asteroide');
  etiqueta('Tierra', 'tierra', posiciones.tierra, 'tierra');
  etiqueta('Luna', 'luna', posiciones.luna, 'luna');
  etiqueta('Máxima aproximación', 'paso', pAsteroide[iPaso]);
  etiqueta('Sol', 'luna', posiciones.sol, 'sol');

  function aplicarEscala() {
    tierra.scale.setScalar(radioVisual('tierra'));
    luna.scale.setScalar(radioVisual('luna'));
    asteroide.scale.setScalar(radioVisual('asteroide'));
  }

  /**
   * Vista general mirando desde `direccion`: centra la Tierra y la trayectoria en los ejes de la
   * cámara y devuelve la distancia a la que caben en la zona libre de paneles.
   */
  function encuadrarGeneral(direccion) {
    const orientacion = new THREE.Matrix4().lookAt(direccion, new THREE.Vector3(), camara.up);
    const derecha = new THREE.Vector3().setFromMatrixColumn(orientacion, 0);
    const arriba = new THREE.Vector3().setFromMatrixColumn(orientacion, 1);
    const puntos = [new THREE.Vector3(), ...pAsteroide];
    const rango = (eje) => {
      const valores = puntos.map((p) => p.dot(eje));
      return [Math.min(...valores), Math.max(...valores)];
    };
    const [x0, x1] = rango(derecha);
    const [y0, y1] = rango(arriba);
    const [z0, z1] = rango(direccion);
    centroGeneral.copy(derecha).multiplyScalar((x0 + x1) / 2)
      .addScaledVector(arriba, (y0 + y1) / 2).addScaledVector(direccion, (z0 + z1) / 2);
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(camara.fov / 2));
    return 1.3 * Math.max((y1 - y0) / 2 / (tanVertical * fraccionLibre),
      (x1 - x0) / 2 / (tanVertical * camara.aspect)) + (z1 - z0) / 2;
  }

  function enfocar(cuerpo) {
    seguir = cuerpo;
    document.querySelectorAll('[data-seguir]').forEach((b) => b.classList.toggle('activo', b.dataset.seguir === cuerpo));
    const objetivo = cuerpo === 'general' ? centroGeneral : posiciones[cuerpo];
    const direccion = camara.position.clone().sub(controles.target);
    if (direccion.lengthSq() === 0) {
      // Primera vista: perpendicular al plano de la trayectoria, desde el lado norte.
      direccion.crossVectors(pAsteroide[0], pAsteroide[n - 1]);
      if (direccion.z < 0) direccion.negate();
      if (direccion.lengthSq() === 0) direccion.set(0, -1, 1);
      direccion.normalize().add(new THREE.Vector3(0.2, -0.3, 0));
    }
    direccion.normalize();
    const distancia = cuerpo === 'general' ? encuadrarGeneral(direccion)
      : radioVisual(cuerpo) * (cuerpo === 'asteroide' ? 25 : 5);
    controles.target.copy(objetivo);
    camara.position.copy(objetivo).addScaledVector(direccion, distancia);
    controles.minDistance = radioVisual(cuerpo === 'general' ? 'tierra' : cuerpo) * 1.5;
  }

  function ponerReproduccion(activo) {
    reproduciendo = activo;
    $('#reproducir').textContent = activo ? '❚❚' : '▶';
    $('#reproducir').setAttribute('aria-label', activo ? 'Pausar' : 'Reproducir');
  }

  // Controles de la interfaz
  document.querySelectorAll('[data-seguir]').forEach((b) => b.addEventListener('click', () => enfocar(b.dataset.seguir)));
  $('#exagerar').addEventListener('change', (e) => {
    exagerado = e.target.checked;
    aplicarEscala();
    enfocar(seguir);
  });
  $('#reproducir').addEventListener('click', () => {
    if (!reproduciendo && tiempo >= t1) tiempo = t0;
    ponerReproduccion(!reproduciendo);
  });
  $('#velocidad').addEventListener('change', (e) => { velocidad = Number(e.target.value); });
  let arrastrando = false;
  const barra = $('#barra');
  barra.addEventListener('pointerdown', () => { arrastrando = true; });
  window.addEventListener('pointerup', () => { arrastrando = false; });
  barra.addEventListener('input', () => { tiempo = t0 + (barra.value / 1000) * (t1 - t0); });

  // Cada fotograma
  const delta = new THREE.Vector3();
  const ejeX = new THREE.Vector3();
  const ejeY = new THREE.Vector3();
  const ejeZ = new THREE.Vector3();
  const base = new THREE.Matrix4();
  const proyeccion = new THREE.Vector3();

  function actualizar() {
    interpolar(pAsteroide, tiempo, posiciones.asteroide);
    interpolar(pLuna, tiempo, posiciones.luna);
    if (pSol) interpolar(pSol, tiempo, posiciones.sol);

    const dirSol = posiciones.sol.clone().normalize();
    uniformesTierra.dirSol.value.copy(dirSol);
    luzSol.position.copy(dirSol).multiplyScalar(1000);
    sol.position.copy(posiciones.sol);

    tierra.rotation.z = anguloSideral(tiempo);
    luna.position.copy(posiciones.luna);
    // Rotación síncrona: la cara visible (longitud 0) mira siempre a la Tierra.
    ejeX.copy(posiciones.luna).negate().normalize();
    ejeY.crossVectors(NORTE_ECLIPTICA, ejeX).normalize();
    ejeZ.crossVectors(ejeX, ejeY);
    luna.quaternion.setFromRotationMatrix(base.makeBasis(ejeX, ejeY, ejeZ));
    asteroide.position.copy(posiciones.asteroide);
    asteroide.quaternion.setFromAxisAngle(ejeGiro, (tiempo / 3600000) * (Math.PI / 3));

    const f = THREE.MathUtils.clamp((tiempo - t0) / (t1 - t0), 0, 1) * (n - 1);
    const i = Math.min(Math.floor(f), n - 2);
    estela.geometry.setDrawRange(0, i + 1);

    // Seguir al cuerpo elegido trasladando cámara y objetivo juntos.
    const objetivo = seguir === 'general' ? centroGeneral : posiciones[seguir];
    delta.subVectors(objetivo, controles.target);
    controles.target.add(delta);
    camara.position.add(delta);

    if (!arrastrando) barra.value = Math.round(((tiempo - t0) / (t1 - t0)) * 1000);
    const distanciaKm = posiciones.asteroide.length() / KM;
    const rapidez = pAsteroide[i + 1].distanceTo(pAsteroide[i]) / KM / ((t[i + 1] - t[i]) / 1000);
    $('#ahora').textContent = fechaUTC(tiempo);
    $('#cuenta').textContent = cuentaAtras(tiempo - datos.fecha_ms);
    $('#distancia').textContent = `A ${numero.format(distanciaKm)} km de la Tierra (${(distanciaKm / DL_KM).toFixed(2)} DL)`;
    $('#rapidez').textContent = `${rapidez.toFixed(1)} km/s respecto a la Tierra`;
  }

  /** ¿La Tierra o la Luna tapan el punto visto desde la cámara? */
  const rayo = new THREE.Ray();
  const choque = new THREE.Vector3();
  function tapado(posicion, propio) {
    rayo.origin.copy(camara.position);
    rayo.direction.subVectors(posicion, camara.position).normalize();
    const distancia = camara.position.distanceTo(posicion);
    return ['tierra', 'luna'].some((cuerpo) => cuerpo !== propio
      && rayo.intersectSphere(new THREE.Sphere(posiciones[cuerpo], radioVisual(cuerpo)), choque)
      && camara.position.distanceTo(choque) < distancia);
  }

  function colocarEtiquetas() {
    const { clientWidth: ancho, clientHeight: alto } = lienzo;
    const pixelesPorUnidad = alto / (2 * Math.tan(THREE.MathUtils.degToRad(camara.fov / 2)));
    const colocadas = [];
    for (const { el, posicion, cuerpo } of etiquetas) {
      proyeccion.copy(posicion).project(camara);
      const radioPx = (radioVisual(cuerpo) / camara.position.distanceTo(posicion)) * pixelesPorUnidad;
      const x = ((proyeccion.x + 1) / 2) * ancho + (radioPx > 6 ? radioPx : 0);
      const y = ((1 - proyeccion.y) / 2) * alto;
      const visible = proyeccion.z < 1 && Math.abs(proyeccion.x) < 1.05 && Math.abs(proyeccion.y) < 1.05
        && !colocadas.some((p) => Math.abs(p.x - x) < 70 && Math.abs(p.y - y) < 16)
        && !tapado(posicion, cuerpo);
      el.style.display = visible ? '' : 'none';
      if (!visible) continue;
      colocadas.push({ x, y });
      el.classList.toggle('sin-marca', radioPx > 6);
      el.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  await texturasListas;
  $('#cargando').hidden = true;
  for (const caja of ['#ficha', '#vistas', '#tiempo']) $(caja).hidden = false;
  aplicarEscala();
  actualizar();
  ajustar();  // con los paneles visibles y sus textos ya escritos, para medir la zona libre
  enfocar('general');

  const reloj = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(reloj.getDelta(), 0.1);
    if (reproduciendo) {
      tiempo += dt * 1000 * velocidad;
      if (tiempo >= t1) {
        tiempo = t1;
        ponerReproduccion(false);
      }
    }
    actualizar();
    controles.update();
    cielo.position.copy(camara.position);
    renderer.render(escena, camara);
    colocarEtiquetas();
  });
}
