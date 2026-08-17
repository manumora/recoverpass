##############################################################################
# -*- coding: utf-8 -*-
# Project:     RecoverPass Kiosk Puppet Task
# Language:    Puppet
# Date:        17-Aug-2026
# Authors:     Manuel Mora Gordillo
# Repository:  https://github.com/manumora/educontrol_deploy
# Copyright:   Manuel Mora Gordillo    <manuel.mora.gordillo @nospam@ gmail.com>
#
# This is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
# This is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
# You should have received a copy of the GNU General Public License
# along with this. If not, see <http://www.gnu.org/licenses/>.
#
##############################################################################
#
# Instala el kiosco de recuperación de contraseña en la pantalla de acceso y
# distribuye su configuración.
#
# Uso:
#   include recoverpass_greeter
#
# Con parámetros:
#   class { 'recoverpass_greeter':
#     version         => '0.0.1',
#     reiniciar_greeter => false,   # no tocar la pantalla de acceso
#   }
#
# ATENCIÓN AL REINICIO DE LIGHTDM: reiniciar el servicio cierra la sesión
# gráfica del equipo. Por eso, aunque «reiniciar_greeter» esté activado, sólo
# se reinicia cuando NO hay ninguna sesión de usuario abierta; si alguien está
# trabajando, los cambios quedan pendientes para el siguiente arranque.
#

