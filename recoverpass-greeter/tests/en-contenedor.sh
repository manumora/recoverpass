#!/bin/bash
# Batería de pruebas del paquete. Se ejecuta DENTRO de un contenedor
# ubuntu:24.04 (véase tests/probar.sh, que es lo que se lanza desde fuera).
#
# Comprueba:
#   1. que el paquete construye
#   2. lintian sin errores
#   3. instalación, con lightdm de verdad instalado
#   4. que el bloque de PAM se añade una sola vez, aunque se instale dos veces
#   5. que el JSON de políticas se genera bien y es JSON válido
#   6. remove: se retira todo lo que toca a otros paquetes
#   7. purge: /etc/pam.d/lightdm queda byte a byte como el original
#
# No se puede probar aquí: el greeter en pantalla, el snap de Chromium ni el
# arranque real de la sesión. Eso va en CHECKLIST-VM.md.

set -u

ROJO='\033[31m'; VERDE='\033[32m'; AMARILLO='\033[33m'; FIN='\033[0m'
FALLOS=0

ok()    { echo -e "${VERDE}  OK${FIN}   $*"; }
falla() { echo -e "${ROJO}  FALLA${FIN} $*"; FALLOS=$((FALLOS+1)); }
titulo(){ echo; echo -e "${AMARILLO}== $* ==${FIN}"; }

export DEBIAN_FRONTEND=noninteractive

titulo "0. Preparación"
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends \
    build-essential debhelper devscripts lintian fakeroot \
    lightdm yad x11-utils x11-xserver-utils fonts-open-sans libnss3-tools \
    python3 diffutils file >/dev/null 2>&1
ok "dependencias de construcción y del paquete instaladas"

# Copia del original de /etc/pam.d/lightdm, tal y como lo dejó el paquete
# lightdm, para el diff final.
cp -a /etc/pam.d/lightdm /root/lightdm.pam.original
ok "guardada copia del /etc/pam.d/lightdm original"

titulo "1. Construcción"
rm -rf /build && mkdir -p /build
cp -a /src /build/recoverpass-greeter
cd /build/recoverpass-greeter || exit 1
rm -rf debian/.debhelper debian/recoverpass-greeter debian/files
if dpkg-buildpackage -us -uc -b >/build/build.log 2>&1; then
    ok "dpkg-buildpackage -us -uc"
else
    falla "dpkg-buildpackage"
    tail -40 /build/build.log
    exit 1
fi

DEB=$(ls /build/recoverpass-greeter_*.deb 2>/dev/null | head -1)
[ -n "$DEB" ] && ok "generado $(basename "$DEB")" || { falla "no se ha generado ningún .deb"; exit 1; }

titulo "2. lintian"
lintian --no-tag-display-limit "$DEB" > /build/lintian.log 2>&1
ERRORES=$(grep -c '^E:' /build/lintian.log || true)
AVISOS=$(grep -c '^W:' /build/lintian.log || true)
cat /build/lintian.log
if [ "$ERRORES" -eq 0 ]; then
    ok "sin errores de lintian ($AVISOS avisos)"
else
    falla "$ERRORES errores de lintian"
fi

titulo "3. Instalación"
if dpkg -i "$DEB" > /build/install.log 2>&1; then
    ok "dpkg -i"
else
    falla "dpkg -i"
    cat /build/install.log
fi
grep -q 'ATENCIÓN' /build/install.log && echo "  (avisos del postinst, esperados en un contenedor sin greeter ni navegador)"

# Ficheros esperados
for f in /usr/bin/recoverpass-session \
         /usr/bin/recoverpass-update-policy \
         /usr/share/xsessions/recoverpass.desktop \
         /usr/share/xgreeters/recoverpass-greeter.desktop \
         /etc/recoverpass/recoverpass.conf \
         /usr/share/recoverpass/chrome-policy.json.in \
         /usr/share/web-greeter/themes/recoverpass/index.html \
         /usr/share/web-greeter/themes/recoverpass/js/greeter.js \
         /usr/share/web-greeter/themes/recoverpass/mock/index.html; do
    [ -e "$f" ] && ok "existe $f" || falla "falta $f"
done

[ -x /usr/bin/recoverpass-session ] && ok "recoverpass-session es ejecutable" \
    || falla "recoverpass-session no es ejecutable"

# La cuenta
if getent passwd recoverpass >/dev/null; then
    ok "cuenta recoverpass creada"
    case "$(getent passwd recoverpass | cut -d: -f6)" in
        /var/lib/recoverpass) ok "el home está en /var/lib (no en /home, que gestiona autofs)" ;;
        *) falla "el home no es /var/lib/recoverpass: $(getent passwd recoverpass | cut -d: -f6)" ;;
    esac
    getent passwd recoverpass | grep -q ':/bin/bash$' \
        && ok "conserva el shell /bin/bash" \
        || falla "el shell no es /bin/bash: $(getent passwd recoverpass)"
    if grep -q '^recoverpass:[!*]' /etc/shadow; then
        ok "contraseña bloqueada"
    else
        falla "la contraseña no está bloqueada: $(grep '^recoverpass:' /etc/shadow | cut -d: -f2)"
    fi
    id -nG recoverpass | grep -qw sudo && falla "está en el grupo sudo" || ok "no está en sudo"
