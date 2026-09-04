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
#   6. que la duplicación de pantallas elige el modo más alto común
#   7. remove: se retira todo lo que toca a otros paquetes
#   8. purge: /etc/pam.d/lightdm y /etc/security/pwquality.conf quedan byte a
#      byte como los originales
#   9. que el bloque de pwquality.conf activa local_users_only una sola vez, va
#      al final del fichero y no rompe la lectura de la configuración
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
    libpam-pwquality libpwquality-common libpwquality-tools cracklib-runtime \
    python3 diffutils file >/dev/null 2>&1
ok "dependencias de construcción y del paquete instaladas"

# Copia del original de /etc/pam.d/lightdm, tal y como lo dejó el paquete
# lightdm, para el diff final.
cp -a /etc/pam.d/lightdm /root/lightdm.pam.original
ok "guardada copia del /etc/pam.d/lightdm original"

# Y del pwquality.conf, que es el segundo conffile ajeno que se toca.
PWQ=/etc/security/pwquality.conf
if [ -f "$PWQ" ]; then
    cp -a "$PWQ" /root/pwquality.conf.original
    ok "guardada copia del $PWQ original"
else
    falla "no existe $PWQ; ¿se ha instalado libpwquality-common?"
fi

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
         /usr/bin/recoverpass-duplicar-pantallas \
         /usr/share/xsessions/recoverpass.desktop \
         /usr/share/xgreeters/recoverpass-greeter.desktop \
         /etc/recoverpass/recoverpass.conf \
         /usr/share/recoverpass/chrome-policy.json.in \
         /usr/share/web-greeter/themes/recoverpass/index.html \
         /usr/share/web-greeter/themes/recoverpass/secondary.html \
         /usr/share/web-greeter/themes/recoverpass/js/greeter.js \
         /usr/share/web-greeter/themes/recoverpass/js/apariencia.js \
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

# --- pwquality: la calidad la decide el directorio, no el equipo -----------
MARCAS=$(grep -c 'BEGIN recoverpass-greeter' "$PWQ" 2>/dev/null || true)
[ "$MARCAS" -eq 1 ] && ok "un solo marcador en $PWQ" \
                    || falla "hay $MARCAS marcadores en $PWQ"
grep -qx 'local_users_only' "$PWQ" \
    && ok "local_users_only activa (bandera por presencia)" \
    || falla "no está local_users_only sin comentar en $PWQ"
sed -n '/BEGIN recoverpass-greeter/,/END recoverpass-greeter/p' "$PWQ" \
    | grep -qx 'local_users_only' \
    && ok "la opción va dentro del bloque delimitado" \
    || falla "la opción está suelta, fuera del bloque"
# El bloque tiene que ser lo ÚLTIMO: es lo que hace que sea retirable de una
# pieza sin arrastrar nada de lo que hubiera detrás.
tail -1 "$PWQ" | grep -q 'END recoverpass-greeter' \
    && ok "el bloque es lo último del fichero" \
    || falla "el bloque no cierra el fichero: $(tail -1 "$PWQ")"
[ -f /var/backups/recoverpass-greeter/security-pwquality.conf.orig ] \
    && ok "copia de seguridad de pwquality guardada" \
    || falla "no hay copia de seguridad de pwquality"
# La aserción fuerte: quitando nuestro bloque el fichero ya es el original, sin
# esperar al purgado. Caza cualquier edición colateral en el momento de hacerla.
sed '/BEGIN recoverpass-greeter/,/END recoverpass-greeter/d' "$PWQ" \
    | cmp -s - /root/pwquality.conf.original \
    && ok "sin el bloque, $PWQ ya es idéntico al original" \
    || falla "el paquete ha cambiado algo más de $PWQ"
