# recoverpass

Botón **«Recuperar contraseña»** en la pantalla de acceso de Xubuntu, para
usuarios que no pueden entrar en su equipo.

---

## El problema

En un parque de equipos Xubuntu con usuarios autenticados contra LDAP, una web
interna permite cambiar la contraseña conociendo la anterior, o recuperarla mediante 
un código enviado por correo. El problema es circular: **quien no puede autenticarse 
tampoco puede abrir un navegador para usar la web y cambiar/recuperar su contraseña**.

## La solución

Se sustituye el greeter por [web-greeter](https://github.com/JezerM/web-greeter)
con un `theme` propio que añade un botón secundario junto al formulario de acceso.
Ese botón autentica una cuenta local restringida, `recoverpass`, que entra sin
contraseña gracias a una línea de `pam_succeed_if` acotada a LightDM, y arranca
una sesión en modo `kiosk`: un navegador anclado a la web de cambio de contraseña, 
sin barra de direcciones, sin pestañas y sin gestor de ventanas, más una barra 
inferior con un botón «Salir» que devuelve a la pantalla de acceso.

Todo ello va empaquetado en un `.deb` que deja un equipo limpio completamente
configurado y que se puede desinstalar sin dejar rastro.

## Capturas

![Pantalla de acceso con el botón de recuperación](img/main.png)

![Pantalla de gestión de contraseña](img/change-password.png)

## Qué hay en este repositorio

| Ruta | Qué es |
|---|---|
| `recoverpass-greeter/` | **El proyecto.** Fuente empaquetable con `dpkg-buildpackage`, tema del greeter, mock de desarrollo y batería de pruebas |
| `recoverpass-greeter/README.md` | Documentación completa: instalación, configuración, recuperación desde un TTY y limitaciones conocidas |
| `recoverpass-greeter/CHECKLIST-VM.md` | Verificación manual en máquina virtual de lo que no se puede automatizar |
| `puppet/recoverpass_greeter/` | Módulo de Puppet para el despliegue masivo: instala el paquete, web-greeter y reparte `recoverpass.conf` |
| `install_puppet` | Script de una línea (`curl \| bash`) que instala el módulo de Puppet en el servidor |
| `nueva-version.sh` | Sube la versión del paquete, lo compila y actualiza el `.deb` y el zip de Puppet en un solo paso |
| `recoverpass_greeter_puppet.zip` | El módulo de Puppet empaquetado, lo que descarga `install_puppet` |

## Construcción y uso

En la raíz del repositorio hay un paquete ya construido, así que se puede
instalar directamente:

```bash
sudo apt install ./recoverpass-greeter_0.0.1_all.deb
sudo recoverpass-instalar-greeter    # instala el web-greeter que trae el paquete
```

Para construirlo desde las fuentes:

```bash
cd recoverpass-greeter
dpkg-buildpackage -us -uc -b
sudo apt install ../recoverpass-greeter_0.0.1_all.deb
```

Después hay que poner la URL real del portal web en
`/etc/recoverpass/recoverpass.conf` y ejecutar `sudo recoverpass-update-policy`,
que no se ejecuta solo. Todos los parámetros, los ficheros que toca, el
diagnóstico y los problemas conocidos están en
[`recoverpass-greeter/README.md`](recoverpass-greeter/README.md).

Para probar el paquete completo —construcción, `lintian`, instalación, doble
instalación, desinstalación y purgado— en un contenedor Ubuntu 24.04:

```bash
./recoverpass-greeter/tests/probar.sh     # requiere Docker
```

## Instalación mediante Puppet

Para desplegar el kiosco en todo el parque de equipos, en vez de instalarlo uno
a uno, hay un módulo de Puppet que instala el paquete, web-greeter y reparte
`recoverpass.conf` a todos los nodos que lo incluyan.

### Instalación del módulo Puppet

Para instalar el módulo en tu servidor Puppet, ejecuta el siguiente comando
como root:

```bash
curl -fsSL https://raw.githubusercontent.com/manumora/recoverpass/refs/heads/main/install_puppet | bash
```

Este script realizará automáticamente las siguientes acciones:

1. Descargará el módulo `recoverpass_greeter` desde el repositorio.
2. Lo descomprimirá en `/etc/puppetlabs/code/environments/production/modules`.
3. Te mostrará las instrucciones para incluir el módulo en tus nodos.

Si ya existe una configuración previa (`files/recoverpass.conf` personalizado
en una instalación anterior), el script la respalda antes de descomprimir y la
restaura después, así que se puede volver a ejecutar para actualizar el módulo
a una versión nueva sin perder `PORTAL_URL`, los colores ni el nombre del
centro que ya se hubieran configurado.

### Pasos posteriores

Después de ejecutar el script de instalación:

1. **Configurar el kiosco**: edita
   `/etc/puppetlabs/code/environments/production/modules/recoverpass_greeter/files/recoverpass.conf`
   con la URL real de la web de cambio de contraseña (`PORTAL_URL`) y, si se
   quiere, los colores, la imagen de fondo o el nombre del centro
   (`CENTER_NAME`). Es el fichero que se reparte a todos los equipos; todos
   los parámetros están documentados dentro del propio fichero y en
   [`recoverpass-greeter/README.md`](recoverpass-greeter/README.md).

2. **Editar la configuración de nodos**: abre el archivo de configuración de
   tus nodos (por ejemplo,
   `/etc/puppetlabs/code/environments/production/modules/especifica_xubuntu2204/manifests/init.pp`).

3. **Añadir el módulo**: incluye `include recoverpass_greeter` en la
   configuración de los nodos donde quieras desplegar el kiosco.

4. **Reinicia el servidor Puppet**:
   ```bash
   systemctl restart puppetserver
   ```

5. **Aplica los cambios en los clientes Puppet**:
   ```bash
   puppet agent -t
   ```

   Ese primer `puppet agent -t` reinicia la pantalla de acceso (LightDM) sólo
   si el equipo no tiene ninguna sesión de usuario abierta; si hay alguien
   trabajando, el cambio queda pendiente para el siguiente arranque del
   equipo. Los detalles del módulo —parámetros, qué hace cada paso, cómo
   actualizar a una versión nueva— están en
   [`puppet/recoverpass_greeter/README.md`](puppet/recoverpass_greeter/README.md).

## Requisitos

- Ubuntu / Xubuntu **22.04 o 24.04** con LightDM. El parque de destino es 22.04.
- **web-greeter 3.5.3**, que no está en los repositorios de Ubuntu y por eso
  **viaja dentro del paquete**: se instala con `sudo recoverpass-instalar-greeter`.
- **Chromium**, que se distribuye como snap. Se usa Chromium y no Google Chrome a
  propósito: las políticas restrictivas del kiosco son globales para el navegador
  al que se apliquen, y así no afectan a quien navegue con Chrome en el mismo
  equipo.
- `fonts-open-sans`, que está en el componente *universe*, y `libnss3-tools` para
  importar la CA del portal.
- **snapd 2.61 o posterior**: el home del kiosco está en `/var/lib` y los snaps
  sólo admiten `$HOME` bajo `/home` salvo que se declare lo contrario, cosa de la
  que se encarga el paquete.

## Estado

El paquete pasa `lintian` sin errores ni avisos, y el ciclo de instalación,
reinstalación, desinstalación y purgado está verificado de forma automática,
incluyendo que `/etc/pam.d/lightdm` queda byte a byte idéntico al original
después de purgar. El tema se ha probado contra un objeto `lightdm` simulado,
sin errores de consola.

Está desplegado y funcionando en equipos reales con Ubuntu 22.04: greeter, botón,
sesión kiosco, portal y botón «Salir». El resto de la verificación manual —lo que
depende de una pantalla y de un LightDM en marcha— está detallada, punto por
punto, en [`recoverpass-greeter/CHECKLIST-VM.md`](recoverpass-greeter/CHECKLIST-VM.md).

## Autoría

**Manuel Mora Gordillo**.

El tema del greeter está rediseñado por completo (marcado, hojas de estilo y
JavaScript propios), pero parte del tema `dracula` de
[web-greeter-themes](https://github.com/JezerM/web-greeter-themes), de JezerM, y
conserva su estructura de módulos y el planteamiento del objeto simulado de
pruebas. Se mantiene por ello su licencia y su atribución.

## Licencia

GPL-3.0-or-later. El texto completo está en
[`recoverpass-greeter/debian/copyright`](recoverpass-greeter/debian/copyright).

El paquete redistribuye `web-greeter-3.5.3-ubuntu.deb`, de JezerM, que conserva
su propia licencia (GPL-3.0).

---

## Descargo de responsabilidad

Este software se publica **tal cual, sin garantía de ningún tipo**, ni expresa ni
implícita, incluidas las de comerciabilidad e idoneidad para un propósito
concreto. Quien lo despliegue asume la responsabilidad del resultado.

Conviene ser consciente de lo siguiente antes de instalarlo en un equipo real:

**Toca la pantalla de acceso.** El paquete modifica `/etc/pam.d/lightdm` y
cambia el greeter del sistema. Un error aquí, o un fallo de JavaScript en el
tema, **puede dejar el equipo sin pantalla de acceso**. Pruébelo antes en una
máquina virtual y deje SSH accesible. El procedimiento de recuperación desde un
terminal de texto está documentado en el README del paquete.

**Hay una cuenta que entra sin contraseña, por diseño.** Es el fundamento de
todo esto: cualquiera con acceso físico al equipo puede abrir la sesión kiosco y
llegar al portal de autoservicio. La cuenta es local, no tiene contraseña
utilizable, no está en `sudo` y su sesión está confinada al portal, pero **es una
concesión de seguridad deliberada**, no un descuido. Valore si encaja en su
entorno, especialmente en puestos de acceso público.

**Las políticas del navegador son globales.** Se aplican a todos los usuarios del
equipo que usen ese navegador, no sólo a la cuenta del kiosco.

**Por defecto no se valida el certificado del portal.** `IGNORE_CERT_ERRORS`
viene activado para que el kiosco funcione con un certificado autofirmado. Es
cómodo, pero deja la conexión expuesta a suplantación dentro de la red: en cuanto
pueda, declare la CA del centro en `CA_CERT`.

**El confinamiento no es una caja fuerte.** El cambio de terminal virtual con
`Ctrl+Alt+F2` sigue disponible, como en cualquier equipo; el kiosco no lo abre ni
lo cierra. La sesión restringida reduce la superficie, no la elimina.

**Este proyecto no está afiliado ni respaldado** por Canonical, Xubuntu, el
proyecto LightDM, el autor de web-greeter ni Google. Las marcas citadas
pertenecen a sus respectivos titulares.