else
    falla "no se ha creado la cuenta recoverpass"
fi

# AccountsService
if [ -f /var/lib/AccountsService/users/recoverpass ]; then
    ok "fichero de AccountsService creado"
    grep -q 'SystemAccount=true' /var/lib/AccountsService/users/recoverpass \
        && ok "SystemAccount=true" || falla "falta SystemAccount=true"
    grep -q 'XSession=recoverpass' /var/lib/AccountsService/users/recoverpass \
        && ok "XSession=recoverpass" || falla "falta XSession=recoverpass"
else
    falla "no se ha creado el fichero de AccountsService"
fi

# PAM
VECES=$(grep -c 'pam_succeed_if.so user = recoverpass' /etc/pam.d/lightdm || true)
[ "$VECES" -eq 1 ] && ok "la línea de PAM aparece una vez" || falla "la línea de PAM aparece $VECES veces"
head -1 /etc/pam.d/lightdm | grep -q 'BEGIN recoverpass-greeter' \
    && ok "el bloque está al principio del fichero" \
    || falla "el bloque no está al principio: $(head -1 /etc/pam.d/lightdm)"
grep -n 'recoverpass\|common-auth' /etc/pam.d/lightdm | head -5

# El bloque tiene que ir ANTES de @include common-auth
LINEA_NUESTRA=$(grep -n 'pam_succeed_if.so user = recoverpass' /etc/pam.d/lightdm | cut -d: -f1)
LINEA_COMMON=$(grep -n '@include common-auth' /etc/pam.d/lightdm | head -1 | cut -d: -f1)
if [ -n "$LINEA_NUESTRA" ] && [ -n "$LINEA_COMMON" ] && [ "$LINEA_NUESTRA" -lt "$LINEA_COMMON" ]; then
    ok "va antes de @include common-auth (línea $LINEA_NUESTRA < $LINEA_COMMON)"
else
    falla "no va antes de @include common-auth"
fi

[ -f /var/backups/recoverpass-greeter/pam.d-lightdm.orig ] \
    && ok "copia de seguridad de PAM guardada" || falla "no hay copia de seguridad de PAM"

titulo "4. Políticas del navegador"
POL=/etc/chromium-browser/policies/managed/recoverpass.json
if [ -f "$POL" ]; then
    ok "generado $POL"
    if python3 -c "import json,sys; json.load(open('$POL'))" 2>/dev/null; then
        ok "es JSON válido"
    else
        falla "no es JSON válido"
        cat "$POL"
    fi
    python3 - <<'PY' || FALLOS=$((FALLOS+1))
import json
d=json.load(open('/etc/chromium-browser/policies/managed/recoverpass.json'))
assert d['URLBlocklist']==['*'], d['URLBlocklist']
assert d['URLAllowlist']==['sspr.example.local'], d['URLAllowlist']
assert d['AllowFileSelectionDialogs'] is False
print('  OK   URLBlocklist/URLAllowlist/AllowFileSelectionDialogs correctos')
PY
    # Con dominios adicionales
    sed -i 's|^ALLOWED_DOMAINS=.*|ALLOWED_DOMAINS="https://cdn.ejemplo.com https://idp.ejemplo.com"|' \
        /etc/recoverpass/recoverpass.conf
    sed -i 's|^PORTAL_URL=.*|PORTAL_URL="https://sspr.otroejemplo.co"|' \
        /etc/recoverpass/recoverpass.conf
    recoverpass-update-policy >/dev/null 2>&1
    python3 - <<'PY' || FALLOS=$((FALLOS+1))
import json
d=json.load(open('/etc/chromium-browser/policies/managed/recoverpass.json'))
esperado=['sspr.otroejemplo.co','https://cdn.ejemplo.com','https://idp.ejemplo.com']
assert d['URLAllowlist']==esperado, d['URLAllowlist']
print('  OK   la lista de permitidos se regenera desde la configuración')
PY
    # El host del portal entra como dominio y no se duplica si ya está puesto
    sed -i 's|^PORTAL_URL=.*|PORTAL_URL="https://portal.ejemplo.co:8443/ruta/larga"|' \
        /etc/recoverpass/recoverpass.conf
    sed -i 's|^ALLOWED_DOMAINS=.*|ALLOWED_DOMAINS="portal.ejemplo.co:8443 cdn.ejemplo.com"|' \
        /etc/recoverpass/recoverpass.conf
    recoverpass-update-policy >/dev/null 2>&1
    python3 - <<'PY' || FALLOS=$((FALLOS+1))