class recoverpass_greeter (
  # Versión del paquete que hay en files/
  String  $version           = '0.0.1',

  # Distribuir /etc/recoverpass/recoverpass.conf desde este módulo
  Boolean $gestionar_config  = true,

  # Reiniciar la pantalla de acceso cuando cambie algo (sólo si nadie la usa)
  Boolean $reiniciar_greeter = true,

  # Instalar el web-greeter que trae dentro el propio paquete
  Boolean $instalar_greeter  = true,
) {

  $paquete = "recoverpass-greeter_${version}_all.deb"
  $cache   = "/var/cache/${paquete}"

  # ---- 1. El paquete -------------------------------------------------------

  file { $cache:
    ensure => file,
    source => "puppet:///modules/recoverpass_greeter/${paquete}",
    owner  => 'root',
    group  => 'root',
    mode   => '0644',
  }

  # Se instala con apt y no con «dpkg -i» para que resuelva las dependencias
  # (yad, x11-utils, x11-xserver-utils, libnss3-tools, fonts-open-sans) en un
  # solo paso. El «unless» compara la versión ya instalada, así que en los
  # equipos al día esto no hace nada.
  #
  # DEBIAN_FRONTEND y --force-confold: recoverpass.conf es un conffile, y sin
  # esto dpkg se quedaría esperando una respuesta que nadie va a dar. Se
  # conserva el fichero del equipo, que es justo el que reparte este módulo.
  exec { 'install-recoverpass-greeter':
    command     => "/usr/bin/apt-get install -y -o Dpkg::Options::=--force-confold ${cache} || /usr/bin/apt-get install -f -y",
    unless      => "/usr/bin/dpkg-query -W -f='\${Status} \${Version}\n' recoverpass-greeter 2>/dev/null | /bin/grep -q '^install ok installed ${version}$'",
    environment => ['DEBIAN_FRONTEND=noninteractive'],
    timeout     => 600,
    provider    => shell,
    require     => File[$cache],
  }

  # ---- 2. web-greeter ------------------------------------------------------

  # Viaja dentro del paquete: no está en los repositorios de Ubuntu. No lo
  # instala el postinst porque un postinst no puede instalar otro paquete
  # (dpkg tiene tomada su base de datos mientras se ejecuta).
  #
  # Sin web-greeter, el paquete NO cambia la pantalla de acceso: apuntar
  # LightDM a un programa que no existe dejaría el equipo sin greeter.
  if $instalar_greeter {
    exec { 'install-web-greeter':
      command     => '/usr/bin/recoverpass-instalar-greeter',
      unless      => '/usr/bin/test -x /usr/bin/web-greeter -o -x /opt/web-greeter/web-greeter',
      environment => ['DEBIAN_FRONTEND=noninteractive'],
      timeout     => 600,
      provider    => shell,
      require     => Exec['install-recoverpass-greeter'],
      notify      => Exec['recoverpass-reiniciar-greeter'],
    }
  }

  # ---- 3. La configuración -------------------------------------------------

  if $gestionar_config {
    file { '/etc/recoverpass':
      ensure  => directory,
      owner   => 'root',
      group   => 'root',
      mode    => '0755',
      require => Exec['install-recoverpass-greeter'],
    }

    file { '/etc/recoverpass/recoverpass.conf':
      ensure  => file,
      source  => 'puppet:///modules/recoverpass_greeter/recoverpass.conf',
      owner   => 'root',
      group   => 'root',
      mode    => '0644',
      require => File['/etc/recoverpass'],
      notify  => [
        Exec['recoverpass-update-policy'],
        Exec['recoverpass-update-theme'],
      ],
    }
  }

  # ---- 4. Regenerar lo que se deriva de la configuración -------------------

  # Ni las políticas del navegador ni la apariencia del greeter se regeneran
  # solas al cambiar el fichero: hay que rehacerlas. Si no, el navegador sigue
  # bloqueando el portal y la pantalla conserva el aspecto anterior.
  exec { 'recoverpass-update-policy':
    command     => '/usr/bin/recoverpass-update-policy',
    refreshonly => true,
    provider    => shell,
    require     => Exec['install-recoverpass-greeter'],
  }

  exec { 'recoverpass-update-theme':
    command     => '/usr/bin/recoverpass-update-theme',
    refreshonly => true,
    provider    => shell,
    require     => Exec['install-recoverpass-greeter'],
    notify      => Exec['recoverpass-reiniciar-greeter'],
  }

  # ---- 5. Reinicio prudente de la pantalla de acceso -----------------------

  # Reiniciar lightdm cierra la sesión gráfica del equipo. En un despliegue
  # masivo eso significaría echar de su sesión a quien estuviera dando clase,
  # así que sólo se reinicia si el único que tiene sesión es el propio greeter.
  #
  # «loginctl list-sessions» lista también la sesión del usuario lightdm; se
  # descarta, junto con las de consola de root. Si aparece alguien más, no se
  # toca nada y el cambio se aplicará en el siguiente arranque del equipo.
  # Se exige systemd operativo y loginctl: si no se puede saber quién está
  # dentro, no se reinicia. Más vale un cambio pendiente que echar a alguien de
  # su sesión, y así el módulo tampoco falla donde no hay systemd (contenedores).
  $sin_usuarios = '/usr/bin/test -d /run/systemd/system && /usr/bin/test -x /usr/bin/loginctl && /usr/bin/test -z "$(/usr/bin/loginctl list-sessions --no-legend | /usr/bin/awk \'{print $3}\' | /bin/grep -v -e \'^lightdm$\' -e \'^root$\' -e \'^pkgsync$\')"'

  exec { 'recoverpass-reiniciar-greeter':
    command     => '/usr/bin/systemctl restart lightdm',
    onlyif      => $sin_usuarios,
    refreshonly => true,
    provider    => shell,
    require     => Exec['install-recoverpass-greeter'],
  }

  if $reiniciar_greeter {
    Exec['install-recoverpass-greeter'] ~> Exec['recoverpass-reiniciar-greeter']
  }

  # ---- 6. pkgsync ----------------------------------------------------------

  # Para que pkgsync no lo desinstale en su siguiente pasada.
  exec { 'insertar_recoverpass_greeter':
    command => '/usr/bin/echo "recoverpass-greeter" >> /etc/pkgsync/mayhave',
    onlyif  => '/usr/bin/test -f /etc/pkgsync/mayhave',
    unless  => '/usr/bin/grep -Fxq "recoverpass-greeter" /etc/pkgsync/mayhave',
  }
}
