# recoverpass-greeter

Añade a la pantalla de acceso de LightDM un botón **«Recuperar contraseña»** que
abre una sesión restringida y sin contraseña, con el navegador anclado a la web
de cambio de contraseña. Resuelve el problema de siempre: quien no puede autenticarse
tampoco puede abrir un navegador para usar la web.

El paquete deja un equipo limpio completamente configurado: cuenta local, PAM,
AccountsService, sesión kiosco, políticas del navegador, tema del greeter y
selección del greeter. Y se desinstala sin dejar rastro.

Desplegado sobre Ubuntu 22.04; probado también en 24.04.

---

## 1. Cómo funciona

La cadena completa, desde el botón hasta el navegador:

1. **El greeter.** Se sustituye el de serie por
   [web-greeter](https://github.com/JezerM/web-greeter) con un tema propio que
   añade un botón junto al formulario de acceso. La selección se hace con un
   *drop-in* en `/etc/lightdm/lightdm.conf.d/`, sin tocar `lightdm.conf`.
2. **La autenticación.** El botón llama a `authenticate("recoverpass")` y después
   a `start_session("recoverpass")`. Esa cuenta local entra **sin contraseña**
   por una línea de `pam_succeed_if` acotada a `/etc/pam.d/lightdm`: no se toca
   `common-auth`, así que `login`, `sshd` y `sudo` quedan al margen.
3. **La sesión kiosco.** LightDM arranca
   `/usr/share/xsessions/recoverpass.desktop`, que ejecuta
   `recoverpass-session`: el navegador anclado al portal, sin barra de
   direcciones ni pestañas, sobre un X vacío y sin gestor de ventanas, más una
   barra inferior con un botón **Salir**.
4. **El confinamiento.** Lo imponen las *políticas gestionadas* del navegador, no
   el script: todo bloqueado (`URLBlocklist: ["*"]`) salvo el portal y los
   dominios declarados. Sin descargas, sin diálogos de fichero, sin DevTools,
   sin modo incógnito.
5. **La vuelta.** Al pulsar Salir —o al cerrar el navegador, o al agotarse el
   tiempo— el script termina, LightDM cierra la sesión y se vuelve a la pantalla
   de acceso. El perfil del navegador se borra al entrar y al salir: no queda
   nada de una sesión para la siguiente.

---

## 2. Requisitos

| Componente | Cómo se resuelve |
|---|---|
| Ubuntu / Xubuntu 22.04 o 24.04, con LightDM | `Depends` |
| `yad`, `x11-utils`, `x11-xserver-utils`, `libnss3-tools`, `fonts-open-sans` | `Depends` |
| **web-greeter 3.5.3** | No está en los repositorios de Ubuntu, así que **viaja dentro del paquete**: se instala con `sudo recoverpass-instalar-greeter` |
| **Chromium** | `Recommends`. En 22.04 y 24.04 es un snap |

`fonts-open-sans` está en **universe**: si el parque sólo tiene *main*, habilite
universe antes de instalar.

---

## 3. Instalación

```bash
sudo apt install ./recoverpass-greeter_0.0.2_all.deb
sudo recoverpass-instalar-greeter    # instala web-greeter y activa el greeter
sudo snap install chromium           # si no estuviera ya
```

Después, **obligatorio**, poner la URL real del portal:

```bash
sudoedit /etc/recoverpass/recoverpass.conf   # PORTAL_URL
sudo recoverpass-update-policy               # regenera las políticas
sudo systemctl restart lightdm
```

> **`recoverpass-update-policy` no es opcional.** Editar la configuración no
> regenera las políticas del navegador, y no hay ningún mecanismo que lo haga
> solo. Si se olvida, el navegador sigue con las anteriores y muestra «La página
> está bloqueada, tu organización no permite ver este sitio».

**web-greeter no lo instala el postinst a propósito**: un `postinst` no puede
instalar otro paquete, porque dpkg tiene tomada su base de datos mientras se
ejecuta y cualquier `apt` o `dpkg` falla con «dpkg frontend lock was locked by
another process». Y si web-greeter falta, el paquete **no cambia el greeter**:
apuntar LightDM a un programa que no existe dejaría el equipo sin pantalla de
acceso.

### Qué hace el postinst

Todo es idempotente: instalar dos veces no duplica la cuenta, ni la línea de PAM,
ni ningún fichero.

| Acción | Reversible en |
|---|---|
| Crea la cuenta local `recoverpass`, con el home en `/var/lib/recoverpass`, sin contraseña utilizable, fuera de `sudo` y con shell `/bin/bash` | `purge` |
| Declara `/var/lib` en `snap set system homedirs` | `purge` |
| Escribe `/var/lib/AccountsService/users/recoverpass` con `SystemAccount=true` | `remove` |
| Añade un bloque delimitado a `/etc/pam.d/lightdm`, con copia previa | `remove` |
| Genera `$POLICY_DIR/recoverpass.json` | `remove` |
| Escribe `/etc/lightdm/lightdm.conf.d/99-recoverpass-greeter.conf` | `prerm` |

La cuenta y el ajuste de snapd sólo se deshacen si los creó el paquete: si la
cuenta ya existía, se deja como estaba.

El postinst avisa además de lo que falte: el navegador, `PORTAL_URL` sin cambiar,
web-greeter ausente o un `greeter-session` en `lightdm.conf` que tendría
prioridad sobre el *drop-in*.

---

## 4. Parámetros

Todo vive en `/etc/recoverpass/recoverpass.conf`, que es un fragmento de shell
—sin espacios alrededor del `=`, cadenas entrecomilladas— y un *conffile*: sus
cambios sobreviven a las actualizaciones, con dpkg preguntando antes de tocarlo.

### El portal

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `PORTAL_URL` | `https://sspr.example.local` | Dirección del portal. **Hay que cambiarla**: mientras siga el valor de ejemplo el kiosco no sirve de nada |
| `ALLOWED_DOMAINS` | *(vacío)* | Dominios adicionales que la página necesite (CDN, tipografías, reCAPTCHA, proveedor de identidad), separados por espacios. **No hace falta repetir el dominio de `PORTAL_URL`**: su host se permite entero de forma automática |

### La sesión

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `TIMEOUT` | `900` | Segundos antes de cerrar la sesión sola |
| `KEYBOARD_LAYOUT` | `es` | Distribución de teclado (`setxkbmap`) |

### La barra inferior

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `BAR_HEIGHT` | `44` | Altura orientativa en píxeles: yad ajusta la ventana a su contenido, así que la barra vacía queda en unos 40 px |
| `BAR_TEXT` | *(vacío)* | Mensaje opcional. Si se rellena, la barra **crece** con el texto y el botón deja de estar centrado respecto a la pantalla |
| `BAR_CSS` | `/usr/share/recoverpass/barra.css` | Hoja de estilo del botón: tamaño, tipografía y margen inferior |

### El navegador

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `BROWSER` | `chromium-browser` | `chromium-browser` (el binario en 22.04), `chromium` (24.04 y snap directo) o `google-chrome`. Se busca primero el valor indicado |
| `POLICY_DIR` | `/etc/chromium-browser/policies/managed` | Dónde se escriben las políticas. Para Chrome: `/etc/opt/chrome/policies/managed` |

### El certificado del portal

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `CA_CERT` | *(vacío)* | CA que firma el portal, en PEM. Se importa en el almacén NSS del navegador en cada arranque. **Tiene prioridad**: si se importa bien, la validación NO se desactiva |
| `IGNORE_CERT_ERRORS` | `true` | Salta la validación del certificado. Viene activado para que el kiosco funcione de entrada con un autofirmado, y actúa de red de seguridad si `CA_CERT` falla |

### Los dominios externos

`URLBlocklist: ["*"]` corta también CDN, tipografías, reCAPTCHA y cualquier
proveedor de identidad externo. Abra el portal en un equipo normal con la consola
de red del navegador, anote los dominios que pide y añádalos a
`ALLOWED_DOMAINS`. Si no, la página se verá rota.

### El código llega por correo

Si el usuario no puede autenticarse, tampoco abre su webmail. Hay dos salidas y
ambas son decisiones conscientes:

- **Asumir que lo lee desde el móvil.** Es lo habitual.
- **Añadir el webmail a `ALLOWED_DOMAINS`.** Entonces ese kiosco sin contraseña
  ofrece una pantalla de acceso al correo a cualquiera que pase por delante.

---

## 5. Ficheros

### Los que instala el paquete

| Ruta | Qué es |
|---|---|
| `/usr/bin/recoverpass-session` | La sesión kiosco |
| `/usr/bin/recoverpass-update-policy` | Genera las políticas del navegador desde la configuración |
| `/usr/bin/recoverpass-instalar-greeter` | Instala el web-greeter incluido y activa el greeter |
| `/etc/recoverpass/recoverpass.conf` | Configuración (*conffile*) |
| `/usr/share/recoverpass/chrome-policy.json.in` | Plantilla de las políticas |
| `/usr/share/recoverpass/barra.css` | Aspecto del botón «Salir» |
| `/usr/share/recoverpass/web-greeter-3.5.3-ubuntu.deb` | web-greeter, para no depender de GitHub en cada aula |
| `/usr/share/xsessions/recoverpass.desktop` | La sesión, para LightDM |
| `/usr/share/xgreeters/recoverpass-greeter.desktop` | Lanzador propio del greeter, con el tema y el parche de GPU |
| `/usr/share/web-greeter/themes/recoverpass/` | El tema del greeter |
| `/usr/share/man/man{1,8}/recoverpass-*` | Páginas de manual |

### Los que crea o modifica en el sistema

| Ruta | Qué pasa con ella |
|---|---|
| `/etc/pam.d/lightdm` | Se le añade un bloque delimitado. Al purgar queda **byte a byte** como estaba |
| `/etc/lightdm/lightdm.conf.d/99-recoverpass-greeter.conf` | Selección del greeter |
| `/var/lib/AccountsService/users/recoverpass` | Oculta la cuenta de la lista |
| `$POLICY_DIR/recoverpass.json` | Políticas del navegador |
| `/var/lib/recoverpass/` | Home de la cuenta. Se borra al purgar |
| `/var/backups/recoverpass-greeter/` | Copias de lo que se tocó de otros paquetes |
| `/var/lib/recoverpass-greeter/` | Estado interno: qué creó el paquete y qué debe deshacer |

Nunca se editan `lightdm.conf`, `web-greeter.yml` ni `web-greeter.desktop`.

---

## 6. Funcionalidades

- **Navegador anclado al portal.** `--app`, sin barra de direcciones ni pestañas.
  El resto de la web queda bloqueado por política, no por buena voluntad.
- **Perfil desechable.** Se borra el estado del navegador al entrar y al salir
  —historial, cookies, credenciales y el almacén NSS, incluido `~/snap/chromium`—
  así que nadie hereda la sesión anterior. Tampoco se conserva ninguna
  preferencia.
- **Cierre por inactividad.** `TIMEOUT` cierra la sesión aunque nadie pulse
  Salir, para que un puesto no se quede con el portal abierto.
- **Sin mensajes del navegador.** Se silencian por política y por banderas: la
  burbuja de traducción, «restaurar sesión», novedades, la elección de buscador,
  las notificaciones y el cartel de «indicador de línea de comandos no
  admitido».
- **Certificados propios.** Con `CA_CERT` el portal se valida de verdad; con
  `IGNORE_CERT_ERRORS` se sale del paso mientras no haya CA.
- **Registro.** Todo queda en el journal:

  ```bash
  journalctl -t recoverpass-session
  ```

  Qué navegador se usó, el tamaño de la barra, qué política de certificado se
  aplicó y por qué terminó la sesión. Si el navegador muere nada más abrir, se
  detecta y se explica en pantalla en lugar de volver al greeter en silencio.
- **Desinstalación limpia**, verificada de forma automática, incluido el `diff`
  byte a byte de `/etc/pam.d/lightdm` tras purgar.

---

## 7. Por qué Chromium y no Chrome

Las políticas gestionadas de un navegador son **globales para todos los usuarios
del equipo**. Un `URLBlocklist: ["*"]` en `/etc/opt/chrome/policies/managed/`
bloquearía la navegación de cualquiera que use Chrome en ese puesto.

Como en este parque hay gente que navega con Chrome, el kiosco usa **Chromium**,
que nadie más usa, con sus políticas en `/etc/chromium-browser/policies/managed/`.
Chrome queda intacto.

El snap de Chromium lee esa ruta desde 2020
([LP #1866732](https://bugs.launchpad.net/ubuntu/+source/chromium-browser/+bug/1866732),
*Fix Released*).

Si prefiere Chrome, cambie `BROWSER` y `POLICY_DIR` y vuelva a ejecutar
`recoverpass-update-policy`, sabiendo lo que implica.

### Chromium es un snap, y eso importa

En 22.04 el paquete `chromium-browser` es sólo un **paquete de transición**: el
binario `/usr/bin/chromium-browser` existe aunque el snap no esté instalado, y
entonces el navegador arranca y muere al instante. Compruébelo con
`snap list chromium`.

Y como snap, **su confinamiento sólo admite `$HOME` bajo `/home`**. El home del
kiosco está en `/var/lib/recoverpass`, así que el postinst declara `/var/lib` en
`snap set system homedirs` (requiere snapd 2.61 o posterior). Sin eso, el
navegador no puede crear su perfil y la sesión se cierra sola.

---

## 8. El greeter

El paquete **no toca ningún fichero de configuración de web-greeter**. En vez de
editar `/etc/lightdm/web-greeter.yml` y `/usr/share/xgreeters/web-greeter.desktop`,
instala un lanzador propio:

```ini
# /usr/share/xgreeters/recoverpass-greeter.desktop
Exec=env QTWEBENGINE_CHROMIUM_FLAGS=--disable-gpu web-greeter --theme recoverpass
```

y lo selecciona con un *drop-in*, sin tocar `/etc/lightdm/lightdm.conf`:

```ini
# /etc/lightdm/lightdm.conf.d/99-recoverpass-greeter.conf
[Seat:*]
greeter-session=recoverpass-greeter
```

Ahí van juntos el parche de GPU (el Chromium interno de QtWebEngine se estrella
al intentar usar Vulkan/GBM) y la selección del tema. Desinstalar el paquete
borra esos dos ficheros y el equipo vuelve exactamente al greeter anterior.

> **Ojo con el orden de lectura.** LightDM lee
> `/usr/share/lightdm/lightdm.conf.d/*.conf`, luego
> `/etc/lightdm/lightdm.conf.d/*.conf` y **por último**
> `/etc/lightdm/lightdm.conf`, que gana. Si ahí hay un `greeter-session`, tiene
> prioridad sobre el drop-in. El postinst lo detecta y avisa.

---

## 9. El tema

Está en `/usr/share/web-greeter/themes/recoverpass/`.

- JavaScript clásico en un solo fichero, sin módulos ES y sin compilar.
- Sintaxis conservadora (nada de `?.`, `??` ni `async`), arranque en `try/catch`
  y modo degradado si algo falla: nunca una pantalla muerta.
- Cero recursos externos. Open Sans se sirve desde `fonts/`, que son enlaces
  simbólicos al paquete `fonts-open-sans`.
- Contraste AA verificado, foco de teclado visible, navegación completa con
  teclado, textos en español.

### Desarrollo sin reiniciar LightDM

```bash
cd /usr/share/web-greeter/themes/recoverpass   # o el árbol de fuentes
python3 -m http.server 8765 --bind 127.0.0.1
```

y abra `http://127.0.0.1:8765/mock/index.html` en un Chrome normal. Esa página
lista los escenarios: acceso correcto, contraseña incorrecta, PAM que sí
pregunta, fallo de recuperación, fallo de `start_session`, LightDM mudo y lista
de usuarios oculta. La contraseña de los usuarios simulados es `demo`.

El simulado sólo se activa fuera del greeter: comprueba `window._ready_event` y
`window.qt`, que web-greeter define al crear el documento.

---

## 10. Diagnóstico

Por orden de utilidad cuando algo no va:

```bash
journalctl -t recoverpass-session                   # el propio kiosco
sudo tail -40 /var/log/lightdm/lightdm.log          # ¿autenticó?, ¿lanzó la sesión?
sudo tail -40 /var/log/lightdm/seat0-greeter.log    # el tema: mensajes [recoverpass]
sudo cat /var/lib/recoverpass/.xsession-errors      # la sesión ya arrancada
sudo grep -i recoverpass /var/log/auth.log          # PAM
```

Comprobaciones rápidas:

```bash
command -v web-greeter || echo "falta web-greeter"
cat /etc/lightdm/lightdm.conf.d/99-recoverpass-greeter.conf
grep -Hn '^[[:space:]]*greeter-session' /etc/lightdm/lightdm.conf   # tiene prioridad
grep URLAllowlist /etc/chromium-browser/policies/managed/recoverpass.json
snap list chromium
```

En un Chromium normal, `chrome://policy` muestra si las políticas están cargadas,
con qué valores y si hay conflicto con otro fichero del sistema.

---

## 11. Problemas conocidos y su causa

| Síntoma | Causa | Solución |
|---|---|---|
| La instalación falla con `groupdel: el grupo «recoverpass» no existe` (código 6) | `adduser` no pudo crear el home porque `/home` lo gestiona **autofs** con el mapa en LDAP; al deshacer intentó borrar un grupo que nunca creó, y ese error tapó el real | Resuelto: el home va en `/var/lib/recoverpass` y el grupo se crea aparte |
| Se instala «bien» pero la pantalla de acceso no cambia | **web-greeter no está instalado**; el paquete no toca el greeter a propósito | `sudo recoverpass-instalar-greeter` |
| El greeter no cambia aun con web-greeter instalado | `/etc/lightdm/lightdm.conf` define `greeter-session` y se lee **después** de `lightdm.conf.d` | Comentar esa línea |
| Se pulsa el botón y la sesión no arranca (`Exited with return value 1`) | El navegador muere al instante: **Chromium es un snap y su confinamiento sólo admite `$HOME` bajo `/home`** | Resuelto: el postinst declara `/var/lib` en `snap set system homedirs` |
| «La página está bloqueada, tu organización no permite ver este sitio» | Las políticas no se regeneraron tras editar la configuración | `sudo recoverpass-update-policy`; se permite automáticamente el host completo del portal, no sólo la URL exacta |
| Se ve la barra inferior pero no el botón «Salir» | yad **nunca respeta la altura pedida**: crece con el texto, y fijando la esquina superior el botón caía fuera de la pantalla | Resuelto: la barra se ancla al borde inferior con `-0-0` |
| «No se admite el indicador de línea de comandos que estás utilizando» | Lo provoca `--ignore-certificate-errors` | Resuelto con la política `CommandLineFlagSecurityWarningsEnabled` |
| La sesión se abre y aparece «El kiosco no está configurado» | `PORTAL_URL` sigue con el valor de ejemplo | Editar la configuración y regenerar las políticas |

### Recuperación desde un TTY si el greeter no arranca

Un error en el tema o en el greeter deja el equipo sin pantalla de acceso.
**Antes de desplegar, deje SSH accesible.**

Pulse `Ctrl+Alt+F2` para una consola de texto (eso ya estaba ahí, no lo abre el
kiosco) e inicie sesión con una cuenta normal.

**Volver al greeter de siempre — la vía rápida:**

```bash
sudo rm /etc/lightdm/lightdm.conf.d/99-recoverpass-greeter.conf
sudo systemctl restart lightdm
```

**Forzarlo explícitamente**, si algo más lo hubiera cambiado:

```bash
printf '[Seat:*]\ngreeter-session=lightdm-gtk-greeter\n' | \
    sudo tee /etc/lightdm/lightdm.conf.d/99-rescate.conf
sudo systemctl restart lightdm
```

**Quitarlo todo:**

```bash
sudo apt purge recoverpass-greeter
sudo systemctl restart lightdm
```

**Si sospecha del tema y no del paquete**, arranque el greeter con el tema por
defecto sin desinstalar nada: edite el `Exec=` de
`/usr/share/xgreeters/recoverpass-greeter.desktop` y cambie `--theme recoverpass`
por `--theme gruvbox`. web-greeter cae solo a `gruvbox` si el directorio del tema
no existe.

**Si `/etc/pam.d/lightdm` quedara mal**, hay copia del original en
`/var/backups/recoverpass-greeter/pam.d-lightdm.orig`.

---

## 12. Limitaciones conocidas

**`/etc/pam.d/lightdm` es un conffile de otro paquete.** Es la única edición in
situ que hace el paquete, con marcadores y copia previa. Consecuencia: cuando
`lightdm` se actualice, dpkg detectará el fichero modificado y preguntará qué
hacer. Conserve la versión local (`N`, la opción por defecto) o acepte la nueva y
reinstale este paquete para que vuelva a insertar el bloque. No hay alternativa:
`pam.d` no admite drop-ins, y un perfil de `pam-auth-update` tocaría
`common-auth`, que afecta también a `login`, `sshd` y `sudo`.

**Las políticas son globales para el navegador elegido.** Véase el apartado 7.

**El cambio de terminal virtual sigue disponible.** `Ctrl+Alt+F2` da un acceso de
consola normal; eso ya estaba ahí. En zonas públicas, `DontVTSwitch` en
`ServerFlags` de Xorg — afecta a todas las sesiones del equipo.

**La sesión kiosco no arranca ningún gestor de ventanas, a propósito.** Sin él no
hay alt-tab, ni menú de escritorio, ni forma de mover o cerrar ventanas. Si algún
diálogo modal del navegador se coloca mal, la alternativa es `openbox` con un
`rc.xml` recortado (sin `<keyboard>` ni menú raíz); evite el openbox por defecto,
que trae menú raíz con terminal.

**El aviso de PAM no impide instalar.** Si el postinst no puede editar
`/etc/pam.d/lightdm` con garantías, deja el fichero como estaba y avisa: el botón
aparecerá igualmente, pero pedirá contraseña. Mejor sin botón que sin acceso.

**El estilo de la barra se aplica por `gtk.css`.** yad 0.40 no admite `--css`, así
que el script copia `BAR_CSS` a `~/.config/gtk-3.0/gtk.css` de la cuenta del
kiosco en cada arranque. Sólo afecta a esa sesión, que no ejecuta ninguna otra
aplicación gráfica.

---

## 13. Pruebas

```bash
./tests/probar.sh     # requiere Docker
```

Construye el paquete en un contenedor `ubuntu:24.04`, pasa `lintian` sin errores
ni avisos y comprueba el ciclo completo: instalación con LightDM de verdad, doble
instalación sin duplicar nada, generación y validación del JSON de políticas,
que el home queda en `/var/lib`, `remove`, `purge` y que `/etc/pam.d/lightdm`
queda byte a byte como el original.

Lo que no se puede probar en un contenedor —el greeter en pantalla, el snap de
Chromium, el arranque real de la sesión— está en
[**CHECKLIST-VM.md**](CHECKLIST-VM.md).

---

## 14. Descargo de responsabilidad

Este software se publica **tal cual, sin garantía de ningún tipo**, ni expresa ni
implícita, incluidas las de comerciabilidad e idoneidad para un propósito
concreto. Quien lo despliegue asume la responsabilidad del resultado.

Conviene ser consciente de lo siguiente antes de instalarlo en un equipo real:

**Toca la pantalla de acceso.** Modifica `/etc/pam.d/lightdm` y cambia el
greeter. Un error aquí, o un fallo de JavaScript en el tema, **puede dejar el
equipo sin pantalla de acceso**. Pruébelo antes en una máquina virtual y deje SSH
accesible; el procedimiento de recuperación está en el apartado 11.

**Hay una cuenta que entra sin contraseña, por diseño.** Es el fundamento de todo
esto: cualquiera con acceso físico puede abrir la sesión kiosco y llegar al
portal. La cuenta es local, no tiene contraseña utilizable, no está en `sudo` y
su sesión está confinada al portal, pero **es una concesión de seguridad
deliberada**, no un descuido. Valore si encaja en su entorno, sobre todo en
puestos de acceso público.

**Con `IGNORE_CERT_ERRORS="true"`, que es el valor por defecto, la sesión no
comprueba la identidad del servidor.** Es cómodo para arrancar con un certificado
autofirmado, pero deja la conexión expuesta a suplantación dentro de la red. En
cuanto pueda, rellene `CA_CERT` con la CA del centro: tiene prioridad y
desactiva ese atajo automáticamente.

**Las políticas del navegador son globales** para todos los usuarios del equipo
que usen ese navegador, no sólo para la cuenta del kiosco.

**El confinamiento no es una caja fuerte.** El cambio de terminal virtual con
`Ctrl+Alt+F2` sigue disponible, como en cualquier equipo; el kiosco no lo abre ni
lo cierra. La sesión restringida reduce la superficie, no la elimina.

**Se modifica una configuración global de snapd.** `snap set system homedirs`
afecta a todos los snaps del equipo, no sólo a Chromium. Sólo se revierte al
purgar, y sólo si lo puso este paquete.

**Se redistribuye software de terceros.** El paquete incluye
`web-greeter-3.5.3-ubuntu.deb`, de JezerM, bajo su propia licencia (GPL-3.0).

**Este proyecto no está afiliado ni respaldado** por Canonical, Xubuntu, el
proyecto LightDM, el autor de web-greeter ni Google. Las marcas citadas
pertenecen a sus respectivos titulares.

---

## Licencia y autoría

GPL-3.0-or-later. Texto completo en [`debian/copyright`](debian/copyright).

**Manuel Mora Gordillo.** El tema del greeter está rediseñado por completo
(marcado, hojas de estilo y JavaScript propios), pero parte del tema `dracula` de
[web-greeter-themes](https://github.com/JezerM/web-greeter-themes), de JezerM, y
conserva su estructura de módulos y el planteamiento del objeto simulado de
pruebas. Se mantiene por ello su licencia y su atribución.
