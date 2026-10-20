// Simulador 3D: sobrevuelos con posiciones reales de JPL Horizons (guardadas en MySQL por el
// ingestor) y bólidos de CNEOS sobre el globo. Texturas de la NASA para la Tierra, la Luna y el
// cielo. El asteroide es una roca genérica: no existen imágenes de estos objetos.
//
// Vistas:  ?tipo=acercamiento|evento&id=N  -> sobrevuelo
//          ?vista=bolidos                  -> solo la Tierra con los bólidos, a la hora actual
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

// Unidades de escena: 1 = 1000 km. Marco: eclíptica J2000 con la Tierra en el origen (el mismo
// que devuelve Horizons), con +z hacia el norte de la eclíptica.
const KM = 1 / 1000;
const DL_KM = 384400;
const UA_KM = 149597870.7;
const R_TIERRA_KM = 6371;
const R_LUNA_KM = 1737.4;
const R_SOL_KM = 696000;
const R_GEO_KM = 42164;                  // órbita geoestacionaria (35 786 km de altura)
const R_ISS_KM = R_TIERRA_KM + 420;
const INCLINACION_ISS = THREE.MathUtils.degToRad(51.64);
const EXAGERACION_MAX = 10;              // Tierra y Luna en modo "tamaños exagerados"
const HIROSHIMA_KT = 15;
const OBLICUIDAD = THREE.MathUtils.degToRad(23.4392911);
const NORTE_ECLIPTICA = new THREE.Vector3(0, 0, 1);

const $ = (selector) => document.querySelector(selector);
const parametros = new URLSearchParams(location.search);
const vista = parametros.get('vista') === 'bolidos' ? 'bolidos' : parametros.has('id') ? 'sobrevuelo' : null;

function avisar(texto) {
  $('#cargando').textContent = texto;
  $('#cargando').hidden = false;
}

if (!vista) {
  avisar('Elige un asteroide en el selector para ver su sobrevuelo.');
} else {
  iniciar().catch((error) => {
    console.error(error);
    avisar('No se pudo cargar el simulador. Revisa que el dashboard pueda leer MySQL.');
  });
}

// --------------------------------------------------------------------------- Utilidades

const numero = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
const fechaUTC = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

async function obtener(url) {
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`${url}: HTTP ${respuesta.status}`);
  return respuesta.json();
}

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

/**
 * Posición geocéntrica aproximada del Sol (unidades de escena, eclíptica J2000), con un error
 * de ~0.01°. Se usa cuando no hay posiciones de Horizons (vista de bólidos).
 */
function posicionSol(ms, destino) {
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = THREE.MathUtils.degToRad(357.528 + 0.9856003 * n);
  // Longitud del equinoccio de la fecha menos la precesión acumulada desde J2000.
  const longitud = THREE.MathUtils.degToRad(280.460 + 0.9856474 * n + 1.915 * Math.sin(g)
    + 0.020 * Math.sin(2 * g) - 3.825e-5 * n);
  const distancia = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * UA_KM * KM;
  return destino.set(distancia * Math.cos(longitud), distancia * Math.sin(longitud), 0);
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

/** Roca irregular y reproducible a partir de la designación del asteroide. */
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

/** Circunferencia en el plano XY local. */
function anillo(radio, color, opacidad) {
  const puntos = Array.from({ length: 181 }, (_, i) => {
    const a = (i / 180) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * radio, Math.sin(a) * radio, 0);
  });
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(puntos),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: opacidad, depthWrite: false }));
}

