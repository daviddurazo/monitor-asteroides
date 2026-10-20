# Monitor de asteroides cercanos a la Tierra

Prototipo con tres contenedores Docker: consulta la API **NeoWs** de la NASA, guarda los
asteroides que pasan cerca de la Tierra en **MySQL** y los muestra en un dashboard con **Dash**.

## 1. Problemática

Cada día decenas de asteroides pasan cerca de la Tierra. La NASA publica estos datos, pero en
JSON crudo y por consulta. Este prototipo los **recolecta de forma automática, los guarda con
historial** (la API solo responde por ventanas de 7 días) y los **presenta de forma visual**:
qué tan cerca pasan, qué tan grandes son y cuáles están clasificados como potencialmente peligrosos.

## 2. API seleccionada: NASA NeoWs

- Endpoint: `GET https://api.nasa.gov/neo/rest/v1/feed?start_date=AAAA-MM-DD&end_date=AAAA-MM-DD&api_key=...`
- Información por asteroide: id, nombre, magnitud absoluta, diámetro estimado (mín./máx.),
  si es *Potentially Hazardous Asteroid*, si lo vigila el sistema Sentry y enlace a la ficha del JPL.
- Información por acercamiento: fecha y hora de máxima aproximación, velocidad relativa y distancia
  mínima (km, distancias lunares, unidades astronómicas).