# Y que libpwquality siga pudiendo leer su configuración: una clave que no
# conozca hace que devuelva «Unknown setting» y pam_pwquality puede abortar
# entonces el cambio de contraseña de TODO EL MUNDO, root incluido.
# Ojo con el criterio: pwscore sale con código distinto de 0 por CUALQUIER
# contraseña rechazada, así que el código de salida no sirve. Lo único que se
# quiere saber es si se ha podido LEER la configuración, y eso se ve en el
# texto: una clave desconocida da «Cannot read the pwquality configuration».
SALIDA_PWQ=$(printf '%s\n' 'Kf7$muralla' | pwscore 2>&1 || true)
if printf '%s' "$SALIDA_PWQ" | grep -qi 'read the pwquality configuration\|unknown setting'; then
    falla "libpwquality no puede leer $PWQ"
    printf '%s\n' "$SALIDA_PWQ" | head -3
else
    ok "libpwquality lee la configuración sin errores"
fi
# Lo que NO se puede comprobar aquí: que local_users_only salte de verdad las
# comprobaciones de un usuario ausente de /etc/passwd. pwscore usa el uid que
# lo invoca y en el contenedor root es local, así que siempre comprueba. Eso va
# en CHECKLIST-VM.md, con un usuario del directorio de verdad.

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
assert d['URLAllowlist']==['educontrol.santaeulalia'], d['URLAllowlist']
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

titulo "5. Duplicación de pantallas"
# En el contenedor no hay servidor X, así que se le da a
# recoverpass-duplicar-pantallas un xrandr simulado por RECOVERPASS_XRANDR: se
# comprueba QUÉ MODO elegiría y que no toca nada cuando no debe. Lo que sí se
# ve de verdad en un equipo está en CHECKLIST-VM.md.
FALSO=/build/xrandr-falso
APLICADO=/build/xrandr-aplicado
cat > "$FALSO" <<'FAKE'
#!/bin/sh
# xrandr simulado. Con --query imprime el escenario de $FALSO_ESCENARIO; con
# cualquier otra cosa apunta los argumentos en $FALSO_APLICADO.
if [ "$1" = "--query" ]; then
    if [ -s "$FALSO_APLICADO" ]; then
        # Después de aplicar, las dos salidas ya están duplicadas.
        printf '%s\n' "Screen 0: minimum 320 x 200, current 1280 x 800, maximum 16384 x 16384"
        printf '%s\n' "eDP-1 connected primary 1280x800+0+0 (normal left inverted right x axis) 344mm x 194mm"
        printf '%s\n' "   1280x800      59.81*+"
        printf '%s\n' "HDMI-1 connected 1280x800+0+0 (normal left inverted right x axis) 000mm x 000mm"
        printf '%s\n' "   1280x800      59.81*+"
        exit 0
    fi
    printf '%s\n' "Screen 0: minimum 320 x 200, current 3200 x 1080, maximum 16384 x 16384"
    printf '%s\n' "eDP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis) 344mm x 194mm"
    printf '%s\n' "   1920x1080i    60.02*+"
    printf '%s\n' "   1920x1080     60.02"
    printf '%s\n' "   1600x900      59.99"
    [ "$FALSO_ESCENARIO" = "sin-comun" ] || printf '%s\n' "   1280x800      59.81"
    printf '%s\n' "DP-1 disconnected (normal left inverted right x axis)"
    printf '%s\n' "HDMI-1 connected 1280x800+1920+0 (normal left inverted right x axis) 000mm x 000mm"
    printf '%s\n' "   1280x800      59.81*+"
    printf '%s\n' "   1024x768      60.00"
    exit 0
fi
printf '%s\n' "$*" >> "$FALSO_APLICADO"
exit 0
FAKE
chmod +x "$FALSO"

duplicar() {
    : > "$APLICADO"
    FALSO_ESCENARIO="$1" FALSO_APLICADO="$APLICADO" \
        RECOVERPASS_XRANDR="$FALSO" DISPLAY="${2-:99}" \
        /usr/bin/recoverpass-duplicar-pantallas 2>/dev/null
    echo "$?" > /build/duplicar-codigo
}

