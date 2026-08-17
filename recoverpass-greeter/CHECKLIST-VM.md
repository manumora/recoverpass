# Checklist de verificación en VM

Lo que sigue es **todo lo que no se ha podido comprobar en el contenedor**: el
greeter en pantalla, el snap de Chromium, PAM de verdad y el arranque real de la
sesión. Lo que sí está comprobado automáticamente (construcción, `lintian`,
instalación, doble instalación, `remove`, `purge` y el diff byte a byte de
`/etc/pam.d/lightdm`) se ejecuta con `./tests/probar.sh` y no se repite aquí.

**Antes de empezar:** VM de Xubuntu 24.04 con instantánea, y SSH accesible.
Si el greeter no arranca, la salida está en el apartado 6 del README.

---

## 1. Preparación

- [ ] `ssh` a la VM funciona desde otro equipo.
- [ ] Instantánea de la VM tomada.
- [ ] `apt policy fonts-open-sans` muestra un candidato (universe habilitado).
- [ ] `sudo apt install ./web-greeter-3.5.3-ubuntu.deb -y` termina sin errores.
- [ ] `sudo snap install chromium` termina sin errores.
- [ ] `web-greeter --version` responde `3.5.3`.
- [ ] Anotado qué greeter había antes: `grep -r greeter-session /etc/lightdm/ /usr/share/lightdm/`

## 2. Instalación

- [ ] `sudo apt install ./recoverpass-greeter_0.0.2_all.deb` termina sin errores.
- [ ] El postinst avisa de que `PORTAL_URL` sigue siendo el valor de ejemplo.
- [ ] `getent passwd recoverpass` existe, con shell `/bin/bash`.
- [ ] `sudo head -3 /etc/pam.d/lightdm` muestra el bloque `# BEGIN recoverpass-greeter`
      con la línea `pam_succeed_if` **antes** de `@include common-auth`.
- [ ] `cat /etc/lightdm/lightdm.conf.d/99-recoverpass-greeter.conf` existe.
- [ ] `grep -c greeter-session /etc/lightdm/lightdm.conf` da `0`, o el postinst
      ha avisado de que ese fichero tiene prioridad.

Configuración real:

- [ ] `PORTAL_URL` puesto a la URL del portal en `/etc/recoverpass/recoverpass.conf`.
- [ ] `ALLOWED_DOMAINS` con los dominios que carga el portal (sacados de la
      consola de red en un equipo normal).
- [ ] `sudo recoverpass-update-policy` sin errores.
- [ ] `sudo systemctl restart lightdm`.

## 3. El greeter en pantalla

- [ ] Aparece el tema nuevo, no el gtk-greeter ni el gruvbox.
- [ ] **La tipografía es Open Sans**, no una sustituta. (Es el punto con más
      probabilidad de fallar: si el `@font-face` relativo no cargara, se ve la
      fuente por defecto. Compruébelo con `web-greeter --debug` → pestaña Network,
      o comparando con una captura.)
- [ ] Se ve el reloj con la hora y la fecha correctas, en español.
- [ ] Se ve el nombre del equipo.
- [ ] La lista de usuarios muestra los usuarios LDAP y **no** muestra
      `recoverpass`.
- [ ] El selector de sesión **no** ofrece «Recuperar contraseña».
- [ ] Aparecen los botones de apagar y reiniciar.
- [ ] En un equipo con dos pantallas, la secundaria muestra sólo el reloj.

## 4. Acceso normal

- [ ] Un usuario LDAP entra con su contraseña correcta.
- [ ] Con la contraseña equivocada aparece «Usuario o contraseña incorrectos.»,
      el formulario se desbloquea y **se puede reintentar sin reiniciar nada**.
- [ ] Se puede recorrer toda la pantalla sólo con el tabulador y el foco se ve
      siempre.
- [ ] El selector de sesión cambia la sesión que arranca.

## 5. El botón de recuperación

- [ ] Está claramente separado del acceso principal.
- [ ] Al pulsarlo **no pide contraseña** y arranca la sesión kiosco.
- [ ] Se abre el navegador directamente en el portal, sin barra de direcciones
      ni pestañas.
