#!/bin/bash
# Usuario de solo lectura para el dashboard (principio de mínimo privilegio).
# El usuario del ingestor (MYSQL_USER) lo crea la imagen oficial con permisos completos sobre la base.
set -e
mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<EOSQL
CREATE USER IF NOT EXISTS 'dash_lector'@'%' IDENTIFIED BY '${DASH_DB_PASSWORD}';
GRANT SELECT ON \`${MYSQL_DATABASE}\`.* TO 'dash_lector'@'%';
FLUSH PRIVILEGES;
EOSQL