# Escritorio extendido: elige el modo más alto COMÚN a las dos salidas
# (1280x800; el 1920x1080 sólo lo tiene la primera) y las pone las dos en 0x0.
duplicar extendido
[ "$(cat /build/duplicar-codigo)" = "0" ] && ok "duplicar-pantallas sale con 0" \
    || falla "duplicar-pantallas sale con $(cat /build/duplicar-codigo)"
if grep -q -- "--output eDP-1 --mode 1280x800 --pos 0x0 --rotate normal --primary" "$APLICADO" &&
   grep -q -- "--output HDMI-1 --mode 1280x800 --pos 0x0 --rotate normal" "$APLICADO"; then
    ok "elige el modo más alto común y pone las dos salidas en 0x0"
else
    falla "no ha aplicado la duplicación esperada"
    cat "$APLICADO"
fi
# El modo entrelazado (1920x1080i) no se tiene en cuenta.
grep -q -- "--mode 1920x1080i" "$APLICADO" \
    && falla "ha elegido un modo entrelazado" \
    || ok "descarta los modos entrelazados"

# Sin ningún modo común no se toca la disposición del equipo.
duplicar sin-comun
[ -s "$APLICADO" ] \
    && falla "sin modo común no debería aplicar nada" \
    || ok "sin modo común deja la disposición como esté"

# Sin DISPLAY tampoco, y sin fallar.
duplicar extendido ""
if [ "$(cat /build/duplicar-codigo)" = "0" ] && [ ! -s "$APLICADO" ]; then
    ok "sin DISPLAY no hace nada y sale con 0"
else
    falla "sin DISPLAY: código $(cat /build/duplicar-codigo), aplicado «$(cat "$APLICADO")»"
fi

# FORCE_MIRROR="false" se respeta.
sed -i 's|^FORCE_MIRROR=.*|FORCE_MIRROR="false"|' /etc/recoverpass/recoverpass.conf
duplicar extendido
if [ "$(cat /build/duplicar-codigo)" = "0" ] && [ ! -s "$APLICADO" ]; then
    ok "con FORCE_MIRROR=\"false\" no toca las pantallas"
else
    falla "FORCE_MIRROR=\"false\" no se respeta"
fi
sed -i 's|^FORCE_MIRROR=.*|FORCE_MIRROR="true"|' /etc/recoverpass/recoverpass.conf

titulo "6. Segunda instalación (idempotencia)"
# Un web-greeter de mentira: el postinst sólo escribe el drop-in de LightDM si
# lo encuentra instalado, y sin esto el drop-in no se comprueba nunca en
# positivo (sólo que desaparece al desinstalar, en el apartado 7).
mkdir -p /opt/web-greeter
: > /opt/web-greeter/web-greeter
chmod 0755 /opt/web-greeter/web-greeter

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

