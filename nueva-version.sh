#!/bin/bash
# nueva-version.sh
#
# Sube de versión el paquete recoverpass-greeter, lo compila y deja todo listo
# para desplegar en un solo paso:
#
#   1. Sube la versión en debian/changelog (X.Y.Z -> X.Y.(Z+1)).
#   2. Compila el .deb en un contenedor Ubuntu 24.04 (requiere Docker).
#   3. Lo coloca en la raíz del proyecto y en puppet/recoverpass_greeter/files/.
#   4. Actualiza $version en puppet/recoverpass_greeter/manifests/init.pp.
#   5. Borra los .deb de la versión anterior en ambos sitios.
#   6. Genera un .zip descargable del módulo de Puppet completo (manifiesto +
#      el .deb nuevo + recoverpass.conf), listo para copiar al puppetmaster.
#
# Uso:
#   ./nueva-version.sh
#
# No toca el repositorio de git: sólo modifica ficheros en el árbol de trabajo.
# Revise el diff y haga el commit a mano cuando esté conforme.

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAQUETE_DIR="$RAIZ/recoverpass-greeter"
PUPPET_DIR="$RAIZ/puppet/recoverpass_greeter"
CHANGELOG="$PAQUETE_DIR/debian/changelog"
MANIFIESTO="$PUPPET_DIR/manifests/init.pp"

aviso() { echo "nueva-version: $*" >&2; }

if [ ! -f "$CHANGELOG" ]; then
    aviso "no se encuentra $CHANGELOG"
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    aviso "hace falta Docker para compilar el paquete."
    exit 1
fi

# ---- 1. Subir la versión en el changelog -----------------------------------

VERSION_ACTUAL=$(sed -n '1s/.*(\([^)]*\)).*/\1/p' "$CHANGELOG")
if [ -z "$VERSION_ACTUAL" ]; then
    aviso "no se ha podido leer la versión actual de $CHANGELOG"
    exit 1
