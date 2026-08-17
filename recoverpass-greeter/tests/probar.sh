#!/bin/sh
# Lanza la batería de pruebas del paquete en un contenedor ubuntu:24.04.
#
#   ./tests/probar.sh
#
# Requiere Docker. El código fuente se monta en /src de sólo lectura y todo el
# trabajo se hace dentro del contenedor: no ensucia el árbol de fuentes.
set -e
RAIZ=$(cd "$(dirname "$0")/.." && pwd)
exec docker run --rm --platform linux/amd64 \
    -v "$RAIZ":/src:ro \
    ubuntu:24.04 \
    bash /src/tests/en-contenedor.sh