- Restricciones: máximo 7 días por petición; con `DEMO_KEY` el límite es de unas 10 peticiones
  por hora, así que conviene una clave personal gratuita (https://api.nasa.gov, llega al correo al instante).

### Segunda fuente: JPL Horizons (trayectorias)

- Endpoint: `GET https://ssd.jpl.nasa.gov/api/horizons.api` (sin clave).
- Para los `TRAYECTORIAS_N` pasos más cercanos de los próximos 7 días, el ingestor pide la posición
  del asteroide (`COMMAND='DES=<id_neo>;'`), de la Luna (`COMMAND='301'`) y del Sol (`COMMAND='10'`)
  respecto al centro de la Tierra, en el plano de la eclíptica, `±VENTANA_HORAS` alrededor del paso
  y cada `PASO_TRAYECTORIA`.
- El `id_neo` de NeoWs es el SPK-ID del JPL, así que se usa directamente. Las horas vienen en TDB
  (~69 s respecto a UTC). La distancia mínima obtenida coincide con la que publica NeoWs.

### Simulador 3D del sobrevuelo

El dashboard incluye un simulador hecho con **three.js** (`dash/simulador/`, servido por el
propio contenedor Dash en `/simulador/` y alimentado por `/api/trayectoria/<id>`):

- Tierra con textura real que gira según la hora (tiempo sidéreo) e inclinada 23.4°, iluminada
  desde la posición real del Sol: lado de día, lado de noche con luces de ciudades y atmósfera.
- Luna con textura real, siempre mostrando la misma cara a la Tierra; su fase sale sola de la luz.
- Fondo de estrellas real, orientado en coordenadas celestes.
- El asteroide es una **roca genérica** (no existen imágenes de estos objetos), escalada con su
  diámetro estimado en el modo de escala real.
- Línea de tiempo con velocidad ajustable, estela, cámara que sigue a la Tierra, la Luna o el
  asteroide, e interruptor entre tamaños exagerados (×10) y escala real.

Texturas (dominio público, NASA), convertidas a JPG en `dash/simulador/texturas/`:
Blue Marble (Earth Observatory, 73909), Black Marble 2012 (79765), nubes Blue Marble (57747),
CGI Moon Kit del LRO (SVS 4720) y Deep Star Maps 2020 (SVS 4851). three.js r160 (MIT) está en
`dash/simulador/vendor/` para no depender de un CDN.

> También se evaluó la API APOD (imagen astronómica del día), pero actualmente devuelve datos de
> relleno (mismo título e imagen para todos los días), así que se descartó.

## 3. Arquitectura

```
                 HTTPS (JSON)
  api.nasa.gov  <-------------  ┌──────────────────────────┐
  ssd.jpl.nasa.gov <----------  │                          │
                                │ ingestor (ubuntu:24.04)  │  :8000 mini API
                                │ Python + requests        │  GET /estado
                                │ cada 6 h o bajo demanda  │  POST /sincronizar
                                └────────────┬─────────────┘
                                   INSERT /  │  usuario nasa_ingestor
                                   UPSERT    ▼  (lectura y escritura)
                                ┌──────────────────────────┐
                                │ mysql (mysql:8.4)        │  volumen mysql_data
                                │ base de datos "espacio"  │  (persistencia)
                                └────────────┬─────────────┘
                                    SELECT   │  usuario dash_lector
                                             ▼  (solo lectura)
                                ┌──────────────────────────┐
  navegador  ─────────────────> │ dash (python:3.12-slim)  │  :8050
  localhost:8050                │ Dash + Plotly + gunicorn │  botón "Sincronizar"
                                └──────────────────────────┘  -> POST ingestor:8000
```

| Contenedor | Imagen | Función |
|---|---|---|
| `ingestor` (API-Ubuntu) | `ubuntu:24.04` + Python | Consume NeoWs (y después JPL Horizons para las trayectorias), transforma el JSON y hace *upsert* en MySQL. Registra cada ejecución en `ingestas`. Expone una mini API HTTP para consultar su estado y lanzar una sincronización. |
| `mysql` (BD) | `mysql:8.4` | Almacena los datos. El esquema se crea con `mysql/01-esquema.sql`; `mysql/02-usuarios.sh` crea el usuario de solo lectura del dashboard. |
| `dash` (Python-Dash) | `python:3.12-slim` | Lee MySQL cada 30 s y muestra indicadores, gráficas y tablas. Su botón llama al ingestor por la red interna. |

Los contenedores se comunican por la red que crea Docker Compose usando el **nombre del servicio**
(`mysql:3306`, `ingestor:8000`). MySQL no se publica fuera de esa red. Compose arranca MySQL
primero y espera a que su *healthcheck* pase antes de iniciar el ingestor y el dashboard.

## 4. Diseño de la base de datos

```
asteroides (1) ────────< (N) acercamientos          ingestas (bitácora)
─────────────────────        ──────────────────     ─────────────────────
id_neo  PK                   id  PK                 id  PK
nombre                       id_neo  FK             inicio_ejecucion
magnitud_absoluta            fecha_acercamiento     duracion_s
diametro_min_m               velocidad_km_s         origen (automatica|manual)
diametro_max_m               distancia_km           fuente
es_peligroso                 distancia_lunar        rango_inicio, rango_fin
es_sentry                    distancia_ua           registros, nuevos
url_jpl                      cuerpo_orbitado        estado (ok|error)
actualizado                  UNIQUE(id_neo,         mensaje
                                    fecha_acercamiento)
                                     │ (1)
                                     ▼ (N)
                             trayectorias
                             ──────────────────
                             id_acercamiento  FK ─┐
                             cuerpo (asteroide|     ├ PK
                                     luna|sol)      │
                             instante  ────────────┘
                             x_km, y_km, z_km
```

- **asteroides**: catálogo, un registro por objeto. **acercamientos**: un registro por paso
  cercano (un asteroide puede pasar varias veces) → relación 1:N.
- La clave única `(id_neo, fecha_acercamiento)` hace la carga **idempotente**: volver a sincronizar
  actualiza los registros en lugar de duplicarlos (`INSERT ... ON DUPLICATE KEY UPDATE`).
- **trayectorias**: posiciones geocéntricas (JPL Horizons) del asteroide, la Luna y el Sol alrededor
  de cada paso. Cuelga de `acercamientos.id` (no de `id_neo`) porque un asteroide puede tener varios
  pasos, y guarda la Luna y el Sol por acercamiento para que coincidan instante a instante. Su clave primaria
  hace la carga idempotente (`INSERT IGNORE`).
- **vista_acercamientos** une ambas tablas y calcula el diámetro medio; es lo que lee el dashboard.
- Dos usuarios con mínimo privilegio: `nasa_ingestor` (escritura) y `dash_lector` (solo `SELECT`).
- Todas las fechas se guardan en **UTC**.
- Limpieza de datos: NeoWs a veces publica el mismo asteroide con dos ids (número definitivo y
  designación provisional, p. ej. `679786 (2020 QG3)` y `2020 QG3`) con el mismo instante y distancia.
  El dashboard conserva solo uno.

## 5. Cómo ejecutarlo

Requiere **Docker Desktop** iniciado (en Windows, con contenedores Linux). Desde esta carpeta:

```powershell
Copy-Item .env.example .env      # Linux/macOS: cp .env.example .env
# (opcional) edita .env y pon tu NASA_API_KEY personal
docker compose up -d --build
docker compose ps
```

La primera vez descarga las imágenes y puede tardar unos minutos. Abre **http://localhost:8050**.
Al arrancar, el ingestor consulta la NASA automáticamente (7 días atrás y 6 hacia adelante) y
luego repite cada 6 horas.

### Guion de demostración

1. **Obtención** — Muestra la API en bruto en el navegador:
   `https://api.nasa.gov/neo/rest/v1/feed?start_date=2026-10-18&end_date=2026-10-19&api_key=DEMO_KEY`.
   Luego el estado del contenedor ingestor: **http://localhost:8000/estado**, y sus logs:
   ```powershell
   docker compose logs -f ingestor
   ```
2. **Almacenamiento** — Consulta MySQL dentro de su contenedor:
   ```powershell
   docker compose exec mysql mysql -u nasa_ingestor -p espacio
   ```
   Contraseña: `INGESTOR_DB_PASSWORD` de `.env` (por defecto `Ingestor2026_local`).
   ```sql
   SHOW TABLES;
   SELECT COUNT(*) FROM asteroides;
   SELECT nombre, fecha_acercamiento, ROUND(distancia_lunar, 2) AS dl
   FROM vista_acercamientos ORDER BY distancia_lunar LIMIT 5;
   SELECT inicio_ejecucion, origen, registros, nuevos, estado FROM ingestas ORDER BY id DESC;
   exit;
   ```
3. **Visualización** — En el dashboard: el próximo paso cercano, el **simulador 3D** del sobrevuelo
   (elige el asteroide, sigue a la Tierra, la Luna o el asteroide y mueve la línea de tiempo), los indicadores, los filtros (últimos/próximos 7 días,
   solo peligrosos), las gráficas con *hover* y la tabla de pasos más cercanos.
4. **Integración** — Pulsa **Sincronizar con la NASA**: el contenedor Dash llama al ingestor, este
   consulta la NASA, guarda en MySQL y aparece una nueva fila en la *Bitácora de ingestas*
   (con `nuevos = 0` si no hubo cambios: la carga no duplica datos).
5. **Seguridad (opcional)** — El dashboard no puede escribir:
   ```powershell
   docker compose exec mysql mysql -u dash_lector -p espacio -e "DELETE FROM ingestas"
   ```
   Contraseña `Lector2026_local` → MySQL responde *DELETE command denied*.

### Comandos útiles

```powershell
docker compose logs -f dash          # logs del dashboard
docker compose restart ingestor      # reinicia solo el ingestor
docker compose up -d --build dash    # tras editar dash/app.py
docker compose down                  # detiene y elimina contenedores (conserva los datos)
docker compose down -v               # elimina también el volumen de MySQL (borra los datos)
```

## 6. Problemas frecuentes

- **`Límite de peticiones de la NASA alcanzado (HTTP 429)`** en la bitácora: estás usando
  `DEMO_KEY`. Pon tu clave en `.env` y ejecuta `docker compose up -d` (recrea el ingestor).
- **Access denied tras editar `.env`**: las contraseñas de MySQL solo se aplican al crear el
  volumen. Usa `docker compose down -v` y vuelve a levantar (se pierden los datos guardados).
- **`Table 'espacio.trayectorias' doesn't exist`**: el volumen de MySQL se creó antes de añadir esa
  tabla y los scripts de `mysql/` solo corren con el volumen vacío. Ejecuta a mano el `CREATE TABLE
  trayectorias` de `mysql/01-esquema.sql`, o usa `docker compose down -v` (borra los datos).
- **`Data truncated for column 'cuerpo'`** en la ingesta de Horizons: la tabla se creó antes de
  añadir el Sol. Ejecuta `ALTER TABLE trayectorias MODIFY cuerpo ENUM('asteroide', 'luna', 'sol') NOT NULL;`
  y sincroniza; el ingestor completa solo los acercamientos a los que les falte algún cuerpo.
- **El simulador se queda en negro**: el navegador necesita WebGL (cualquier navegador actual).
- **Puerto 8050 u 8000 ocupado**: cambia el mapeo en `compose.yaml` (p. ej. `127.0.0.1:8051:8050`).
- **MySQL unhealthy**: revisa `docker compose logs mysql`; en equipos lentos aumenta `retries`.