# ---- El drop-in de LightDM, ahora que hay «web-greeter» -------------------
DROPIN=/etc/lightdm/lightdm.conf.d/99-recoverpass-greeter.conf
if [ -f "$DROPIN" ]; then
    ok "se ha escrito $DROPIN"
    grep -q '^greeter-session=recoverpass-greeter$' "$DROPIN" \
        && ok "el drop-in selecciona el greeter del kiosco" \
        || falla "el drop-in no selecciona recoverpass-greeter"

    VALOR=$(sed -n 's/^display-setup-script=//p' "$DROPIN")
    case "$VALOR" in
        *recoverpass-duplicar-pantallas*) ok "el drop-in engancha la duplicación de pantallas" ;;
        *) falla "el drop-in no engancha recoverpass-duplicar-pantallas: «$VALOR»" ;;
    esac
    # Esta comprobación existe para que nadie «simplifique» la envoltura: sin
    # el «|| true», un fallo del script deja el equipo sin pantalla de acceso.
    case "$VALOR" in
        *"|| true"*) ok "la orden del drop-in va envuelta en «|| true»" ;;
        *) falla "falta el «|| true» en display-setup-script: «$VALOR»" ;;
    esac
    # Y que el valor sea de verdad una orden que sale con 0 aunque no haya X.
    if env -u DISPLAY -u XAUTHORITY sh -c "$VALOR" >/dev/null 2>&1; then
        ok "la orden del drop-in sale con 0 sin servidor X"
    else
        falla "la orden del drop-in falla sin servidor X: «$VALOR»"
    fi

    cp "$DROPIN" /build/dropin-antes
    dpkg -i "$DEB" > /build/install3.log 2>&1 || true
    cmp -s /build/dropin-antes "$DROPIN" \
        && ok "reinstalar deja el drop-in byte a byte igual" \
        || falla "reinstalar cambia el drop-in"

    # El bloque de pwquality tampoco se duplica al reinstalar.
    MARCAS=$(grep -c 'BEGIN recoverpass-greeter' "$PWQ" 2>/dev/null || true)
    VECES_OPT=$(grep -cx 'local_users_only' "$PWQ" 2>/dev/null || true)
    [ "$MARCAS" -eq 1 ] && [ "$VECES_OPT" -eq 1 ] \
        && ok "reinstalar no duplica el bloque de pwquality" \
        || falla "tras reinstalar hay $MARCAS marcadores y $VECES_OPT opciones en $PWQ"
else
    falla "no se ha escrito $DROPIN con web-greeter presente"
    grep -i 'ATENCIÓN' /build/install2.log || true
fi

titulo "7. Desinstalación (remove)"
if dpkg -r recoverpass-greeter > /build/remove.log 2>&1; then
    ok "dpkg -r"
else
    falla "dpkg -r"; cat /build/remove.log
fi
grep -q 'recoverpass' /etc/pam.d/lightdm && falla "queda rastro en /etc/pam.d/lightdm" \
                                         || ok "sin rastro en /etc/pam.d/lightdm"
grep -q 'recoverpass' "$PWQ" && falla "queda rastro en $PWQ" \
                            || ok "sin rastro en $PWQ"
grep -qx 'local_users_only' "$PWQ" && falla "local_users_only sigue activa tras remove" \
                                   || ok "local_users_only retirada"
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

titulo "8. Purgado"
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

titulo "9. Los conffiles de otros paquetes, byte a byte"
if cmp -s /root/lightdm.pam.original /etc/pam.d/lightdm; then
    ok "/etc/pam.d/lightdm idéntico al original tras el purgado"
else
    falla "/etc/pam.d/lightdm difiere del original tras el purgado"
    diff -u /root/lightdm.pam.original /etc/pam.d/lightdm
fi
if cmp -s /root/pwquality.conf.original "$PWQ"; then
    ok "$PWQ idéntico al original tras el purgado"
else
    falla "$PWQ difiere del original tras el purgado"
    diff -u /root/pwquality.conf.original "$PWQ"
fi

titulo "10. dpkg no reporta ficheros huérfanos"
# Se filtran los «missing» de documentación y traducciones: la imagen de
# contenedor excluye esas rutas de serie, no tienen nada que ver con nosotros.
for PAQUETE in lightdm libpwquality-common; do
    RESTOS=$(dpkg -V "$PAQUETE" 2>/dev/null | grep -v '^missing' | grep -v '^$' || true)
    if [ -z "$RESTOS" ]; then
        ok "dpkg -V $PAQUETE no encuentra ningún fichero modificado"
    else
        falla "dpkg -V $PAQUETE informa de cambios:"
        echo "$RESTOS"
    fi
done

titulo "Resultado"
if [ "$FALLOS" -eq 0 ]; then
    echo -e "${VERDE}Todas las comprobaciones han pasado.${FIN}"
else
    echo -e "${ROJO}$FALLOS comprobaciones han fallado.${FIN}"
fi
exit "$FALLOS"
