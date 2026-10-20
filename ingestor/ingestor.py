"""Contenedor API-Ubuntu: consume la API NeoWs de la NASA y guarda los datos en MySQL.

NeoWs (Near Earth Object Web Service) informa de los asteroides que pasan cerca de la Tierra.

Además expone una mini API HTTP en el puerto 8000:
  GET  /             -> descripción de los endpoints
  GET  /salud        -> comprobación de vida (la usa el healthcheck)
  GET  /estado       -> conteos en la base y últimas ingestas
  POST /sincronizar  -> ejecuta una ingesta inmediata (la usa el botón del dashboard)
"""
import json
import logging
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pymysql
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ingestor] %(message)s")
log = logging.getLogger(__name__)

NASA_API_KEY = os.environ.get("NASA_API_KEY") or "DEMO_KEY"
NASA_BASE = "https://api.nasa.gov"
DIAS_ATRAS = int(os.environ.get("DIAS_ATRAS", "7"))
DIAS_ADELANTE = int(os.environ.get("DIAS_ADELANTE", "6"))
INTERVALO_HORAS = float(os.environ.get("INTERVALO_HORAS", "6"))
REINTENTO_MINUTOS = 15
PUERTO = int(os.environ.get("PUERTO", "8000"))
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
JPL_SSD_API = "https://ssd-api.jpl.nasa.gov"
UA_KM = 149_597_870.7
TRAYECTORIAS_N = int(os.environ.get("TRAYECTORIAS_N", "5"))
VENTANA_HORAS = int(os.environ.get("VENTANA_HORAS", "72"))
PASO_MAX_MINUTOS = int(os.environ.get("PASO_MAX_MINUTOS", "60"))
# Grandes acercamientos (API CAD): años hacia adelante, distancia máxima y magnitud H máxima
# (H <= 21 equivale a unos 200 m de diámetro o más).
EVENTOS_ANIOS = int(os.environ.get("EVENTOS_ANIOS", "10"))
EVENTOS_DIST_MAX_DL = float(os.environ.get("EVENTOS_DIST_MAX_DL", "5"))
EVENTOS_H_MAX = float(os.environ.get("EVENTOS_H_MAX", "21"))
# Cuerpos que acompañan a cada asteroide -> COMMAND de Horizons. El Sol da la luz del simulador.
CUERPOS_FIJOS = {"luna": "301", "sol": "10"}
CUERPOS_POR_TRAYECTORIA = 1 + len(CUERPOS_FIJOS)

candado = threading.Lock()


def ahora_utc():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def conectar():
    return pymysql.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        database=os.environ["DB_NAME"],
        charset="utf8mb4",
        connect_timeout=5,
        autocommit=False,
    )


def pedir(ruta, params):
    """GET a la API de la NASA. Registra el código HTTP y la cuota restante."""
    respuesta = requests.get(f"{NASA_BASE}{ruta}",
                             params={**params, "api_key": NASA_API_KEY}, timeout=60)
    log.info("GET %s %s -> HTTP %s (peticiones restantes en la hora: %s)", ruta, params,
             respuesta.status_code, respuesta.headers.get("X-RateLimit-Remaining", "?"))
    respuesta.raise_for_status()
    return respuesta.json()


def pedir_jpl(ruta, params):
    """GET a las APIs del Solar System Dynamics del JPL (sin clave)."""
    respuesta = requests.get(f"{JPL_SSD_API}{ruta}", params=params, timeout=60)
    log.info("GET %s %s -> HTTP %s", ruta, params, respuesta.status_code)
    respuesta.raise_for_status()
    return respuesta.json()


def desde_dia_juliano(jd):
    """Día juliano -> datetime (2451545.0 = 2000-01-01 12:00), redondeado al segundo."""
    return datetime(2000, 1, 1, 12) + timedelta(seconds=round((float(jd) - 2451545.0) * 86400))


def opcional(valor):
    return None if valor is None else float(valor)


def tramos(inicio, fin, max_dias=7):
    """El feed de NeoWs acepta como máximo 7 días por petición."""
    while inicio <= fin:
        tramo_fin = min(inicio + timedelta(days=max_dias - 1), fin)
        yield inicio, tramo_fin
        inicio = tramo_fin + timedelta(days=1)


def contar(cursor, tabla):
    cursor.execute(f"SELECT COUNT(*) FROM {tabla}")
    return cursor.fetchone()[0]


# --------------------------------------------------------------------------- NeoWs

def fecha_acercamiento(dato):
    if dato.get("epoch_date_close_approach") is not None:
        return datetime.fromtimestamp(dato["epoch_date_close_approach"] / 1000,
                                      tz=timezone.utc).replace(tzinfo=None)
    return datetime.strptime(dato["close_approach_date"], "%Y-%m-%d")