/** Punto de la superficie (radio 1) en el marco de la Tierra: longitud 0 en +x, norte en +z. */
function puntoGeografico(latitud, longitud, radio = 1) {
  const la = THREE.MathUtils.degToRad(latitud);
  const lo = THREE.MathUtils.degToRad(longitud);
  return new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la))
    .multiplyScalar(radio);
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
  const tipo = parametros.get('tipo') === 'evento' ? 'evento' : 'acercamiento';
  const [vuelo, bolidos] = await Promise.all([
    vista === 'sobrevuelo' ? obtener(`/api/trayectoria/${tipo}/${encodeURIComponent(parametros.get('id'))}`) : null,
    // Sin bólidos el simulador sigue funcionando.
    obtener('/api/bolidos').catch((error) => { console.warn(error); return []; }),
  ]);

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
    for (const caja of document.querySelectorAll('.caja:not([hidden]):not(#tooltip)')) {
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

  // Órbitas de referencia en el plano del ecuador (no giran con la Tierra).
  const anilloGeo = anillo(R_GEO_KM * KM, 0x7fb2f0, 0.55);
  const anilloIss = anillo(R_ISS_KM * KM, 0xc3c2b7, 0.6);
  anilloIss.rotation.x = INCLINACION_ISS;
  ejeTierra.add(anilloGeo, anilloIss);
  ejeTierra.updateMatrixWorld(true);
  const puntoGeo = anilloGeo.localToWorld(new THREE.Vector3(R_GEO_KM * KM, 0, 0));
  const puntoIss = anilloIss.localToWorld(new THREE.Vector3(0, R_ISS_KM * KM, 0));

  // Bólidos: esferas en la superficie, hijas de la Tierra para que giren con ella. Tamaño y color
  // según la energía (escala logarítmica).
  const maxKt = Math.max(1, ...bolidos.map((b) => b[3] ?? 0));
  const fuerza = (kt) => Math.log10(1 + (kt ?? 0.05) * 10) / Math.log10(1 + maxKt * 10);
  const mallaBolidos = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, bolidos.length));
  mallaBolidos.count = bolidos.length;
  {
    const matriz = new THREE.Matrix4();
    const sinGiro = new THREE.Quaternion();
    const color = new THREE.Color();
    const tenue = new THREE.Color(0xffd166);
    const intenso = new THREE.Color(0xff3d00);
    bolidos.forEach(([, latitud, longitud, kt], i) => {
      const f = fuerza(kt);
      const radio = 0.007 + 0.035 * f;
      matriz.compose(puntoGeografico(latitud, longitud), sinGiro, new THREE.Vector3(radio, radio, radio));
      mallaBolidos.setMatrixAt(i, matriz);
      mallaBolidos.setColorAt(i, color.copy(tenue).lerp(intenso, f));
    });
  }
  tierra.add(mallaBolidos);
  const iMayor = bolidos.reduce((mejor, b, i) => ((b[3] ?? 0) > (bolidos[mejor]?.[3] ?? 0) ? i : mejor), 0);
  const localMayor = bolidos.length ? puntoGeografico(bolidos[iMayor][1], bolidos[iMayor][2], 1.02) : null;

  const luna = new THREE.Mesh(esfera(64), new THREE.MeshStandardMaterial({ map: textura('luna.jpg'), roughness: 1, metalness: 0 }));
  luna.visible = Boolean(vuelo);
  escena.add(luna);

  const semilla = [...String(vuelo?.designacion ?? '')].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);
  const asteroide = new THREE.Mesh(geometriaRoca(semilla), new THREE.MeshStandardMaterial({
    color: 0x8a8178, roughness: 1, metalness: 0, flatShading: true,
  }));
  asteroide.visible = Boolean(vuelo);
  const ejeGiro = new THREE.Vector3(0.3, 0.2, 1).normalize();
  escena.add(asteroide);

  const sol = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texturaResplandor(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  sol.scale.setScalar(R_SOL_KM * KM * 2 * 8);
  escena.add(sol);
  const luzSol = new THREE.DirectionalLight(0xffffff, 3);
  escena.add(luzSol, new THREE.AmbientLight(0xffffff, 0.04));

  // Trayectorias (solo en sobrevuelos)
  const vectores = (lista) => (lista ?? []).map(([x, y, z]) => new THREE.Vector3(x * KM, y * KM, z * KM));
  const pAsteroide = vectores(vuelo?.asteroide);
  const pLuna = vectores(vuelo?.luna);
  const pSol = vuelo?.sol ? vectores(vuelo.sol) : null;
  function linea(puntos, color, opacidad) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(puntos),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: opacidad, depthWrite: false }));
    l.frustumCulled = false;
    return l;
  }
  const estela = linea(pAsteroide, 0xff8a55, 0.95);
  if (vuelo) escena.add(linea(pAsteroide, 0xd95926, 0.28), estela, linea(pLuna, 0xc3c2b7, 0.35));

  const t = vuelo?.t ?? [];
  const n = t.length;
  const t0 = t[0];
  const t1 = t[n - 1];
  const iPaso = pAsteroide.reduce((mejor, p, i) => (p.lengthSq() < pAsteroide[mejor].lengthSq() ? i : mejor), 0);
  // La vista general encuadra la Tierra y el tramo del sobrevuelo a menos de 6 veces la distancia
  // mínima: en pasos muy cercanos (Apophis) el resto de la trayectoria haría la Tierra invisible.
  const alcanceGeneral = vuelo ? 6 * vuelo.distancia_km * KM : 0;
  const puntosGenerales = pAsteroide.filter((p) => p.length() <= alcanceGeneral);
  const puntosEncuadre = [new THREE.Vector3(), ...(puntosGenerales.length >= 2 ? puntosGenerales : pAsteroide)];
  const centroGeneral = new THREE.Vector3();  // lo calcula encuadrarGeneral()
  // Tamaños exagerados sin que la Tierra llegue a tocar la trayectoria de un paso muy cercano.
  const exageracion = vuelo
    ? THREE.MathUtils.clamp(0.35 * vuelo.distancia_km / R_TIERRA_KM, 1, EXAGERACION_MAX) : 1;

  function interpolar(puntos, ms, destino) {
    const f = THREE.MathUtils.clamp((ms - t0) / (t1 - t0), 0, 1) * (n - 1);
    const i = Math.min(Math.floor(f), n - 2);
    return destino.lerpVectors(puntos[i], puntos[i + 1], f - i);
  }

  // Ficha
  function llenarFicha(tipoFicha, nombre, filas, nota) {
    $('#tipo-ficha').textContent = tipoFicha;
    $('#nombre').textContent = nombre;
    $('#datos-ficha').replaceChildren(...filas.flatMap(([termino, valor]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = termino;
      dd.textContent = valor;
      return [dt, dd];
    }));
    $('#nota-ficha').textContent = nota ?? '';
    $('#nota-ficha').hidden = !nota;
  }
  if (vuelo) {
    const nota = vuelo.distancia_km < R_GEO_KM ? 'Pasará más cerca que los satélites geoestacionarios.'
      : vuelo.distancia_km < DL_KM ? 'Pasará más cerca que la Luna.' : null;
    llenarFicha(vuelo.tipo === 'evento' ? 'Gran acercamiento' : 'Sobrevuelo', vuelo.nombre, [
      ['Máxima aproximación', fechaUTC(vuelo.fecha_ms)],
      ['Distancia mínima', `${numero.format(vuelo.distancia_km)} km (${(vuelo.distancia_km / DL_KM).toFixed(2)} DL)`],
      ['Velocidad', `${vuelo.velocidad_km_s.toFixed(1)} km/s`],
      ['Diámetro', `≈ ${numero.format(vuelo.diametro_m)} m${vuelo.diametro_estimado ? ' (estimado)' : ''}`],
      ['Clasificación', vuelo.peligroso ? 'Potencialmente peligroso' : 'No peligroso'],
    ], nota);
  } else {
    const mayor = bolidos[iMayor];
    const anios = bolidos.map((b) => new Date(b[0]).getUTCFullYear());
    llenarFicha('CNEOS · JPL', `${numero.format(bolidos.length)} bólidos registrados`, bolidos.length ? [
      ['Periodo', `${Math.min(...anios)}–${Math.max(...anios)}`],
      ['Mayor', `${numero.format(mayor[3])} kt · ${fechaUTC(mayor[0]).slice(0, 10)}`],
    ] : [], 'Rocas que se desintegraron en la atmósfera. Tamaño y color indican la energía; pasa el cursor o toca un punto.');
  }

  // Etiquetas HTML que siguen a los cuerpos, en orden de prioridad (si se tapan, gana la primera).
  const etiquetas = [];
  function etiqueta(texto, clase, posicion, cuerpo = null, activa = () => true) {
    const el = document.createElement('div');
    el.className = `etiqueta ${clase}`;
    el.textContent = texto;
    $('#etiquetas').append(el);
    etiquetas.push({ el, posicion, cuerpo, activa });
  }

  // Estado
  const posiciones = { tierra: new THREE.Vector3(), luna: new THREE.Vector3(), asteroide: new THREE.Vector3(), sol: new THREE.Vector3() };
  const posicionMayor = new THREE.Vector3();
  let exagerado = Boolean(vuelo);
  let seguir = vuelo ? 'general' : 'tierra';
  let tiempo = vuelo ? t[Math.max(0, pAsteroide.findIndex((p) => p.length() <= alcanceGeneral))] : Date.now();
  let reproduciendo = true;
  if (!vuelo) $('#velocidad').value = '600';
  let velocidad = Number($('#velocidad').value);

  function radioVisual(cuerpo) {
    const factor = exagerado ? exageracion : 1;
    if (cuerpo === 'tierra') return R_TIERRA_KM * KM * factor;
    if (cuerpo === 'luna') return R_LUNA_KM * KM * factor;
    if (cuerpo === 'sol') return R_SOL_KM * KM;
    if (cuerpo === 'asteroide') {
      return exagerado ? 0.2 * R_TIERRA_KM * KM * exageracion : (vuelo.diametro_m / 2000) * KM;
    }
    return 0;
  }
  const verOrbita = (radioKm) => () => $('#ver-orbitas').checked && radioKm * KM > radioVisual('tierra') * 1.02;

  if (vuelo) etiqueta(vuelo.nombre, 'asteroide', posiciones.asteroide, 'asteroide');
  etiqueta('Tierra', 'tierra', posiciones.tierra, 'tierra');
  if (vuelo) {
    etiqueta('Luna', 'luna', posiciones.luna, 'luna');
    etiqueta('Máxima aproximación', 'paso', pAsteroide[iPaso]);
  }
  if (localMayor) {
    etiqueta(`Mayor bólido · ${new Date(bolidos[iMayor][0]).getUTCFullYear()} · ${numero.format(bolidos[iMayor][3])} kt`,
      'bolido', posicionMayor, null, () => mallaBolidos.visible);
  }
  etiqueta('Órbita geoestacionaria', 'orbita', puntoGeo, null, verOrbita(R_GEO_KM));
  etiqueta('Órbita de la ISS', 'orbita', puntoIss, null, verOrbita(R_ISS_KM));
  etiqueta('Sol', 'luna', posiciones.sol, 'sol');

  function aplicarEscala() {
    tierra.scale.setScalar(radioVisual('tierra'));
    luna.scale.setScalar(radioVisual('luna'));
    if (vuelo) asteroide.scale.setScalar(radioVisual('asteroide'));
    anilloGeo.visible = verOrbita(R_GEO_KM)();
    anilloIss.visible = verOrbita(R_ISS_KM)();
  }

  /**
   * Vista general mirando desde `direccion`: centra la Tierra y el sobrevuelo en los ejes de la
   * cámara y devuelve la distancia a la que caben en la zona libre de paneles.
   */
  function encuadrarGeneral(direccion) {
    const orientacion = new THREE.Matrix4().lookAt(direccion, new THREE.Vector3(), camara.up);
    const derecha = new THREE.Vector3().setFromMatrixColumn(orientacion, 0);
    const arriba = new THREE.Vector3().setFromMatrixColumn(orientacion, 1);
    const rango = (eje) => {
      const valores = puntosEncuadre.map((p) => p.dot(eje));
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

  function direccionInicial() {
    const direccion = new THREE.Vector3();
    if (vuelo) {
      // Perpendicular al plano de la trayectoria, desde el lado norte.
      direccion.crossVectors(pAsteroide[0], pAsteroide[n - 1]);
      if (direccion.z < 0) direccion.negate();
      if (direccion.lengthSq() === 0) direccion.set(0, -1, 1);
      return direccion.normalize().add(new THREE.Vector3(0.2, -0.3, 0)).normalize();
    }
    // Bólidos: desde el lado de día, un poco por encima del ecuador.
    return direccion.copy(posiciones.sol).normalize().add(new THREE.Vector3(0, 0, 0.35)).normalize();
  }

  function enfocar(cuerpo) {
    seguir = cuerpo;
    document.querySelectorAll('[data-seguir]').forEach((b) => b.classList.toggle('activo', b.dataset.seguir === cuerpo));
    const objetivo = cuerpo === 'general' ? centroGeneral : posiciones[cuerpo];
    const direccion = camara.position.clone().sub(controles.target);
    if (direccion.lengthSq() === 0) direccion.copy(direccionInicial());
    direccion.normalize();
    const factor = { asteroide: 25, tierra: vuelo ? 5 : 3.2, luna: 5 }[cuerpo];
    const distancia = cuerpo === 'general' ? encuadrarGeneral(direccion) : radioVisual(cuerpo) * factor;
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
  if (vuelo) {
    $('#texto-exagerar').textContent = `Tamaños exagerados (×${Math.round(exageracion)})`;
    $('#control-exagerar').hidden = exageracion < 1.5;
  } else {
    $('#botones-seguir').hidden = true;
    $('#control-exagerar').hidden = true;
    $('#barra').hidden = true;
  }
  document.querySelectorAll('[data-seguir]').forEach((b) => b.addEventListener('click', () => enfocar(b.dataset.seguir)));
  $('#exagerar').addEventListener('change', (e) => {
    exagerado = e.target.checked;
    aplicarEscala();
    enfocar(seguir);
  });
  $('#ver-bolidos').addEventListener('change', (e) => {
    mallaBolidos.visible = e.target.checked;
    if (!e.target.checked) $('#tooltip').hidden = true;
  });
  $('#ver-orbitas').addEventListener('change', aplicarEscala);
  $('#reproducir').addEventListener('click', () => {
    if (vuelo && !reproduciendo && tiempo >= t1) tiempo = t0;
    ponerReproduccion(!reproduciendo);
  });
  $('#velocidad').addEventListener('change', (e) => { velocidad = Number(e.target.value); });
  let arrastrando = false;
  const barra = $('#barra');
  barra.addEventListener('pointerdown', () => { arrastrando = true; });
  window.addEventListener('pointerup', () => { arrastrando = false; });
  barra.addEventListener('input', () => { tiempo = t0 + (barra.value / 1000) * (t1 - t0); });

  // Información de un bólido al pasar el cursor (ratón) o al tocarlo (pantalla táctil).
  const raycaster = new THREE.Raycaster();
  const puntero = new THREE.Vector2();
  const tooltip = $('#tooltip');
  function bolidoEn(evento) {
    if (!mallaBolidos.visible || !bolidos.length) return null;
    const r = lienzo.getBoundingClientRect();
    puntero.set(((evento.clientX - r.left) / r.width) * 2 - 1, -((evento.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(puntero, camara);
    const [primero] = raycaster.intersectObjects([tierra, mallaBolidos], false);
    return primero?.object === mallaBolidos ? primero.instanceId : null;
  }
  function mostrarBolido(i, evento) {
    if (i === null) {
      tooltip.hidden = true;
      return;
    }
    const [ms, latitud, longitud, kt, altitud, velocidadBolido] = bolidos[i];
    const lineas = [
      fechaUTC(ms),
      kt === null ? 'Energía no estimada'
        : `${kt < 10 ? kt.toFixed(2) : numero.format(kt)} kt${kt >= 1 ? ` · ≈ ${(kt / HIROSHIMA_KT).toFixed(1)}× Hiroshima` : ''}`,
      `${Math.abs(latitud).toFixed(1)}° ${latitud >= 0 ? 'N' : 'S'}, ${Math.abs(longitud).toFixed(1)}° ${longitud >= 0 ? 'E' : 'O'}`,
      altitud === null ? null : `Estalló a ${altitud.toFixed(1)} km de altura`,
      velocidadBolido === null ? null : `${velocidadBolido.toFixed(1)} km/s`,
    ].filter(Boolean);
    tooltip.replaceChildren(...lineas.map((texto) => {
      const div = document.createElement('div');
      div.textContent = texto;
      return div;
    }));
    tooltip.hidden = false;
    const x = Math.min(evento.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
    const y = Math.min(evento.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
    tooltip.style.transform = `translate(${x}px, ${y}px)`;
  }
  let inicioToque = null;
  lienzo.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && e.buttons === 0) mostrarBolido(bolidoEn(e), e);
  });
  lienzo.addEventListener('pointerdown', (e) => { inicioToque = { x: e.clientX, y: e.clientY }; });
  lienzo.addEventListener('pointerup', (e) => {
    if (inicioToque && Math.hypot(e.clientX - inicioToque.x, e.clientY - inicioToque.y) < 5) {
      mostrarBolido(bolidoEn(e), e);
    }
    inicioToque = null;
  });
  lienzo.addEventListener('pointerleave', () => { tooltip.hidden = true; });

  // Cada fotograma
  const delta = new THREE.Vector3();
  const ejeX = new THREE.Vector3();
  const ejeY = new THREE.Vector3();
  const ejeZ = new THREE.Vector3();
  const base = new THREE.Matrix4();
  const proyeccion = new THREE.Vector3();

  function actualizar() {
    if (pSol) interpolar(pSol, tiempo, posiciones.sol);
    else posicionSol(tiempo, posiciones.sol);
    const dirSol = posiciones.sol.clone().normalize();
    uniformesTierra.dirSol.value.copy(dirSol);
    luzSol.position.copy(dirSol).multiplyScalar(1000);
    sol.position.copy(posiciones.sol);

    tierra.rotation.z = anguloSideral(tiempo);
    ejeTierra.updateMatrixWorld(true);
    if (localMayor) posicionMayor.copy(localMayor).applyMatrix4(tierra.matrixWorld);

    if (vuelo) {
      interpolar(pAsteroide, tiempo, posiciones.asteroide);
      interpolar(pLuna, tiempo, posiciones.luna);
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
      if (!arrastrando) barra.value = Math.round(((tiempo - t0) / (t1 - t0)) * 1000);
      const distanciaKm = posiciones.asteroide.length() / KM;
      const rapidez = pAsteroide[i + 1].distanceTo(pAsteroide[i]) / KM / ((t[i + 1] - t[i]) / 1000);
      $('#cuenta').textContent = cuentaAtras(tiempo - vuelo.fecha_ms);
      $('#distancia').textContent = `A ${numero.format(distanciaKm)} km de la Tierra (${(distanciaKm / DL_KM).toFixed(2)} DL)`;
      $('#rapidez').textContent = `${rapidez.toFixed(1)} km/s respecto a la Tierra`;
    } else {
      $('#cuenta').textContent = 'La Tierra gira y se ilumina según la hora indicada';
    }
    $('#ahora').textContent = fechaUTC(tiempo);

    // Seguir al cuerpo elegido trasladando cámara y objetivo juntos.
    const objetivo = seguir === 'general' ? centroGeneral : posiciones[seguir];
    delta.subVectors(objetivo, controles.target);
    controles.target.add(delta);
    camara.position.add(delta);
  }

  /** ¿La Tierra o la Luna tapan el punto visto desde la cámara? */
  const rayo = new THREE.Ray();
  const choque = new THREE.Vector3();
  function tapado(posicion, propio) {
    rayo.origin.copy(camara.position);
    rayo.direction.subVectors(posicion, camara.position).normalize();
    const distancia = camara.position.distanceTo(posicion);
    return ['tierra', 'luna'].some((cuerpo) => cuerpo !== propio && (cuerpo === 'tierra' || luna.visible)
      && rayo.intersectSphere(new THREE.Sphere(posiciones[cuerpo], radioVisual(cuerpo)), choque)
      && camara.position.distanceTo(choque) < distancia);
  }

  function colocarEtiquetas() {
    const { clientWidth: ancho, clientHeight: alto } = lienzo;
    const pixelesPorUnidad = alto / (2 * Math.tan(THREE.MathUtils.degToRad(camara.fov / 2)));
    const colocadas = [];
    for (const { el, posicion, cuerpo, activa } of etiquetas) {
      proyeccion.copy(posicion).project(camara);
      const radioPx = (radioVisual(cuerpo) / camara.position.distanceTo(posicion)) * pixelesPorUnidad;
      const x = ((proyeccion.x + 1) / 2) * ancho + (radioPx > 6 ? radioPx : 0);
      const y = ((1 - proyeccion.y) / 2) * alto;
      const visible = activa() && proyeccion.z < 1 && Math.abs(proyeccion.x) < 1.05 && Math.abs(proyeccion.y) < 1.05
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
  enfocar(seguir);

  const reloj = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(reloj.getDelta(), 0.1);
    if (reproduciendo) {
      tiempo += dt * 1000 * velocidad;
      if (vuelo && tiempo >= t1) {
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
