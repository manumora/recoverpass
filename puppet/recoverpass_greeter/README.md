# recoverpass_greeter — módulo de Puppet

Instala el kiosco de recuperación de contraseña en todos los equipos y les
reparte `/etc/recoverpass/recoverpass.conf`.

## Qué hace, por orden

1. Copia el `.deb` a `/var/cache/` y lo instala **con `apt`**, para que resuelva
   sus dependencias (`yad`, `x11-utils`, `x11-xserver-utils`, `libnss3-tools`,
   `fonts-open-sans`).
2. Instala **web-greeter** con `recoverpass-instalar-greeter`. Viene dentro del
   propio paquete: no está en los repositorios de Ubuntu, y un `postinst` no
   puede instalar otro paquete.
3. Reparte `recoverpass.conf` desde `files/`.
4. Al cambiar la configuración, regenera **las políticas del navegador** y **la
   apariencia del greeter**. Ninguna de las dos se rehace sola, y sin eso el
   navegador seguiría bloqueando el portal y la pantalla conservaría el aspecto
   anterior.
5. Reinicia LightDM **sólo si nadie está usando el equipo** (véase abajo).
6. Añade `recoverpass-greeter` a `/etc/pkgsync/mayhave` para que pkgsync no lo
   desinstale.

## Instalación en el servidor de Puppet

```bash
# En el puppetmaster
cp -r recoverpass_greeter /etc/puppet/code/environments/production/modules/
```

Y en el manifiesto de los equipos (`site.pp` o el que corresponda):

```puppet
include recoverpass_greeter
```

## Parámetros

| Parámetro | Por defecto | Para qué |
|---|---|---|
| `version` | `0.0.2` | Versión del `.deb` que hay en `files/` |
| `gestionar_config` | `true` | Repartir `recoverpass.conf`. A `false` si prefiere configurarlos a mano |
| `reiniciar_greeter` | `true` | Reiniciar LightDM al instalar o al cambiar la configuración |
| `instalar_greeter` | `true` | Instalar el web-greeter incluido en el paquete |

```puppet
class { 'recoverpass_greeter':
  version           => '0.0.2',
  reiniciar_greeter => false,     # no tocar la pantalla de acceso
}
```

## El reinicio de LightDM

Reiniciar LightDM **cierra la sesión gráfica del equipo**. En un despliegue
masivo eso significaría echar de su sesión a quien esté dando clase, así que el
módulo sólo reinicia cuando comprueba que **no hay ninguna sesión de usuario
abierta**: se descartan las del propio `lightdm`, `root` y `pkgsync`, y si
aparece alguien más, no se toca nada.

Los equipos donde no se pueda reiniciar aplicarán el cambio en su siguiente
arranque, que en un aula ocurre a diario. Y si no hay systemd o `loginctl`, no
se reinicia: sin saber quién está dentro, se prefiere dejarlo pendiente.

## Actualizar a una versión nueva

```bash
cp recoverpass-greeter_X.Y.Z_all.deb files/
# y cambiar $version en manifests/init.pp (o pasarla como parámetro)
```

El `unless` del `exec` compara la versión ya instalada, así que en los equipos
al día no se hace nada.

## Sobre `recoverpass.conf`

Es un *conffile* de dpkg. El módulo lo reparte y la instalación se hace con
`--force-confold`, de modo que el fichero que manda es el de Puppet: dpkg no
preguntará ni lo sobrescribirá al actualizar el paquete.

Consecuencia: **las opciones nuevas de una versión del paquete no aparecen solas
en los equipos**. Al actualizar, compare `files/recoverpass.conf` con el
`recoverpass.conf.dpkg-dist` que deja dpkg y añada lo que interese.

## Comprobado

Catálogo compilado y aplicado de verdad sobre un contenedor `ubuntu:22.04` con
`lightdm` instalado:

- instala el paquete y web-greeter,
- reparte la configuración,
- regenera las políticas (`URLAllowlist: ["educontrol.santaeulalia"]`) y el tema
  (`nombreCentro: "IES Santa Eulalia"`),
- y la **segunda pasada no cambia nada**: es idempotente.