def guardar_neos(cursor, datos):
    filas = 0
    for lista in datos["near_earth_objects"].values():
        for neo in lista:
            diametro = neo["estimated_diameter"]["meters"]
            cursor.execute("""
                INSERT INTO asteroides
                    (id_neo, nombre, magnitud_absoluta, diametro_min_m, diametro_max_m,
                     es_peligroso, es_sentry, url_jpl)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s) AS nuevo
                ON DUPLICATE KEY UPDATE
                    nombre = nuevo.nombre, magnitud_absoluta = nuevo.magnitud_absoluta,
                    diametro_min_m = nuevo.diametro_min_m, diametro_max_m = nuevo.diametro_max_m,
                    es_peligroso = nuevo.es_peligroso, es_sentry = nuevo.es_sentry,
                    url_jpl = nuevo.url_jpl
            """, (neo["id"], neo["name"], neo.get("absolute_magnitude_h"),
                  diametro["estimated_diameter_min"], diametro["estimated_diameter_max"],
                  neo["is_potentially_hazardous_asteroid"], neo.get("is_sentry_object", False),
                  neo.get("nasa_jpl_url")))
            for paso in neo["close_approach_data"]:
                cursor.execute("""
                    INSERT INTO acercamientos
                        (id_neo, fecha_acercamiento, velocidad_km_s, distancia_km,
                         distancia_lunar, distancia_ua, cuerpo_orbitado)
                    VALUES (%s, %s, %s, %s, %s, %s, %s) AS nuevo
                    ON DUPLICATE KEY UPDATE
                        velocidad_km_s = nuevo.velocidad_km_s, distancia_km = nuevo.distancia_km,
                        distancia_lunar = nuevo.distancia_lunar, distancia_ua = nuevo.distancia_ua
                """, (neo["id"], fecha_acercamiento(paso),
                      float(paso["relative_velocity"]["kilometers_per_second"]),
                      float(paso["miss_distance"]["kilometers"]),
                      float(paso["miss_distance"]["lunar"]),
                      float(paso["miss_distance"]["astronomical"]),
                      paso.get("orbiting_body", "Earth")))
                filas += 1
    return filas


def ingerir_neows(cursor):
    hoy = ahora_utc().date()
    inicio, fin = hoy - timedelta(days=DIAS_ATRAS), hoy + timedelta(days=DIAS_ADELANTE)
    antes = contar(cursor, "acercamientos")
    filas = 0
    for a, b in tramos(inicio, fin):
        filas += guardar_neos(cursor, pedir("/neo/rest/v1/feed", {
            "start_date": a.isoformat(), "end_date": b.isoformat()}))
    return inicio, fin, filas, contar(cursor, "acercamientos") - antes


# --------------------------------------------------------------------------- Horizons

def vectores_horizons(comando, inicio, fin, paso):
    """Posiciones geocéntricas (km, plano de la eclíptica) según JPL Horizons."""
    respuesta = requests.get(HORIZONS_URL, params={
        "format": "json", "COMMAND": f"'{comando}'", "EPHEM_TYPE": "VECTORS",
        "CENTER": "'500@399'", "REF_PLANE": "ECLIPTIC", "VEC_TABLE": "1",
        "CSV_FORMAT": "YES", "OUT_UNITS": "KM-S", "OBJ_DATA": "NO",
        "START_TIME": f"'{inicio:%Y-%m-%d %H:%M}'", "STOP_TIME": f"'{fin:%Y-%m-%d %H:%M}'",
        "STEP_SIZE": f"'{paso}'"}, timeout=60)
    respuesta.raise_for_status()
    cuerpo = respuesta.json()
    texto = cuerpo.get("result", "")
    if "$$SOE" not in texto:
        raise ValueError(f"Horizons sin vectores para {comando}: {cuerpo.get('error') or texto[:300]}")
    filas = []
    for linea in texto.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        jd, _fecha, x, y, z = (c.strip() for c in linea.split(",")[:5])
        filas.append((desde_dia_juliano(jd), float(x), float(y), float(z)))
    return filas


def paso_minutos(distancia_km, velocidad_km_s):
    """Resolución: el asteroide avanza como mucho 1/10 de su distancia mínima por paso, para que
    la curva de los pasos muy cercanos (como Apophis en 2029) no salga en tramos rectos."""
    return int(max(1, min(PASO_MAX_MINUTOS, distancia_km / velocidad_km_s / 10 / 60)))


