USE espacio;

-- Catálogo: un registro por asteroide (objeto cercano a la Tierra, NEO).
CREATE TABLE asteroides (
    id_neo            VARCHAR(20)  PRIMARY KEY COMMENT 'Identificador de la NASA/JPL',
    nombre            VARCHAR(100) NOT NULL,
    magnitud_absoluta DOUBLE       NULL COMMENT 'Magnitud absoluta H (menor = más grande/brillante)',
    diametro_min_m    DOUBLE       NOT NULL COMMENT 'Diámetro estimado mínimo, metros',
    diametro_max_m    DOUBLE       NOT NULL COMMENT 'Diámetro estimado máximo, metros',
    es_peligroso      BOOLEAN      NOT NULL COMMENT 'Potentially Hazardous Asteroid según la NASA',
    es_sentry         BOOLEAN      NOT NULL DEFAULT FALSE COMMENT 'Monitoreado por el sistema Sentry de impactos',
    url_jpl           VARCHAR(255) NULL,
    actualizado       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Eventos: cada paso cercano de un asteroide (relación 1:N con asteroides).
CREATE TABLE acercamientos (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    id_neo             VARCHAR(20) NOT NULL,
    fecha_acercamiento DATETIME    NOT NULL COMMENT 'Momento de máxima aproximación, UTC',
    velocidad_km_s     DOUBLE      NOT NULL COMMENT 'Velocidad relativa, km/s',
    distancia_km       DOUBLE      NOT NULL COMMENT 'Distancia mínima, km',
    distancia_lunar    DOUBLE      NOT NULL COMMENT 'Distancia mínima en distancias lunares (1 DL = 384,400 km)',
    distancia_ua       DOUBLE      NOT NULL COMMENT 'Distancia mínima en unidades astronómicas',
    cuerpo_orbitado    VARCHAR(20) NOT NULL DEFAULT 'Earth',
    UNIQUE KEY uq_paso (id_neo, fecha_acercamiento),
    INDEX idx_fecha (fecha_acercamiento),
    CONSTRAINT fk_acercamiento_asteroide FOREIGN KEY (id_neo) REFERENCES asteroides (id_neo)
);

-- Bitácora: cada ejecución del contenedor ingestor.
CREATE TABLE ingestas (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    inicio_ejecucion DATETIME     NOT NULL COMMENT 'UTC',
    duracion_s       DOUBLE       NOT NULL,
    origen           ENUM('automatica', 'manual') NOT NULL,
    fuente           VARCHAR(20)  NOT NULL COMMENT 'Nombre de la API consultada',
    rango_inicio     DATE         NULL,
    rango_fin        DATE         NULL,
    registros        INT          NOT NULL DEFAULT 0 COMMENT 'Filas recibidas de la API',
    nuevos           INT          NOT NULL DEFAULT 0 COMMENT 'Filas que no existían en la base',
    estado           ENUM('ok', 'error') NOT NULL,
    mensaje          VARCHAR(500) NULL,
    INDEX idx_inicio (inicio_ejecucion)
);

-- Trayectorias: posiciones geocéntricas (JPL Horizons) alrededor de cada acercamiento.
CREATE TABLE trayectorias (
    id_acercamiento  BIGINT UNSIGNED NOT NULL,
    cuerpo           ENUM('asteroide', 'luna', 'sol') NOT NULL,
    instante         DATETIME NOT NULL COMMENT 'TDB (~UTC + 69s)',
    x_km             DOUBLE NOT NULL COMMENT 'Plano de la eclíptica, centro de la Tierra',
    y_km             DOUBLE NOT NULL,
    z_km             DOUBLE NOT NULL,
    PRIMARY KEY (id_acercamiento, cuerpo, instante),
    CONSTRAINT fk_trayectoria_acercamiento FOREIGN KEY (id_acercamiento) REFERENCES acercamientos (id)
);

-- Eventos: grandes acercamientos de los próximos años (API CAD del JPL), independientes de NeoWs.
CREATE TABLE eventos (
    id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    designacion        VARCHAR(30)  NOT NULL COMMENT 'Designación del JPL: número o provisional',
    nombre             VARCHAR(100) NOT NULL,
    fecha_acercamiento DATETIME     NOT NULL COMMENT 'TDB (~UTC + 69 s)',
    distancia_km       DOUBLE       NOT NULL COMMENT 'Distancia nominal al centro de la Tierra',
    velocidad_km_s     DOUBLE       NOT NULL,
    magnitud_absoluta  DOUBLE       NOT NULL,
    diametro_m         DOUBLE       NOT NULL,
    diametro_estimado  BOOLEAN      NOT NULL COMMENT 'TRUE si se calculó con H y albedo 0.14',
    UNIQUE KEY uq_evento (designacion, fecha_acercamiento)
);

-- Trayectorias de los eventos: misma estructura que trayectorias.
CREATE TABLE trayectorias_eventos (
    id_evento        INT UNSIGNED NOT NULL,
    cuerpo           ENUM('asteroide', 'luna', 'sol') NOT NULL,
    instante         DATETIME NOT NULL COMMENT 'TDB (~UTC + 69s)',
    x_km             DOUBLE NOT NULL COMMENT 'Plano de la eclíptica, centro de la Tierra',
    y_km             DOUBLE NOT NULL,
    z_km             DOUBLE NOT NULL,
    PRIMARY KEY (id_evento, cuerpo, instante),
    CONSTRAINT fk_trayectoria_evento FOREIGN KEY (id_evento) REFERENCES eventos (id)
);

-- Bólidos: rocas que se desintegraron en la atmósfera (API Fireball de CNEOS).
CREATE TABLE bolidos (
    fecha              DATETIME NOT NULL COMMENT 'Instante de máximo brillo, UTC',
    latitud            DOUBLE   NOT NULL COMMENT 'Grados, positivo al norte',
    longitud           DOUBLE   NOT NULL COMMENT 'Grados, positivo al este',
    energia_impacto_kt DOUBLE   NULL COMMENT 'Energía total estimada, kilotones de TNT',
    energia_radiada_j  DOUBLE   NOT NULL COMMENT 'Energía óptica radiada, julios',
    altitud_km         DOUBLE   NULL,
    velocidad_km_s     DOUBLE   NULL,
    PRIMARY KEY (fecha, latitud, longitud)
);

-- Vista que consume el dashboard: une cada acercamiento con su asteroide.
CREATE VIEW vista_acercamientos AS
SELECT c.id, c.id_neo, a.nombre, c.fecha_acercamiento, c.velocidad_km_s,
       c.distancia_km, c.distancia_lunar, a.diametro_min_m, a.diametro_max_m,
       (a.diametro_min_m + a.diametro_max_m) / 2 AS diametro_medio_m,
       a.es_peligroso, a.es_sentry, a.url_jpl
FROM acercamientos c
JOIN asteroides a ON a.id_neo = c.id_neo;