import json
d=json.load(open('/etc/chromium-browser/policies/managed/recoverpass.json'))
esperado=['portal.ejemplo.co:8443','cdn.ejemplo.com']
assert d['URLAllowlist']==esperado, d['URLAllowlist']
print('  OK   del portal se permite el host (con puerto) y sin duplicados')
PY
else
    falla "no se ha generado $POL"
fi

titulo "5. Segunda instalación (idempotencia)"
if dpkg -i "$DEB" > /build/install2.log 2>&1; then
    ok "segunda instalación"
else
    falla "segunda instalación"
    cat /build/install2.log
fi
VECES=$(grep -c 'pam_succeed_if.so user = recoverpass' /etc/pam.d/lightdm || true)
[ "$VECES" -eq 1 ] && ok "la línea de PAM sigue apareciendo una sola vez" \
                   || falla "la línea de PAM aparece $VECES veces tras reinstalar"
MARCAS=$(grep -c 'BEGIN recoverpass-greeter' /etc/pam.d/lightdm || true)
[ "$MARCAS" -eq 1 ] && ok "hay un solo marcador BEGIN" || falla "hay $MARCAS marcadores BEGIN"
CUENTAS=$(getent passwd | grep -c '^recoverpass:' || true)
[ "$CUENTAS" -eq 1 ] && ok "la cuenta no se ha duplicado" || falla "hay $CUENTAS cuentas recoverpass"

titulo "6. Desinstalación (remove)"
if dpkg -r recoverpass-greeter > /build/remove.log 2>&1; then
    ok "dpkg -r"
else
    falla "dpkg -r"; cat /build/remove.log
fi
grep -q 'recoverpass' /etc/pam.d/lightdm && falla "queda rastro en /etc/pam.d/lightdm" \
                                         || ok "sin rastro en /etc/pam.d/lightdm"
[ -e /etc/lightdm/lightdm.conf.d/99-recoverpass-greeter.conf ] \
    && falla "queda el drop-in del greeter" || ok "drop-in del greeter retirado"
[ -e "$POL" ] && falla "quedan las políticas del navegador" || ok "políticas del navegador retiradas"
[ -e /var/lib/AccountsService/users/recoverpass ] \
    && falla "queda el fichero de AccountsService" || ok "fichero de AccountsService retirado"
getent passwd recoverpass >/dev/null \
    && ok "la cuenta sigue existiendo tras «remove» (se borra al purgar)" \
    || falla "la cuenta se ha borrado en «remove», debía borrarse sólo al purgar"
[ -e /etc/recoverpass/recoverpass.conf ] \
    && ok "el conffile sigue tras «remove»" || falla "el conffile ha desaparecido en «remove»"

titulo "7. Purgado"
if dpkg -P recoverpass-greeter > /build/purge.log 2>&1; then
    ok "dpkg -P"
else
    falla "dpkg -P"; cat /build/purge.log
fi
getent passwd recoverpass >/dev/null && falla "la cuenta sigue existiendo tras purgar" \
                                     || ok "cuenta borrada"
[ -e /var/lib/recoverpass ] && falla "queda /var/lib/recoverpass" || ok "home borrado"
[ -e /etc/recoverpass ] && falla "queda /etc/recoverpass" || ok "/etc/recoverpass borrado"
[ -e /var/lib/recoverpass-greeter ] && falla "queda /var/lib/recoverpass-greeter" || ok "estado borrado"
[ -e /var/backups/recoverpass-greeter ] && falla "quedan copias en /var/backups" || ok "copias borradas"
[ -e /usr/share/web-greeter/themes/recoverpass ] && falla "queda el tema" || ok "tema borrado"

titulo "8. /etc/pam.d/lightdm byte a byte"
if cmp -s /root/lightdm.pam.original /etc/pam.d/lightdm; then
    ok "idéntico al original tras el purgado"
else
    falla "difiere del original tras el purgado"
    diff -u /root/lightdm.pam.original /etc/pam.d/lightdm
fi

titulo "9. dpkg no reporta ficheros huérfanos"
# Se filtran los «missing» de documentación y traducciones: la imagen de
# contenedor excluye esas rutas de serie, no tienen nada que ver con nosotros.
RESTOS=$(dpkg -V lightdm 2>/dev/null | grep -v '^missing' | grep -v '^$' || true)
if [ -z "$RESTOS" ]; then
    ok "dpkg -V lightdm no encuentra ningún fichero modificado"
else
    falla "dpkg -V lightdm informa de cambios:"
    echo "$RESTOS"
fi

titulo "Resultado"
if [ "$FALLOS" -eq 0 ]; then
    echo -e "${VERDE}Todas las comprobaciones han pasado.${FIN}"
else
    echo -e "${ROJO}$FALLOS comprobaciones han fallado.${FIN}"
fi
exit "$FALLOS"