def guardar_trayectoria(cursor, tabla, columna, id_ref, comando, fecha, distancia_km,
                        velocidad_km_s):
    """Pide a Horizons el asteroide, la Luna y el Sol alrededor de `fecha` y los guarda."""
    inicio = fecha - timedelta(hours=VENTANA_HORAS)
    fin = fecha + timedelta(hours=VENTANA_HORAS)
    paso = f"{paso_minutos(distancia_km, velocidad_km_s)}m"
    filas = nuevos = 0
    for cuerpo, comando_cuerpo in {"asteroide": comando, **CUERPOS_FIJOS}.items():
        vectores = vectores_horizons(comando_cuerpo, inicio, fin, paso)
        nuevos += cursor.executemany(
            f"INSERT IGNORE INTO {tabla} ({columna}, cuerpo, instante, x_km, y_km, z_km) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            [(id_ref, cuerpo, *v) for v in vectores])
        filas += len(vectores)
    return filas, nuevos


def ingerir_trayectorias(cursor):
    """Trayectoria de los N pasos más cercanos de los próximos 7 días a los que les falte algún cuerpo."""
    hoy = ahora_utc().date()
    cursor.execute("""
        SELECT top.id, top.id_neo, top.fecha_acercamiento, top.distancia_km, top.velocidad_km_s
        FROM (
            SELECT id, id_neo, fecha_acercamiento, distancia_km, velocidad_km_s FROM acercamientos
            WHERE fecha_acercamiento BETWEEN UTC_TIMESTAMP() AND UTC_TIMESTAMP() + INTERVAL 7 DAY
            ORDER BY distancia_lunar LIMIT %s
        ) top
        WHERE (SELECT COUNT(DISTINCT t.cuerpo) FROM trayectorias t
               WHERE t.id_acercamiento = top.id) < %s
    """, (TRAYECTORIAS_N, CUERPOS_POR_TRAYECTORIA))
    filas = nuevos = 0
    for id_acercamiento, id_neo, fecha, distancia_km, velocidad_km_s in cursor.fetchall():
        # El id de NeoWs es el SPK-ID del JPL.
        f, n = guardar_trayectoria(cursor, "trayectorias", "id_acercamiento", id_acercamiento,
                                   f"DES={id_neo};", fecha, distancia_km, velocidad_km_s)
        filas, nuevos = filas + f, nuevos + n
    return hoy, hoy + timedelta(days=7), filas, nuevos


# --------------------------------------------------------------------------- CAD (grandes acercamientos)

def diametro_desde_h(h, albedo=0.14):
    """Diámetro estimado en metros a partir de la magnitud absoluta H (fórmula estándar del JPL)."""
    return 1329 / albedo ** 0.5 * 10 ** (-h / 5) * 1000


def comando_designacion(designacion):
    """Numerados como "99942;"; provisionales como "DES=2024 QP2;"."""
    return f"{designacion};" if designacion.isdigit() else f"DES={designacion};"


def ingerir_eventos(cursor):
    """Pasos de asteroides grandes a pocas distancias lunares en los próximos años (API CAD),
    y su trayectoria de Horizons. Todos son potencialmente peligrosos: H <= 22 y MOID <= 0.05 UA."""
    hoy = ahora_utc().date()
    fin = hoy + timedelta(days=round(365.25 * EVENTOS_ANIOS))
    datos = pedir_jpl("/cad.api", {
        "date-min": hoy.isoformat(), "date-max": fin.isoformat(),
        "dist-max": f"{EVENTOS_DIST_MAX_DL}LD", "h-max": EVENTOS_H_MAX,
        "sort": "dist", "fullname": "true", "diameter": "true"})
    antes = contar(cursor, "eventos")
    registros = 0
    for valores in datos.get("data", []):
        e = dict(zip(datos["fields"], valores))
        h = float(e["h"])
        cursor.execute("""
            INSERT INTO eventos (designacion, nombre, fecha_acercamiento, distancia_km,
                                 velocidad_km_s, magnitud_absoluta, diametro_m, diametro_estimado)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s) AS nuevo
            ON DUPLICATE KEY UPDATE
                nombre = nuevo.nombre, distancia_km = nuevo.distancia_km,
                velocidad_km_s = nuevo.velocidad_km_s, magnitud_absoluta = nuevo.magnitud_absoluta,
                diametro_m = nuevo.diametro_m, diametro_estimado = nuevo.diametro_estimado
        """, (e["des"], e["fullname"].strip(), desde_dia_juliano(e["jd"]),
              float(e["dist"]) * UA_KM, float(e["v_rel"]), h,
              float(e["diameter"]) * 1000 if e["diameter"] else diametro_desde_h(h),
              e["diameter"] is None))
        registros += 1
    cursor.execute("""
        SELECT id, designacion, fecha_acercamiento, distancia_km, velocidad_km_s FROM eventos e
        WHERE fecha_acercamiento >= UTC_TIMESTAMP()
          AND (SELECT COUNT(DISTINCT t.cuerpo) FROM trayectorias_eventos t
               WHERE t.id_evento = e.id) < %s
    """, (CUERPOS_POR_TRAYECTORIA,))
    posiciones = 0
    for id_evento, designacion, fecha, distancia_km, velocidad_km_s in cursor.fetchall():
        posiciones += guardar_trayectoria(cursor, "trayectorias_eventos", "id_evento", id_evento,
                                          comando_designacion(designacion), fecha, distancia_km,
                                          velocidad_km_s)[1]
    log.info("CAD: %s posiciones nuevas de Horizons para los eventos", posiciones)
    return hoy, fin, registros, contar(cursor, "eventos") - antes


# --------------------------------------------------------------------------- Fireball (bólidos)

def ingerir_bolidos(cursor):
    """Bólidos con ubicación conocida (API Fireball de CNEOS): toda la serie histórica."""
    datos = pedir_jpl("/fireball.api", {"req-loc": "true"})
    filas = []
    for valores in datos.get("data", []):
        b = dict(zip(datos["fields"], valores))
        filas.append((b["date"],
                      float(b["lat"]) * (1 if b["lat-dir"] == "N" else -1),
                      float(b["lon"]) * (1 if b["lon-dir"] == "E" else -1),
                      opcional(b["impact-e"]), float(b["energy"]) * 1e10,
                      opcional(b["alt"]), opcional(b["vel"])))
    if not filas:
        return None, None, 0, 0
    antes = contar(cursor, "bolidos")
    cursor.executemany("""
        INSERT INTO bolidos (fecha, latitud, longitud, energia_impacto_kt, energia_radiada_j,
                             altitud_km, velocidad_km_s)
        VALUES (%s, %s, %s, %s, %s, %s, %s) AS nuevo
        ON DUPLICATE KEY UPDATE
            latitud = nuevo.latitud, longitud = nuevo.longitud,
            energia_impacto_kt = nuevo.energia_impacto_kt,
            energia_radiada_j = nuevo.energia_radiada_j,
            altitud_km = nuevo.altitud_km, velocidad_km_s = nuevo.velocidad_km_s
    """, filas)
    fechas = sorted(f[0][:10] for f in filas)
    return fechas[0], fechas[-1], len(filas), contar(cursor, "bolidos") - antes


# --------------------------------------------------------------------------- Orquestación

def ejecutar(fuente, funcion, origen):
    """Ejecuta una ingesta en su propia transacción y la registra en la tabla ingestas."""
    inicio_ejecucion = ahora_utc()
    reloj = time.monotonic()
    resultado = {"fuente": fuente, "estado": "ok", "registros": 0, "nuevos": 0, "mensaje": ""}
    rango = (None, None)
    conexion = conectar()
    try:
        with conexion.cursor() as cursor:
            try:
                r_inicio, r_fin, registros, nuevos = funcion(cursor)
                conexion.commit()
                rango = (r_inicio, r_fin)
                resultado.update(registros=registros, nuevos=nuevos,
                                 mensaje=f"{registros} registros procesados, {nuevos} nuevos")
            except Exception as error:
                conexion.rollback()
                mensaje = str(error)
                if isinstance(error, requests.HTTPError) and error.response is not None \
                        and error.response.status_code == 429:
                    mensaje = "Límite de peticiones de la NASA alcanzado (HTTP 429). " \
                              "Usa tu propia NASA_API_KEY o espera una hora."
                log.exception("Falló la ingesta de %s", fuente)
                resultado.update(estado="error", mensaje=mensaje[:500])
            cursor.execute("""
                INSERT INTO ingestas (inicio_ejecucion, duracion_s, origen, fuente,
                                      rango_inicio, rango_fin, registros, nuevos, estado, mensaje)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (inicio_ejecucion, round(time.monotonic() - reloj, 2), origen, fuente,
                  rango[0], rango[1], resultado["registros"], resultado["nuevos"],
                  resultado["estado"], resultado["mensaje"]))
            conexion.commit()
    finally:
        conexion.close()
    log.info("%s (%s): %s - %s", fuente, origen, resultado["estado"], resultado["mensaje"])
    return resultado


def sincronizar(origen):
    if not candado.acquire(blocking=False):
        return {"estado": "ocupado", "resultados": [],
                "mensaje": "Ya hay una sincronización en curso."}
    try:
        resultados = [ejecutar("NeoWs", ingerir_neows, origen),
                      ejecutar("Horizons", ingerir_trayectorias, origen),
                      ejecutar("CAD", ingerir_eventos, origen),
                      ejecutar("Fireball", ingerir_bolidos, origen)]
    finally:
        candado.release()
    errores = sum(r["estado"] == "error" for r in resultados)
    estado = "ok" if errores == 0 else ("error" if errores == len(resultados) else "parcial")
    return {"estado": estado, "resultados": resultados}


def ultima_ingesta_ok():
    conexion = conectar()
    try:
        with conexion.cursor() as cursor:
            cursor.execute("SELECT MAX(inicio_ejecucion) FROM ingestas "
                           "WHERE fuente = 'NeoWs' AND estado = 'ok'")
            return cursor.fetchone()[0]
    finally:
        conexion.close()


def ciclo_automatico():
    """Sincroniza al arrancar (si los datos no son recientes) y luego cada INTERVALO_HORAS."""
    while True:
        try:
            ultima = ultima_ingesta_ok()
            break
        except pymysql.MySQLError as error:
            log.warning("Esperando a MySQL: %s", error)
            time.sleep(5)
    proxima = ahora_utc() if ultima is None else ultima + timedelta(hours=INTERVALO_HORAS)
    log.info("Próxima sincronización automática: %s UTC", proxima.strftime("%Y-%m-%d %H:%M"))
    while True:
        if ahora_utc() >= proxima:
            try:
                ok = sincronizar("automatica")["estado"] == "ok"
            except Exception:
                log.exception("Error inesperado en la sincronización automática")
                ok = False
            espera = timedelta(hours=INTERVALO_HORAS) if ok else timedelta(minutes=REINTENTO_MINUTOS)
            proxima = ahora_utc() + espera
            log.info("Próxima sincronización automática: %s UTC", proxima.strftime("%Y-%m-%d %H:%M"))
        time.sleep(30)


# --------------------------------------------------------------------------- Mini API HTTP

def estado_base():
    conexion = conectar()
    try:
        with conexion.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("""
                SELECT (SELECT COUNT(*) FROM asteroides) AS asteroides,
                       (SELECT COUNT(*) FROM asteroides WHERE es_peligroso) AS peligrosos,
                       (SELECT COUNT(*) FROM acercamientos) AS acercamientos
            """)
            conteos = cursor.fetchone()
            cursor.execute("SELECT * FROM ingestas ORDER BY id DESC LIMIT 10")
            ingestas = cursor.fetchall()
    finally:
        conexion.close()
    return {"conteos": conteos, "ultimas_ingestas": ingestas,
            "intervalo_horas": INTERVALO_HORAS,
            "api_key": "DEMO_KEY" if NASA_API_KEY == "DEMO_KEY" else "personal"}


class Manejador(BaseHTTPRequestHandler):
    def responder(self, codigo, cuerpo):
        datos = json.dumps(cuerpo, ensure_ascii=False, indent=2, default=str).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def do_GET(self):
        if self.path == "/":
            self.responder(200, {"servicio": "ingestor NASA", "endpoints": {
                "GET /salud": "comprobación de vida",
                "GET /estado": "conteos en MySQL y últimas ingestas",
                "POST /sincronizar": "consulta la NASA y guarda en MySQL"}})
        elif self.path == "/salud":
            self.responder(200, {"estado": "ok"})
        elif self.path == "/estado":
            try:
                self.responder(200, estado_base())
            except pymysql.MySQLError as error:
                self.responder(503, {"estado": "error", "mensaje": str(error)})
        else:
            self.responder(404, {"estado": "error", "mensaje": "Ruta no encontrada"})

    def do_POST(self):
        if self.path != "/sincronizar":
            self.responder(404, {"estado": "error", "mensaje": "Ruta no encontrada"})
            return
        try:
            resultado = sincronizar("manual")
        except pymysql.MySQLError as error:
            self.responder(503, {"estado": "error", "mensaje": str(error)})
            return
        self.responder(409 if resultado["estado"] == "ocupado" else 200, resultado)

    def log_message(self, formato, *args):
        if self.path != "/salud":
            log.info("HTTP %s", formato % args)


if __name__ == "__main__":
    log.info("Clave NASA: %s", "DEMO_KEY (limitada)" if NASA_API_KEY == "DEMO_KEY" else "personal")
    threading.Thread(target=ciclo_automatico, daemon=True).start()
    log.info("Mini API escuchando en el puerto %s", PUERTO)
    ThreadingHTTPServer(("0.0.0.0", PUERTO), Manejador).serve_forever()