fi
if ! [[ "$VERSION_ACTUAL" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    aviso "la versión «$VERSION_ACTUAL» no tiene el formato X.Y.Z esperado"
    exit 1
fi

# Incrementa el último componente: X.Y.Z -> X.Y.(Z+1)
VERSION_NUEVA=$(awk -F. '{printf "%d.%d.%d", $1, $2, $3+1}' <<< "$VERSION_ACTUAL")

echo "Versión actual: $VERSION_ACTUAL"
echo "Versión nueva:  $VERSION_NUEVA"
echo

TMP_CHANGELOG=$(mktemp)
{
    echo "recoverpass-greeter (${VERSION_NUEVA}) noble; urgency=medium"
    echo
    echo "  * Nueva versión."
    echo
    echo " -- Fusion Telecom <manuel@fusiontelecom.co>  $(date -R)"
    echo
    cat "$CHANGELOG"
} > "$TMP_CHANGELOG"
mv "$TMP_CHANGELOG" "$CHANGELOG"
echo "Actualizado $CHANGELOG"

# ---- 2. Compilar el paquete -------------------------------------------------

echo
echo "Compilando el paquete en un contenedor Ubuntu 24.04..."
docker run --rm --platform linux/amd64 \
    -v "$PAQUETE_DIR":/src:ro \
    -v "$RAIZ":/salida \
    ubuntu:24.04 bash -c '
        set -e
        export DEBIAN_FRONTEND=noninteractive
        apt-get -qq update >/dev/null
        apt-get -qq install -y build-essential debhelper devscripts >/dev/null
        cp -a /src /build
        cd /build
        dpkg-buildpackage -us -uc -b
        cp /*.deb /salida/
    '

DEB_NUEVO="$RAIZ/recoverpass-greeter_${VERSION_NUEVA}_all.deb"
if [ ! -f "$DEB_NUEVO" ]; then
    aviso "la compilación no ha generado $DEB_NUEVO"
    exit 1
fi
echo "Construido: $DEB_NUEVO"

# ---- 3. Copiarlo también a puppet/recoverpass_greeter/files/ -----------------

mkdir -p "$PUPPET_DIR/files"
cp "$DEB_NUEVO" "$PUPPET_DIR/files/"
echo "Copiado a $PUPPET_DIR/files/"

# ---- 4. Actualizar $version en el manifiesto de Puppet ---------------------

if [ -f "$MANIFIESTO" ]; then
    # Se sustituye cualquier versión que hubiera, sin exigir que coincida con
    # VERSION_ACTUAL: si el manifiesto ya estaba desincronizado del .deb de la
    # raíz (como ocurre la primera vez que se usa este script), igualmente
    # queda al día.
    if grep -qE "^[[:space:]]*String[[:space:]]+\\\$version[[:space:]]*=[[:space:]]*'[0-9]+\.[0-9]+\.[0-9]+'," "$MANIFIESTO"; then
        sed -i.bak -E "s/(String[[:space:]]+\\\$version[[:space:]]*=[[:space:]]*')[0-9]+\.[0-9]+\.[0-9]+(')/\\1${VERSION_NUEVA}\\2/" "$MANIFIESTO"
        rm -f "$MANIFIESTO.bak"
        echo "Actualizado \$version en $MANIFIESTO -> $VERSION_NUEVA"
    else
        aviso "ATENCIÓN: no se ha encontrado la línea de \$version en $MANIFIESTO."
        aviso "  Actualícelo a mano a ${VERSION_NUEVA}."
    fi
else
    aviso "ATENCIÓN: no se encuentra $MANIFIESTO; no se ha actualizado \$version."
fi

# ---- 5. Borrar los .deb de la versión anterior -----------------------------

DEB_VIEJO_RAIZ="$RAIZ/recoverpass-greeter_${VERSION_ACTUAL}_all.deb"
DEB_VIEJO_PUPPET="$PUPPET_DIR/files/recoverpass-greeter_${VERSION_ACTUAL}_all.deb"

for f in "$DEB_VIEJO_RAIZ" "$DEB_VIEJO_PUPPET"; do
    if [ -f "$f" ]; then
        rm -f "$f"
        echo "Borrado: $f"
    fi
done

# Por si quedara suelto algún .deb de una versión más antigua todavía
find "$RAIZ" -maxdepth 1 -name 'recoverpass-greeter_*_all.deb' ! -name "$(basename "$DEB_NUEVO")" -print -delete
find "$PUPPET_DIR/files" -maxdepth 1 -name 'recoverpass-greeter_*_all.deb' ! -name "$(basename "$DEB_NUEVO")" -print -delete

# ---- 6. Zip descargable del módulo de Puppet -------------------------------

# Nombre FIJO, sin versión: install_puppet lo descarga siempre de la misma URL
# (puppet:///.../main/recoverpass_greeter_puppet.zip). Si el nombre llevara la
# versión, esa URL quedaría obsoleta en cada release y habría que tocar el
# script de instalación cada vez.
ZIP_RUTA="$RAIZ/recoverpass_greeter_puppet.zip"
rm -f "$ZIP_RUTA" "$RAIZ"/recoverpass_greeter_puppet_*.zip   # también las versionadas de antes

(cd "$RAIZ/puppet" && zip -qr "$ZIP_RUTA" recoverpass_greeter -x '*.DS_Store' '*.bak')
echo "Generado: $ZIP_RUTA"

# ---- Resumen ----------------------------------------------------------------

echo
echo "Listo. Versión ${VERSION_ACTUAL} -> ${VERSION_NUEVA}:"
echo "  - $DEB_NUEVO"
echo "  - $PUPPET_DIR/files/$(basename "$DEB_NUEVO")"
echo "  - $ZIP_RUTA"
echo
echo "Nada de esto se ha subido a git. Revise el diff y haga commit a mano:"
echo "  git status"