- [ ] La barra inferior con «Salir» queda **por encima** del navegador.
- [ ] El portal se ve completo: sin recursos rotos por el `URLBlocklist`.
- [ ] Al pulsar «Salir» se cierra la sesión y se vuelve al greeter.
- [ ] Volver a pulsar el botón funciona igual la segunda vez.
- [ ] Pasado `TIMEOUT` (baje el valor para probar) la sesión se cierra sola.

## 6. Confinamiento del navegador — el punto crítico

Este apartado es el que decide si el diseño con Chromium es válido.

- [ ] `/etc/chromium-browser/policies/managed/recoverpass.json` existe.
- [ ] **Las políticas se aplican de verdad**: en la sesión kiosco no hay forma de
      abrir `chrome://policy`, así que compruébelo desde una sesión normal
      abriendo Chromium y visitando `chrome://policy` — deben aparecer
      `URLBlocklist`, `URLAllowlist` y `AllowFileSelectionDialogs` como
      *Mandatory / Platform*.
      **Si no aparecen, el snap no está leyendo la ruta y hay que replantear el
      confinamiento: avise antes de desplegar.**
- [ ] Una URL distinta del portal queda bloqueada.
- [ ] `Ctrl+N` no abre ventana nueva.
- [ ] `Ctrl+O` no abre el diálogo de ficheros (`AllowFileSelectionDialogs`).
- [ ] `F12` y `Ctrl+Shift+I` no abren las herramientas de desarrollo.
- [ ] `Ctrl+P` no imprime.
- [ ] `F11` no saca al usuario del modo aplicación.
- [ ] Descargar un fichero desde el portal queda bloqueado.
- [ ] **Google Chrome sigue navegando con normalidad** para un usuario normal en
      el mismo equipo: sus políticas no se han tocado.

## 7. Estado entre sesiones

- [ ] Tras salir y volver a entrar, el navegador no recuerda nada de la sesión
      anterior (ni historial, ni sesión iniciada en el portal, ni cookies).
- [ ] `sudo ls /var/lib/recoverpass` no acumula basura entre usos.

## 8. Robustez del tema

- [ ] Con el equipo **sin red**, el greeter arranca igual de rápido: ningún
      recurso externo que se quede esperando.
- [ ] Provoque un fallo a propósito — por ejemplo
      `sudo sh -c 'echo "esto no es javascript" >> /usr/share/web-greeter/themes/recoverpass/js/greeter.js'`
      y reinicie LightDM: debe aparecer el mensaje del modo degradado y **el
      acceso con usuario y contraseña debe seguir funcionando**. Restaure después
      con `sudo apt install --reinstall ./recoverpass-greeter_0.0.2_all.deb`.
- [ ] Con el portal apagado, el botón de recuperación entra igual y el navegador
      muestra su página de error: la sesión no se queda colgada.

## 9. Desinstalación en la VM

- [ ] `sudo apt remove recoverpass-greeter` y reiniciar LightDM: vuelve el greeter
      anterior y el acceso normal funciona.
- [ ] `sudo apt purge recoverpass-greeter`: desaparece la cuenta `recoverpass`.
- [ ] `sudo diff /var/backups/recoverpass-greeter/pam.d-lightdm.orig /etc/pam.d/lightdm`
      antes del purgado — o compruebe tras purgar que el fichero no menciona
      `recoverpass`.

## 10. Convivencia con actualizaciones

- [ ] `sudo apt install --reinstall lightdm`: dpkg pregunta por el conffile
      `/etc/pam.d/lightdm` modificado. Conserve la versión local (`N`) y
      compruebe que el botón sigue funcionando.
- [ ] Instalar el paquete dos veces seguidas no duplica la línea de PAM
      (ya comprobado en contenedor, pero conviene verlo también aquí).

---

## Anotaciones

| Punto | Resultado | Notas |
|---|---|---|
| 3 — tipografía Open Sans | | |
| 5 — barra «Salir» por encima | | |
| 6 — políticas del snap aplicadas | | |
| 8 — modo degradado | | |
