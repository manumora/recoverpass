/*
 * Tema «recoverpass» para web-greeter — lógica.
 *
 * Un fallo de JavaScript aquí deja el equipo sin pantalla de acceso, así que:
 *
 *   - Es un script clásico, sin módulos ES y sin compilar. Nada de import,
 *     nada de type="module": el greeter carga el tema por un esquema propio
 *     (web-greeter://) y no conviene depender de cómo resuelve los módulos.
 *   - Sintaxis conservadora, sin encadenamiento opcional (?.), sin ?? y sin
 *     async/await, para no depender de la versión de Chromium que lleve
 *     empotrada QtWebEngine.
 *   - Todo el arranque va en try/catch, y cada manejador de evento también.
 *     Si algo revienta, se avisa por pantalla y se deja el acceso normal en
 *     el mejor estado posible en vez de una pantalla muerta.
 *
 * API verificada contra web-greeter 3.5.3 (el puente es QWebChannel):
 *   - las señales son objetos con .connect():  lightdm.show_prompt.connect(cb)
 *   - el tema no debe inicializarse hasta el evento «GreeterReady»
 *   - start_session(clave, callback) devuelve el resultado por el callback
 * Si apareciera una versión con el estilo antiguo de globales
 * (window.show_prompt = fn), conectarSenal() cae a ese estilo por su cuenta.
 */
(function () {
  "use strict";

  /* Tipos de prompt de LightDM: 0 = pregunta visible, 1 = secreto. */
  var PROMPT_USUARIO = 0;
  var PROMPT_SECRETO = 1;

  var MODO_INACTIVO = "inactivo";
  var MODO_ACCESO = "acceso";
  var MODO_RECUPERACION = "recuperacion";
  var MODO_CAMBIO_CLAVE = "cambio_clave";

  var USUARIO_RECUPERACION = "recoverpass";
  var SESION_RECUPERACION = "recoverpass";
  var OTRO_USUARIO = "__otro__";

  /* Margen para que llegue el anuncio de mando de otra ventana: su
     broadcast lo entrega web-greeter con unas décimas de retraso
     (GreeterComm.broadcast, 60 ms). Ver «una sola ventana al mando». */
  var ESPERA_ANUNCIO_MANDO = 500;

  /* Ningún paso puede quedarse esperando para siempre: si LightDM no
     responde, se vuelve al estado inicial con un mensaje. */
  var ESPERA_AUTENTICACION = 20000;
  var ESPERA_SESION = 20000;

  var d = {};
  var modo = MODO_INACTIVO;
  var usuario = "";
  var clave = "";
  var vigilante = null;
  var relojId = null;
  var arrancado = false;
  var senalesConectadas = false;
  var bloqueado = false;
  /* Mando de la conversación con LightDM; ver «una sola ventana al mando». */
  var otroDueno = false;
  var heReclamado = false;

  /* Cambio de contraseña obligatorio (pwdReset + pwdMustChange en el
     directorio): PAM lo pide dentro de la MISMA autenticación, como más
     preguntas «secretas» después de la contraseña de acceso. No hay forma
     fiable de distinguirlas por el orden: comprobado en un equipo real que
     tras «Password: » (acceso) llega «Current Password: » — una repregunta
     por la contraseña ACTUAL, no la nueva — y sólo después «New Password: »
     y la confirmación. Por eso cada pregunta se clasifica por su propio
     texto (en inglés, sin traducir, son los literales de pam_ldap/pam_unix),
     no por la posición. Ver alPrompt() / manejarPreguntaCambioClave().
       pasoCambio:
         null      no hay formulario mostrado esperando envío
         "nueva"   se ha mostrado el formulario; a la espera de que el
                   usuario escriba y envíe
         "repite"  ya se respondió con la contraseña nueva; la próxima
                   pregunta de confirmación se responde sola */
  var pasoCambio = null;
  var huboPreguntaClaveAcceso = false;
  var nuevaClave = "";
  var repiteClave = "";
  /* La pregunta de confirmación puede llegar antes de que el usuario haya
     enviado el formulario (PAM entrega «New Password» y «Retype» seguidas,
     sin esperar respuesta entre medias). Si pasa, se recuerda aquí para
     responderla en cuanto se tenga repiteClave, sin esperar una señal nueva
     que no va a llegar. */
  var repitePendiente = false;

  /* Último aviso que PAM ha mandado por show_message durante el cambio de
     contraseña (p. ej. «Password change failed: Server message: Password is
     in history of old passwords»). Comprobado en un equipo real que, si el
     directorio rechaza la nueva contraseña por reutilizada, PAM no vuelve a
     preguntar como con una contraseña débil: da ese aviso y cierra la
     autenticación entera (código 12, «Authentication token is no longer
     valid»). Si no se guardara aquí, alCompletar() lo taparía con un
     mensaje genérico sin decir el motivo real. Ver alMensajePam(). */
  var ultimoMensajePam = "";

  /* Motivo por el que el DIRECTORIO ha rechazado el acceso, ya traducido y
     con su coletilla de ayuda, cuando PAM lo ha explicado por show_message:
     cuenta bloqueada, desactivada, expirada o contraseña caducada. Va aparte
     de ultimoMensajePam porque no todo aviso de PAM sirve como motivo de un
     rechazo: los informativos («la contraseña caducará en 7 días») llegan en
     accesos que siguen adelante y repetirlos al final sería mentir. Lo lee
     sólo la rama de acceso de alCompletar(); si PAM no manda nada se queda
     vacío y sale el genérico, que es el caso de una contraseña mal escrita. */
  var ultimoMotivoRechazo = "";

  /* Reglas de complejidad de la contraseña nueva: las mismas cuatro que ya
     exige la web de EduControl (PasswordManagementView.tsx) — ppolicy en
     este directorio sólo impone longitud mínima (pwdMinLength), no hay
     ningún módulo de calidad que compruebe mayúsculas/minúsculas/números/
     símbolos, así que esto es una comprobación del propio tema, coherente
     con el resto de la aplicación, no algo que exija LDAP. */
  var REQUISITOS_COMPLEJIDAD = [
    { id: "mayuscula", prueba: /[A-Z]/ },
    { id: "minuscula", prueba: /[a-z]/ },
    { id: "numero", prueba: /[0-9]/ },
    { id: "simbolo", prueba: /[^A-Za-z0-9]/ }
  ];

  /* Longitud mínima realmente en uso: empieza en la de config.js
     (longitudMinimaClave, la de reserva) y se sustituye por la que devuelva
     EduControl si cargarRequisitosClaveRemotos() consigue contactar a
     tiempo. Ver esa función. */
  var longitudMinimaClave = 8;

  /* ---------------------------------------------------------------- útiles */

  function ldm() {
    return window.lightdm;
  }

  function nodo(id) {
    return document.getElementById(id);
  }

  function registrar(texto, error) {
    try {
      if (window.console && console.error) {
        console.error("[recoverpass] " + texto, error === undefined ? "" : error);
      }
    } catch (e) {
      /* si ni siquiera hay consola, no hay nada que hacer */
    }
  }

  /* Como registrar(), pero con console.warn en vez de console.error: la
     WebPage de web-greeter (browser/error_prompt.py) abre un diálogo
     emergente encima de la pantalla de acceso ante CUALQUIER console.error,
     también los ya controlados como éste. Para un fallo esperado y con
     reserva (sin red, EduControl caído...) eso asusta sin motivo — se deja
     el diálogo para errores de verdad inesperados. */
  function avisar(texto, error) {
    try {
      if (window.console && console.warn) {
        console.warn("[recoverpass] " + texto, error === undefined ? "" : error);
      }
    } catch (e) {
      /* si ni siquiera hay consola, no hay nada que hacer */
    }
  }

  /* ------------------------------------------------------------ apariencia */

  /* Configuración generada por «recoverpass-update-theme» desde
     /etc/recoverpass/recoverpass.conf. Si no está (tema abierto a mano, o
     alguien borró config.js), se usan estos valores y la pantalla funciona
     igual: la apariencia nunca puede impedir el acceso. */
  var CONFIG_POR_DEFECTO = {
    imagenFondo: "",
    colorPrimario: "#1565C0",
    colorSecundario: "#FFFFFF",
    mostrarSuspender: false,
    mostrarReiniciar: true,
    mostrarApagar: true,
    mostrarSesion: true,
    nombreCentro: "",
    zonaHoraria: "Europe/Madrid",
    /* Coletilla de los avisos de cuenta bloqueada, desactivada o expirada
       (LOCKED_ACCOUNT_HELP en recoverpass.conf). Con el tema abierto a mano,
       sin config.js, se usa ésta. */
    ayudaCuentaBloqueada: "Avise al departamento de sistemas.",
    /* Requisitos de la contraseña nueva en el cambio obligatorio. Con la URL
       vacía no se intenta ninguna petición: se usa longitudMinimaClave tal
       cual. Ver cargarRequisitosClaveRemotos(). */
    urlRequisitosClave: "",
    longitudMinimaClave: 8
  };

  function cfg() {
    var c = window.RECOVERPASS_CONFIG;
    if (!c || typeof c !== "object") {
      return CONFIG_POR_DEFECTO;
    }
    var salida = {};
    for (var clave in CONFIG_POR_DEFECTO) {
      if (Object.prototype.hasOwnProperty.call(CONFIG_POR_DEFECTO, clave)) {
        salida[clave] =
          c[clave] === undefined || c[clave] === null ? CONFIG_POR_DEFECTO[clave] : c[clave];
      }
    }
    return salida;
  }

  /* La paleta la deriva y aplica js/apariencia.js, que index.html y
     secondary.html cargan en el <head> para que el primer pintado ya salga
     con los colores configurados. Aquí se vuelve a llamar al arrancar: es
     idempotente y cubre el caso de que config.js hubiera llegado más tarde. */
  function aplicarApariencia() {
    if (window.RECOVERPASS_APARIENCIA && window.RECOVERPASS_APARIENCIA.aplicar) {
      window.RECOVERPASS_APARIENCIA.aplicar();
      return;
    }
    avisar("no está js/apariencia.js: se queda la paleta de reserva de style.css");
  }

  /* Envuelve un manejador para que una excepción no deje la pantalla colgada. */
  function seguro(fn, nombre) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (error) {
        registrar("fallo en " + nombre, error);
        volverAlInicio("Se ha producido un error inesperado. Inténtelo de nuevo.", "error");
      }
    };
  }

  function mostrarMensaje(texto, clase) {
    if (!d.mensaje) {
      return;
    }
    d.mensaje.textContent = texto || "";
    d.mensaje.className = clase || "";
  }

  function mostrarCubierta(texto) {
    if (!d.cubierta) {
      return;
    }
    if (d.cubiertaTexto) {
      d.cubiertaTexto.textContent = texto || "";
    }
    d.cubierta.hidden = false;
    try {
      d.cubierta.focus();
    } catch (e) {
      /* el foco es un detalle, no un motivo para abortar */
    }
  }

  function ocultarCubierta() {
    if (d.cubierta) {
      d.cubierta.hidden = true;
    }
  }

  function bloquear(si) {
    bloqueado = !!si;
    var controles = [
      d.listaUsuarios,
      d.entradaUsuario,
      d.entradaClave,
      d.verClave,
      d.entrar,
      d.recuperar,
      d.entradaNuevaClave,
      d.verNuevaClave,
      d.entradaRepiteClave,
      d.confirmarCambioClave,
      d.cancelarCambioClave
    ];
    for (var i = 0; i < controles.length; i++) {
      if (controles[i]) {
        controles[i].disabled = !!si;
      }
    }
    /* Después del bucle: los dos botones primarios no dependen sólo del
       bloqueo, sino de que sus campos estén rellenos y sean válidos. */
    actualizarEstadoEntrar();
    actualizarRequisitosClave();
  }

  /* «Iniciar sesión» sólo se habilita con los dos campos rellenos.
     Con la contraseña vacía se abría una autenticación que PAM rechazaba de
     inmediato y la conversación quedaba a medias: llegaba un show_prompt
     («password») cuando el tema ya había vuelto al estado inicial y se
     registraba «prompt inesperado estando parados». Deshabilitar el botón
     desactiva también el Enter del formulario: el navegador no ejecuta la
     activación de un botón por defecto deshabilitado, así que no hay envío
     implícito. */
  function actualizarEstadoEntrar() {
    if (!d.entrar) {
      return;
    }
    var hayClave = !!(d.entradaClave && d.entradaClave.value);
    d.entrar.disabled = bloqueado || !obtenerUsuario() || !hayClave;
  }

  function armarVigilante(ms, texto) {
    cancelarVigilante();
    vigilante = window.setTimeout(function () {
      vigilante = null;
      registrar("se agotó la espera: " + texto);
      volverAlInicio(texto, "error");
    }, ms);
  }

  function cancelarVigilante() {
    if (vigilante !== null) {
      window.clearTimeout(vigilante);
      vigilante = null;
    }
  }

  function cancelarAutenticacionPendiente() {
    if (otroDueno) {
      /* La conversación es de otra ventana y cortarla la dejaría sin poder
         entrar. Cuando el usuario empieza aquí un acceso, iniciarAcceso()
         reclama el mando antes de llegar a esta llamada, así que sí puede
         cortar lo que hubiera pendiente. Ver «una sola ventana al mando». */
      return;
    }
    try {
      var g = ldm();
      if (g && g.in_authentication) {
        g.cancel_authentication();
      }
    } catch (error) {
      registrar("no se pudo cancelar la autenticación en curso", error);
    }
  }

  /* Estado inicial: es el único camino de vuelta desde cualquier fallo. */
  function volverAlInicio(texto, clase) {
    reiniciarEstado(true);
    mostrarMensaje(texto, clase);
    enfocarEntrada();
  }

  /* El estado inicial sin tocar la pantalla. «cortar» dice si además hay que
     cortar la conversación con LightDM: sí siempre que el flujo fuera
     nuestro; no cuando el mando ha pasado a otra ventana, porque entonces la
     conversación es de ella y cancelarla la dejaría sin poder entrar (ver
     cederElMando). */
  function reiniciarEstado(cortar) {
    cancelarVigilante();
    /* El modo se marca antes de cancelar: cancel_authentication() emite
       authentication_complete y no debe leerse como un intento fallido. */
    modo = MODO_INACTIVO;
    if (cortar) {
      cancelarAutenticacionPendiente();
    }
    clave = "";
    if (d.entradaClave) {
      d.entradaClave.value = "";
    }
    pasoCambio = null;
    repitePendiente = false;
    ultimoMensajePam = "";
    ultimoMotivoRechazo = "";
    huboPreguntaClaveAcceso = false;
    nuevaClave = "";
    repiteClave = "";
    if (d.entradaNuevaClave) {
      d.entradaNuevaClave.value = "";
    }
    if (d.entradaRepiteClave) {
      d.entradaRepiteClave.value = "";
    }
    ocultarFormularioCambioClave();
    ocultarCubierta();
    bloquear(false);
  }

  /* --------------------------------------- una sola ventana al mando */

  /* web-greeter registra el MISMO objeto «lightdm» en todas sus ventanas
     (globales.LDMGreeter, browser/window.py), así que las señales de PAM
     llegan a TODAS. En una pantalla duplicada hay dos ventanas con este tema
     —la secundaria carga el tema principal al detectar que es un clon, ver
     secondary.html— y la que el usuario no está usando recibía el
     show_prompt del intento de la otra: registraba «prompt inesperado
     estando parados» (que error_prompt.py convierte en un diálogo encima de
     la pantalla de acceso) y, peor, cancelaba con cancel_authentication() la
     autenticación en curso de la ventana buena, de modo que no se podía
     entrar.

     Por eso la conversación tiene dueña: la ventana donde el usuario teclea
     o pulsa se declara dueña por greeter_comm.broadcast() y las demás dejan
     de atender las señales. Sirve el primer gesto porque sólo la ventana de
     encima recibe los eventos del teclado y del ratón: no hay que saber cuál
     está encima, lo dice el usuario al usarla. Si toca otra, esa pasa a ser
     la dueña.

     Con una sola ventana —el caso normal— nunca llega el anuncio de otra:
     «otroDueno» se queda en false y todo funciona como antes. Si no hubiera
     greeter_comm (web-greeter antiguo, o el simulado de desarrollo),
     reclamar no hace nada y ocurre lo mismo. */

  var MARCA_MANDO = "recoverpass:mando";

  /* Identidad de ESTA carga de la página, para reconocer nuestro propio
     anuncio: broadcast() se lo entrega también al que lo envía.
     A propósito no se usa greeter_comm.window_metadata.id: leerlo antes de que
     el canal esté listo LANZA («window_metadata not available…»), y una
     identidad que a veces falta haría que la ventana se cediera el mando a sí
     misma y dejara de atender a PAM. Un número al azar está siempre. */
  var TOKEN_VENTANA = "v" + Date.now() + "-" + Math.random().toString(36).slice(2);

  /* Se llama en cada gesto del usuario: anuncia una sola vez, y vuelve a
     anunciar si otra ventana nos había quitado el mando. */
  function reclamarElMando() {
    if (heReclamado && !otroDueno) {
      return;
    }
    otroDueno = false;
    heReclamado = true;
    try {
      if (window.greeter_comm && window.greeter_comm.broadcast) {
        window.greeter_comm.broadcast({ marca: MARCA_MANDO, token: TOKEN_VENTANA });
      }
    } catch (error) {
      avisar("no se pudo anunciar el mando de la conversación", error);
    }
  }

  function alAnuncioDeMando(datos) {
    if (!datos || datos.marca !== MARCA_MANDO) {
      return;
    }
    if (datos.token === TOKEN_VENTANA) {
      return; /* nuestro propio anuncio: broadcast() también nos lo entrega */
    }
    otroDueno = true;
    heReclamado = false;
    cederElMando();
  }

  /* El usuario se ha puesto en otra pantalla: se vuelve al estado inicial
     sin cortar la conversación, que ya no es nuestra. */
  function cederElMando() {
    if (modo === MODO_INACTIVO) {
      return;
    }
    avisar("el acceso continúa en otra pantalla; esta ventana vuelve al inicio");
    reiniciarEstado(false);
    mostrarMensaje("", "");
  }

  function enfocarEntrada() {
    try {
      if (d.entradaClave && !d.entradaClave.disabled && obtenerUsuario()) {
        d.entradaClave.focus();
      } else if (d.listaUsuarios && d.campoLista && !d.campoLista.hidden) {
        d.listaUsuarios.focus();
      } else if (d.entradaUsuario) {
        d.entradaUsuario.focus();
      }
    } catch (e) {
      /* sin foco se puede seguir usando el teclado con el tabulador */
    }
  }

  /* ------------------------------------------------------------- usuarios */

  function obtenerUsuario() {
    if (d.campoLista && !d.campoLista.hidden && d.listaUsuarios &&
        d.listaUsuarios.value && d.listaUsuarios.value !== OTRO_USUARIO) {
      return d.listaUsuarios.value;
    }
    if (d.entradaUsuario && d.entradaUsuario.value) {
      return d.entradaUsuario.value.replace(/^\s+|\s+$/g, "");
    }
    return "";
  }

  function rellenarUsuarios() {
    var g = ldm();
    var lista = [];
    var i;

    if (g && g.users && g.users.length) {
      for (i = 0; i < g.users.length; i++) {
        /* La cuenta del kiosco no se ofrece: se llega a ella por el botón.
           AccountsService ya la oculta, esto es un cinturón de más. */
        if (g.users[i] && g.users[i].username !== USUARIO_RECUPERACION) {
          lista.push(g.users[i]);
        }
      }
    }

    var ocultar = false;
    try {
      ocultar = !!(g && g.hide_users_hint);
    } catch (e) {
      ocultar = false;
    }

    if (ocultar || lista.length === 0 || !d.listaUsuarios || !d.campoLista) {
      /* Sin lista: campo de usuario a mano. */
      if (d.campoLista) {
        d.campoLista.hidden = true;
      }
      if (d.campoUsuario) {
        d.campoUsuario.hidden = false;
      }
      return;
    }

    d.listaUsuarios.innerHTML = "";
    for (i = 0; i < lista.length; i++) {
      var opcion = document.createElement("option");
      opcion.value = lista[i].username;
      opcion.textContent = lista[i].display_name || lista[i].username;
      d.listaUsuarios.appendChild(opcion);
    }

    var otra = document.createElement("option");
    otra.value = OTRO_USUARIO;
    otra.textContent = "Otro usuario…";
    d.listaUsuarios.appendChild(otra);

    /* Sugerencia de LightDM sobre qué usuario preseleccionar. */
    try {
      if (g.select_user_hint) {
        d.listaUsuarios.value = g.select_user_hint;
      }
    } catch (e) {
      /* si la sugerencia no está en la lista, se queda el primero */
    }

    d.campoLista.hidden = false;
    if (d.campoUsuario) {
      d.campoUsuario.hidden = true;
    }

    d.listaUsuarios.addEventListener(
      "change",
      seguro(function () {
        var manual = d.listaUsuarios.value === OTRO_USUARIO;
        if (d.campoUsuario) {
          d.campoUsuario.hidden = !manual;
        }
        if (manual && d.entradaUsuario) {
          d.entradaUsuario.value = "";
          d.entradaUsuario.focus();
        } else if (d.entradaClave) {
          d.entradaClave.focus();
        }
        actualizarEstadoEntrar();
      }, "cambio de usuario")
    );
  }

  /* ------------------------------------------------------------- sesiones */

  function rellenarSesiones() {
    var g = ldm();
    if (!d.listaSesiones || !d.zonaSesion) {
      return;
    }

    /* En un equipo de aula el selector de sesión no le sirve de nada al
       profesorado, así que se puede ocultar desde la configuración. */
    if (!cfg().mostrarSesion) {
      d.zonaSesion.hidden = true;
      return;
    }

    var sesiones = [];
    var i;
    if (g && g.sessions && g.sessions.length) {
      for (i = 0; i < g.sessions.length; i++) {
        /* La sesión del kiosco no se ofrece en el selector. */
        if (g.sessions[i] && g.sessions[i].key !== SESION_RECUPERACION) {
          sesiones.push(g.sessions[i]);
        }
      }
    }

    if (sesiones.length === 0) {
      d.zonaSesion.hidden = true;
      return;
    }

    d.listaSesiones.innerHTML = "";
    for (i = 0; i < sesiones.length; i++) {
      var opcion = document.createElement("option");
      opcion.value = sesiones[i].key;
      opcion.textContent = sesiones[i].name || sesiones[i].key;
      d.listaSesiones.appendChild(opcion);
    }

    try {
      if (g.default_session) {
        d.listaSesiones.value = g.default_session;
      }
      if (!d.listaSesiones.value) {
        d.listaSesiones.selectedIndex = 0;
      }
    } catch (e) {
      d.listaSesiones.selectedIndex = 0;
    }
  }

  function sesionElegida() {
    if (d.listaSesiones && d.listaSesiones.value) {
      return d.listaSesiones.value;
    }
    var g = ldm();
    if (g && g.default_session) {
      return g.default_session;
    }
    return "";
  }

  /* -------------------------------------------------------------- energía */

  /* ------------------------------------------- diálogo de confirmación */

  var confirmacionEnCurso = null;

  function cerrarConfirmacion() {
    if (!d.confirmacion) {
      return;
    }
    d.confirmacion.hidden = true;
    confirmacionEnCurso = null;
  }

  /* Pide confirmación antes de una acción irreversible. No se usa
     window.confirm(): bloquea el hilo del greeter y en QtWebEngine puede no
     aparecer siquiera. Si por lo que sea no existiera el diálogo en el DOM, se
     ejecuta la acción directamente en vez de dejar el botón muerto. */
  function confirmar(pregunta, etiquetaAceptar, alAceptar) {
    if (!d.confirmacion || !d.confirmacionAceptar || !d.confirmacionCancelar) {
      alAceptar();
      return;
    }

    confirmacionEnCurso = alAceptar;
    d.confirmacionTitulo.textContent = pregunta;
    d.confirmacionAceptar.textContent = etiquetaAceptar;
    d.confirmacion.hidden = false;

    /* El foco va a «Cancelar»: si alguien pulsa Intro sin leer, no se apaga
       el equipo. */
    try {
      d.confirmacionCancelar.focus();
    } catch (error) {
      registrar("no se pudo enfocar el botón de cancelar", error);
    }
  }

  function configurarConfirmacion() {
    if (!d.confirmacion) {
      return;
    }

    d.confirmacionCancelar.addEventListener("click", seguro(function () {
      cerrarConfirmacion();
    }, "cancelar-confirmacion"));

    d.confirmacionAceptar.addEventListener("click", seguro(function () {
      var accion = confirmacionEnCurso;
      cerrarConfirmacion();
      if (accion) {
        accion();
      }
    }, "aceptar-confirmacion"));

    /* Escape cancela, como en cualquier diálogo. */
    d.confirmacion.addEventListener("keydown", seguro(function (evento) {
      if (evento.key === "Escape" || evento.keyCode === 27) {
        cerrarConfirmacion();
      }
    }, "escape-confirmacion"));
  }

  function configurarEnergia() {
    var g = ldm();
    if (!g) {
      return;
    }

    /* Cada botón se muestra sólo si LightDM permite la acción Y la
       configuración la tiene activada. Hibernar no se ofrece: apenas funciona
       en los equipos del parque y confunde al lado de «suspender». */
    var c = cfg();
    var acciones = [
      { boton: d.apagar, puede: "can_shutdown", metodo: "shutdown",
        texto: "Apagando el equipo…", visible: c.mostrarApagar,
        pregunta: "¿Seguro que quiere apagar el equipo?", etiqueta: "Apagar" },
      { boton: d.reiniciar, puede: "can_restart", metodo: "restart",
        texto: "Reiniciando el equipo…", visible: c.mostrarReiniciar,
        pregunta: "¿Seguro que quiere reiniciar el equipo?", etiqueta: "Reiniciar" },
      { boton: d.suspender, puede: "can_suspend", metodo: "suspend",
        texto: "Suspendiendo…", visible: c.mostrarSuspender,
        pregunta: "¿Seguro que quiere suspender el equipo?", etiqueta: "Suspender" },
      { boton: d.hibernar, puede: "can_hibernate", metodo: "hibernate",
        texto: "Hibernando…", visible: false,
        pregunta: "¿Seguro que quiere hibernar el equipo?", etiqueta: "Hibernar" }
    ];

    for (var i = 0; i < acciones.length; i++) {
      (function (accion) {
        if (!accion.boton || !accion.visible || !g[accion.puede]) {
          return;
        }
        accion.boton.hidden = false;
        accion.boton.addEventListener(
          "click",
          seguro(function () {
            confirmar(accion.pregunta, accion.etiqueta, function () {
              mostrarCubierta(accion.texto);
              window.setTimeout(function () {
                try {
                  ldm()[accion.metodo]();
                } catch (error) {
                  registrar("fallo al ejecutar " + accion.metodo, error);
                  ocultarCubierta();
                  mostrarMensaje("No se ha podido completar la operación.", "error");
                }
              }, 250);
            });
          }, accion.metodo)
        );
      })(acciones[i]);
    }
  }

  /* --------------------------------------------------------------- señales */

  /* Conecta una señal en el estilo de web-greeter 3.x (objeto con .connect).
     Si esa señal no existe como objeto, se recurre al estilo antiguo de
     globales, que es como lo hacían las versiones viejas del greeter. */
  function conectarSenal(nombre, callback) {
    var g = ldm();
    try {
      if (g && g[nombre] && typeof g[nombre].connect === "function") {
        g[nombre].connect(callback);
        return true;
      }
    } catch (error) {
      registrar("no se pudo conectar la señal " + nombre, error);
    }
    try {
      window[nombre] = callback;
      registrar("señal " + nombre + " conectada por el estilo antiguo (global)");
      return true;
    } catch (error) {
      registrar("no hay forma de recibir la señal " + nombre, error);
      return false;
    }
  }

  function alPrompt(texto, tipo) {
    var g = ldm();
    if (!g) {
      return;
    }
    if (otroDueno) {
      /* La pregunta es del intento de otra pantalla: la contesta ella. */
      return;
    }
    var clase = Number(tipo);

    if (modo === MODO_RECUPERACION) {
      /* Con pam_succeed_if no debería haber ninguna pregunta, pero si PAM la
         hace se responde con la cadena vacía para no dejarlo esperando. */
      g.respond("");
      return;
    }

    if (modo === MODO_ACCESO) {
      if (clase === PROMPT_USUARIO) {
        g.respond(usuario);
        return;
      }
      if (clase !== PROMPT_SECRETO) {
        g.respond("");
        return;
      }
      if (!huboPreguntaClaveAcceso) {
        /* Primera pregunta secreta del intento: es la contraseña de acceso. */
        huboPreguntaClaveAcceso = true;
        g.respond(clave);
        return;
      }
      /* Cualquier pregunta secreta posterior pertenece al cambio de
         contraseña obligatorio; cuál exactamente se decide por su texto.
         Se limpia aquí, una sola vez, el «Comprobando…» del envío del
         formulario de acceso — no en manejarPreguntaCambioClave(), que
         también se llama en los reintentos y ahí el mensaje que haya
         (el motivo del rechazo) debe quedarse. */
      modo = MODO_CAMBIO_CLAVE;
      cancelarVigilante();
      ocultarCubierta();
      mostrarMensaje("", "");
      ultimoMensajePam = "";
      ultimoMotivoRechazo = "";
      manejarPreguntaCambioClave(texto, g);
      return;
    }

    if (modo === MODO_CAMBIO_CLAVE) {
      if (clase === PROMPT_SECRETO) {
        manejarPreguntaCambioClave(texto, g);
        return;
      }
      g.respond("");
      return;
    }

    /* Pregunta inesperada estando parados. No se contesta a ciegas, y sobre
       todo NO se cancela la conversación:

         - En una pantalla duplicada la pregunta puede ser del intento de la
           otra ventana, porque el objeto lightdm es único para todas (ver
           «una sola ventana al mando»); cancelarlo dejaba a esa ventana sin
           poder entrar, que es justo el fallo que se vio en un aula.
         - Y no hace falta para no dejar PAM a medias: cuando esta ventana
           inicie un acceso, iniciarAcceso() ya cancela lo que hubiera
           pendiente antes de llamar a authenticate().

       El aviso se retrasa lo que tarda en llegar un anuncio de mando: si la
       pregunta era de otra pantalla, no hay nada que registrar. Y se registra
       con avisar() —console.warn— porque cualquier console.error abre un
       diálogo de error_prompt.py encima de la pantalla de acceso, y esto ya
       no es una avería. */
    window.setTimeout(function () {
      if (otroDueno) {
        return;
      }
      avisar("prompt inesperado estando parados: " + texto);
    }, ESPERA_ANUNCIO_MANDO);
  }

  /* Clasifica y responde una pregunta secreta del cambio de contraseña
     obligatorio por su TEXTO, no por su posición en la conversación:
     comprobado en un equipo real que PAM puede repreguntar por la
     contraseña ACTUAL («Current Password: ») antes de pedir la nueva, y que
     la pregunta de confirmación puede llegar antes de que el usuario haya
     enviado el formulario. Los textos son los literales en inglés de
     pam_ldap/pam_unix, sin traducir pese al locale español. */
  function manejarPreguntaCambioClave(texto, g) {
    var t = String(texto || "");

    if (/current/i.test(t)) {
      /* Repregunta por la contraseña actual: ya la tenemos de cuando el
         usuario inició sesión, no hace falta pedírsela otra vez. */
      g.respond(clave);
      return;
    }

    if (/retype|repeat|again|confirm/i.test(t)) {
      if (pasoCambio === "repite") {
        /* El usuario ya envió el formulario: se responde sin preguntar. */
        pasoCambio = null;
        ocultarCubierta();
        armarVigilante(ESPERA_AUTENTICACION, "El sistema no responde. Inténtelo de nuevo.");
        g.respond(repiteClave);
        return;
      }
      /* Ha llegado antes de que el usuario enviase el formulario: se
         responderá en cuanto se tenga repiteClave, ver
         confirmarCambioClaveHandler(). */
      repitePendiente = true;
      return;
    }

    /* Cualquier otro texto («New Password: », un reintento tras un rechazo
       del directorio, o algo no reconocido) pide la contraseña nueva. */
    cancelarVigilante();
    pasoCambio = "nueva";
    repitePendiente = false;
    mostrarFormularioCambioClave();
  }

  /* Contexto en el que llega un aviso de show_message. Hace falta porque la
     misma tabla se usa en dos momentos muy distintos y el aviso de reserva no
     puede ser el mismo en los dos:

       CTX_ACCESO  mientras se comprueban usuario y contraseña. Aquí NO hay
                   reserva: un texto que no se reconozca no se traduce a nada,
                   no se pinta y alCompletar() deja el «Usuario o contraseña
                   incorrectos.» de siempre. Decirle a alguien un motivo
                   equivocado —«su cuenta está bloqueada»— cuando sólo se ha
                   equivocado de contraseña es peor que no decirle nada.
       CTX_CAMBIO  dentro del cambio de contraseña obligatorio. Ahí sí hay una
                   reserva útil, porque se sabe que lo que ha fallado es la
                   contraseña NUEVA.
       CTX_AMBOS   filas que valen para los dos. */
  var CTX_ACCESO = "acceso";
  var CTX_CAMBIO = "cambio";
  var CTX_AMBOS = "ambos";

  var GENERICO_ACCESO = "Usuario o contraseña incorrectos.";
  var GENERICO_CAMBIO = "El directorio ha rechazado la contraseña nueva. Pruebe con otra.";

  /* Los avisos de show_message vienen en inglés: son los literales propios de
     pam_ldap/pam_sss, sin traducir pese al locale español del equipo. Buena
     parte de ellos no los redacta PAM, sino OpenLDAP: son los textos de
     ldap_passwordpolicy_err2txt() del overlay ppolicy, que el módulo reenvía
     tal cual dentro de «Password change failed: Server message: ...». De ahí
     salieron los del cambio de contraseña, comprobados en un equipo real
     («Password is in history of old passwords»), y de la misma función salen
     «Account is locked» y «Password has expired». Los de pam_sss hay que
     confirmarlos en un equipo del parque; ver CHECKLIST-VM.md.

     Cada fila dice:
       contexto  en qué momento tiene sentido (ver CTX_*)
       prueba    expresión regular sobre el texto ORIGINAL en inglés
       texto     lo que se muestra, en castellano
       motivo    si sirve como MOTIVO de un acceso rechazado, es decir si
                 alCompletar() puede repetirlo en vez del genérico. Los avisos
                 informativos («caducará en 7 días») no lo son: llegan en
                 accesos que siguen adelante
       ayuda     si se le añade la coletilla configurable LOCKED_ACCOUNT_HELP,
                 para que cada centro ponga su extensión o su correo

     Se devuelve la PRIMERA fila que encaje después de filtrar por contexto,
     así que el orden importa: el aviso de caducidad PRÓXIMA va antes que el de
     caducidad consumada, y cada regla nombra su sustantivo (account/password)
     en vez de fiarse de «expired» a secas, para que «account expired» y
     «password expired» no se confundan. */
  var TRADUCCIONES_MENSAJE_PAM = [
    /* --- Informativo: el acceso sigue adelante --------------------------- */
    { contexto: CTX_AMBOS, motivo: false, ayuda: false,
      prueba: /will expire in|expiration warning/i,
      texto: "La contraseña caducará pronto. Cámbiela cuanto antes." },

    /* --- La cuenta no puede entrar, y el usuario no lo puede arreglar ---- */
    { contexto: CTX_AMBOS, motivo: true, ayuda: true,
      prueba: /account (is |has been |was )?locked|accountlocked|account.{0,12}lockout|authentication is denied until/i,
      texto: "La cuenta está bloqueada y no puede iniciar sesión." },
    { contexto: CTX_AMBOS, motivo: true, ayuda: true,
      prueba: /account (is |has been |was )?(disabled|deactivated|inactive)/i,
      texto: "La cuenta está desactivada." },
    { contexto: CTX_AMBOS, motivo: true, ayuda: true,
      prueba: /account (has |is |was )?expired/i,
      texto: "La cuenta ha expirado." },

    /* --- Contraseña caducada. Vale en los dos contextos: el aviso del
       cambio obligatorio llega ANTES de que alPrompt() pase a
       MODO_CAMBIO_CLAVE, así que se recibe todavía en CTX_ACCESO. Sin
       coletilla de ayuda: esto tiene arreglo por sí mismo. -------------- */
    { contexto: CTX_AMBOS, motivo: true, ayuda: false,
      prueba: /password (has |is |was )?expired|expired password/i,
      texto: "La contraseña ha caducado. Debe establecer una nueva." },

    /* --- Sólo dentro del cambio de contraseña obligatorio ---------------- */
    { contexto: CTX_CAMBIO, motivo: true, ayuda: false,
      prueba: /in history of old passwords/i,
      texto: "Esa contraseña ya se ha usado antes. Elija una distinta." },
    { contexto: CTX_CAMBIO, motivo: true, ayuda: false,
      prueba: /old password (is )?not accepted|invalid credentials/i,
      texto: "No se ha podido verificar la contraseña actual. Vuelva a iniciar sesión e inténtelo de nuevo." },
    { contexto: CTX_CAMBIO, motivo: true, ayuda: false,
      prueba: /too short|minimum.*length/i,
      texto: "La contraseña nueva es demasiado corta." },
    { contexto: CTX_CAMBIO, motivo: true, ayuda: false,
      prueba: /quality/i,
      texto: "La contraseña nueva no cumple la política de calidad del directorio." }

    /* TEXTOS QUE NO SE TRADUCEN A NINGÚN MOTIVO, A PROPÓSITO. Pueden venir de
       cualquier sitio, y confundirlos sería acusar de bloqueo a quien sólo se
       ha equivocado de contraseña. Todos caen en el genérico:

         «Permission denied.»              pam_sss, para casi cualquier motivo
                                           (contraseña mala, filtro de acceso,
                                           cuenta bloqueada...). El motivo real
                                           se queda en el log de sssd
         «Authentication failure»          pam_unix/pam_sss
         «Access denied for this service.» pam_sss, ldap_access_filter
         «System is offline, ...»          pam_sss sin red

       «Invalid credentials» sí se traduce, pero SÓLO en CTX_CAMBIO, donde
       significa que no se pudo verificar la contraseña actual. */
  ];

  /* Coletilla configurable de los avisos de cuenta bloqueada, desactivada o
     expirada (LOCKED_ACCOUNT_HELP). Si config.js no está o trae algo raro, el
     aviso se queda sin ella: es información de más, nunca un requisito. */
  function conAyuda(texto) {
    var ayuda = "";
    try {
      ayuda = String(cfg().ayudaCuentaBloqueada || "").replace(/^\s+|\s+$/g, "");
    } catch (error) {
      ayuda = "";
    }
    return ayuda ? texto + " " + ayuda : texto;
  }

  /* Devuelve { texto, motivo }: el texto en castellano (vacío si no se
     reconoce y estamos en el acceso) y si sirve como motivo de un rechazo. */
  function traducirMensajePam(texto, contexto) {
    var t = String(texto || "");
    var ctx = contexto === CTX_CAMBIO ? CTX_CAMBIO : CTX_ACCESO;
    if (!t) {
      return { texto: "", motivo: false };
    }
    for (var i = 0; i < TRADUCCIONES_MENSAJE_PAM.length; i++) {
      var fila = TRADUCCIONES_MENSAJE_PAM[i];
      if (fila.contexto !== CTX_AMBOS && fila.contexto !== ctx) {
        continue;
      }
      if (fila.prueba.test(t)) {
        return {
          texto: fila.ayuda ? conAyuda(fila.texto) : fila.texto,
          motivo: !!fila.motivo
        };
      }
    }
    /* console.warn a propósito, nunca console.error: cualquier console.error
       abre el diálogo de error_prompt.py encima de la pantalla de acceso, y un
       texto de PAM que no esté en la tabla no es una avería. El original queda
       registrado para poder ampliar la tabla:
           sudo grep -i "sin traducción" /var/log/lightdm/*greeter*.log */
    avisar("mensaje de PAM sin traducción (" + ctx + "): " + t);
    if (ctx === CTX_CAMBIO) {
      return { texto: GENERICO_CAMBIO, motivo: true };
    }
    return { texto: "", motivo: false };
  }

  function alMensajePam(texto) {
    if (otroDueno) {
      return;
    }
    if (!texto) {
      return;
    }
    var ctx = modo === MODO_CAMBIO_CLAVE ? CTX_CAMBIO : CTX_ACCESO;
    var aviso = traducirMensajePam(texto, ctx);
    if (!aviso.texto) {
      return; /* sin traducción en el acceso: no se pinta nada */
    }
    ultimoMensajePam = aviso.texto;
    /* El motivo sólo se guarda si de verdad explica un rechazo y hay un flujo
       en curso: un show_message que llegue después de un cancel_authentication
       no debe quedarse pegado al siguiente intento. */
    ultimoMotivoRechazo = aviso.motivo && modo !== MODO_INACTIVO ? aviso.texto : "";
    /* Clase «error» sólo cuando es un rechazo del acceso: el
       authentication_complete que viene detrás lo va a repintar igual en rojo,
       y así no se ve el fogonazo en gris. Dentro del cambio de contraseña se
       sigue pintando sin clase, como hasta ahora, porque ahí muchos avisos van
       seguidos de un reintento. */
    mostrarMensaje(aviso.texto, aviso.motivo && ctx === CTX_ACCESO ? "error" : "");
  }

  function alCompletar() {
    if (otroDueno) {
      return;
    }
    if (modo === MODO_INACTIVO) {
      /* cancel_authentication() también emite esta señal: si no hay ningún
         flujo en curso no hay nada que informar. */
      return;
    }
    cancelarVigilante();

    var autenticado = false;
    try {
      autenticado = !!ldm().is_authenticated;
    } catch (error) {
      registrar("no se pudo leer is_authenticated", error);
    }

    if (!autenticado) {
      /* Se leen ANTES de volverAlInicio(): llama a reiniciarEstado(), que
         borra las dos. */
      var avisoCambio = ultimoMensajePam;
      var motivoAcceso = ultimoMotivoRechazo;

      if (modo === MODO_RECUPERACION) {
        /* La recuperación conserva su mensaje propio: es una cuenta local que
           entra con pam_succeed_if, y un motivo del directorio aquí sólo
           desconcertaría. */
        volverAlInicio(
          "No se ha podido abrir la recuperación de contraseña. Avise al departamento de sistemas.",
          "error"
        );
      } else if (modo === MODO_CAMBIO_CLAVE) {
        /* Si PAM ha explicado el motivo (p. ej. contraseña reutilizada), se
           muestra ese motivo en vez de un genérico que no dice nada — ver
           declaración de ultimoMensajePam. */
        volverAlInicio(
          avisoCambio ||
            "No se ha podido cambiar la contraseña. Vuelva a iniciar sesión e inténtelo de nuevo.",
          "error"
        );
      } else {
        /* Si el directorio ha dicho POR QUÉ —cuenta bloqueada, desactivada,
           expirada, contraseña caducada— se dice eso: reintentar la contraseña
           no arregla nada de eso, y el usuario sólo consigue agotar más
           intentos. Si no ha dicho nada, o ha dicho algo ambiguo como
           «Permission denied», queda el genérico de siempre. */
        volverAlInicio(motivoAcceso || GENERICO_ACCESO, "error");
      }
      return;
    }

    if (modo === MODO_RECUPERACION) {
      arrancarSesion(SESION_RECUPERACION, "Abriendo la recuperación de contraseña…");
    } else {
      arrancarSesion(sesionElegida(), "Iniciando sesión…");
    }
  }

  function arrancarSesion(claveSesion, texto) {
    mostrarCubierta(texto);
    armarVigilante(ESPERA_SESION, "No se ha podido iniciar la sesión. Inténtelo de nuevo.");

    var respuesta = function (correcto) {
      /* QWebChannel entrega aquí el valor devuelto por start_session. */
      if (correcto === false) {
        cancelarVigilante();
        volverAlInicio(
          "No se ha podido iniciar la sesión «" + claveSesion + "».",
          "error"
        );
        return;
      }
      /* LightDM ha aceptado arrancar la sesión: se desarma el vigilante y se
         deja la cubierta puesta. Normalmente esta página desaparece en
         seguida. Si el arranque se torciera después, LightDM devuelve el
         control al greeter por su cuenta; cancelar aquí la autenticación sólo
         estorbaría. La cubierta sigue siendo pulsable como salida de
         emergencia. */
      cancelarVigilante();
    };

    try {
      ldm().start_session(claveSesion, respuesta);
    } catch (error) {
      registrar("start_session con callback ha fallado; se reintenta sin él", error);
      try {
        ldm().start_session(claveSesion);
      } catch (error2) {
        registrar("start_session ha fallado", error2);
        cancelarVigilante();
        volverAlInicio("No se ha podido iniciar la sesión.", "error");
      }
    }
  }

  function conectarSenales() {
    if (senalesConectadas) {
      return;
    }
    conectarSenal("show_prompt", seguro(alPrompt, "show_prompt"));
    conectarSenal("show_message", seguro(alMensajePam, "show_message"));
    conectarSenal("authentication_complete", seguro(alCompletar, "authentication_complete"));
    senalesConectadas = true;
  }

  function conectarMando() {
    try {
      var comm = window.greeter_comm;
      if (comm && comm.broadcast_signal && comm.broadcast_signal.connect) {
        comm.broadcast_signal.connect(function (ventana, datos) {
          try {
            alAnuncioDeMando(datos);
          } catch (error) {
            avisar("fallo atendiendo el anuncio de mando", error);
          }
        });
      }
    } catch (error) {
      avisar("no se pudo escuchar los anuncios de mando", error);
    }

    /* En captura y sobre el documento: cualquier gesto vale, también en los
       botones de energía o en el formulario de cambio de contraseña. */
    try {
      document.addEventListener("keydown", reclamarElMando, true);
      document.addEventListener("pointerdown", reclamarElMando, true);
    } catch (error) {
      avisar("no se pudieron registrar los gestos del usuario", error);
    }
  }

  /* ---------------------------------------------------------------- flujos */

  function iniciarAcceso(ev) {
    if (ev && ev.preventDefault) {
      ev.preventDefault();
    }
    if (modo !== MODO_INACTIVO) {
      return;
    }

    usuario = obtenerUsuario();
    clave = d.entradaClave ? d.entradaClave.value : "";

    if (!usuario) {
      mostrarMensaje("Escriba su nombre de usuario.", "error");
      enfocarEntrada();
      actualizarEstadoEntrar();
      return;
    }

    if (!clave) {
      mostrarMensaje("Escriba su contraseña.", "error");
      enfocarEntrada();
      actualizarEstadoEntrar();
      return;
    }

    reclamarElMando();
    modo = MODO_ACCESO;
    bloquear(true);
    mostrarMensaje("Comprobando…", "");
    cancelarAutenticacionPendiente();
    armarVigilante(ESPERA_AUTENTICACION, "El sistema no responde. Inténtelo de nuevo.");

    try {
      ldm().authenticate(usuario);
    } catch (error) {
      registrar("fallo al llamar a authenticate", error);
      volverAlInicio("No se ha podido contactar con el sistema de acceso.", "error");
    }
  }

  function iniciarRecuperacion() {
    if (modo !== MODO_INACTIVO) {
      return;
    }

    reclamarElMando();
    modo = MODO_RECUPERACION;
    bloquear(true);
    mostrarMensaje("Abriendo la recuperación de contraseña…", "");
    cancelarAutenticacionPendiente();
    armarVigilante(
      ESPERA_AUTENTICACION,
      "No se ha podido abrir la recuperación de contraseña. Avise al departamento de sistemas."
    );

    try {
      /* La cuenta «recoverpass» entra sin contraseña gracias a la línea
         pam_succeed_if de /etc/pam.d/lightdm: normalmente PAM no llega ni a
         preguntar y salta directamente authentication_complete. */
      ldm().authenticate(USUARIO_RECUPERACION);
    } catch (error) {
      registrar("fallo al llamar a authenticate para la recuperación", error);
      volverAlInicio("No se ha podido abrir la recuperación de contraseña.", "error");
    }
  }

  /* Consulta a EduControl la longitud mínima de contraseña vigente
     (users/password-requirements/, sin sesión) y sustituye
     longitudMinimaClave si contesta a tiempo. Se llama una vez al arrancar,
     en paralelo con todo lo demás, para que ya tenga respuesta (o no) mucho
     antes de que el usuario llegue a ver el formulario. Si la URL no está
     configurada, no hay red, tarda demasiado, o la respuesta no tiene la
     forma esperada, se deja tal cual está — el valor de config.js (o su
     valor de reserva) — sin bloquear ni avisar: esta comprobación es una
     ayuda, no un requisito para poder cambiar la contraseña. */
  function cargarRequisitosClaveRemotos() {
    var url = cfg().urlRequisitosClave;
    if (!url) {
      return;
    }

    var terminado = false;
    var temporizador = window.setTimeout(function () {
      terminado = true;
    }, 4000);

    try {
      window
        .fetch(url, { credentials: "omit", cache: "no-store" })
        .then(function (respuesta) {
          if (terminado || !respuesta || !respuesta.ok) {
            return null;
          }
          return respuesta.json();
        })
        .then(function (datos) {
          window.clearTimeout(temporizador);
          if (terminado || !datos) {
            return;
          }
          var longitud = Number(datos.min_length);
          if (isFinite(longitud) && longitud > 0) {
            longitudMinimaClave = longitud;
            actualizarRequisitosClave();
          }
        })
        .catch(function (error) {
          window.clearTimeout(temporizador);
          avisar("no se pudieron obtener los requisitos de contraseña de EduControl", error);
        });
    } catch (error) {
      window.clearTimeout(temporizador);
      avisar("fetch de requisitos de contraseña no disponible", error);
    }
  }

  /* Comprueba la contraseña candidata contra TODO lo que se puede saber sin
     preguntar al directorio: la longitud mínima vigente, las reglas de
     complejidad, que no sea igual a la actual y que las dos casillas
     coincidan. Devuelve {id: cumplido, ...} más "longitud", "distinta",
     "coincide" y "todo" (true sólo si se cumple absolutamente todo), que es
     lo que habilita el botón «Cambiar contraseña». */
  function evaluarRequisitosClave(valor, repite) {
    var resultado = { longitud: valor.length >= longitudMinimaClave };
    var todo = resultado.longitud;
    for (var i = 0; i < REQUISITOS_COMPLEJIDAD.length; i++) {
      var r = REQUISITOS_COMPLEJIDAD[i];
      var cumplido = r.prueba.test(valor);
      resultado[r.id] = cumplido;
      todo = todo && cumplido;
    }

    /* Igual a la actual: el directorio la rechazaría de todas formas, así que
       se pide aquí. Si no se conoce la actual —no debería pasar en este
       flujo—, no se puede comparar y se da por cumplido. */
    resultado.distinta = !clave || valor !== clave;

    /* Coinciden: con las dos vacías NO se da por cumplido, que si no el botón
       se habilitaría con el formulario en blanco. */
    resultado.coincide = !!valor && valor === repite;

    resultado.todo = todo && resultado.distinta && resultado.coincide;
    return resultado;
  }

  /* Repinta las listas de requisitos según lo escrito en «Contraseña nueva» y
     en «Repita la contraseña nueva», y deja «Cambiar contraseña»
     deshabilitado hasta que se cumplan TODOS. Se llama al escribir en
     cualquiera de las dos casillas, al mostrar el formulario y cuando
     cargarRequisitosClaveRemotos() actualiza la longitud mínima. */
  function actualizarRequisitosClave() {
    if (!d.listaRequisitos) {
      return;
    }
    var valor = d.entradaNuevaClave ? d.entradaNuevaClave.value : "";
    var repite = d.entradaRepiteClave ? d.entradaRepiteClave.value : "";
    var resultado = evaluarRequisitosClave(valor, repite);

    if (d.requisitoLongitud) {
      d.requisitoLongitud.textContent = "Al menos " + longitudMinimaClave + " caracteres";
      d.requisitoLongitud.className = resultado.longitud ? "cumplido" : "";
    }
    for (var i = 0; i < REQUISITOS_COMPLEJIDAD.length; i++) {
      var id = REQUISITOS_COMPLEJIDAD[i].id;
      var nodoRequisito = d["requisito" + id.charAt(0).toUpperCase() + id.slice(1)];
      if (nodoRequisito) {
        nodoRequisito.className = resultado[id] ? "cumplido" : "";
      }
    }

    if (d.requisitoDistinta) {
      d.requisitoDistinta.className = resultado.distinta ? "cumplido" : "";
    }
    if (d.requisitoCoincide) {
      d.requisitoCoincide.className = resultado.coincide ? "cumplido" : "";
    }

    if (d.confirmarCambioClave) {
      /* Deshabilitado mientras falte algo. Con el botón por defecto del
         formulario deshabilitado, el Enter tampoco envía nada: el navegador no
         ejecuta la activación de un botón deshabilitado. Igual que en el
         formulario de acceso. */
      d.confirmarCambioClave.disabled = !resultado.todo;
    }
  }

  function mostrarFormularioCambioClave() {
    if (d.form) {
      d.form.hidden = true;
    }
    if (d.zonaRecuperar) {
      d.zonaRecuperar.hidden = true;
    }
    if (d.formCambioClave) {
      d.formCambioClave.hidden = false;
    }
    if (d.entradaNuevaClave) {
      d.entradaNuevaClave.value = "";
    }
    if (d.entradaRepiteClave) {
      d.entradaRepiteClave.value = "";
    }
    bloquear(false);
    actualizarRequisitosClave();
    /* El propio formulario de acceso queda oculto: sólo se desbloquean los
       controles del cambio de contraseña. */
    if (d.entradaUsuario) {
      d.entradaUsuario.disabled = true;
    }
    if (d.entradaClave) {
      d.entradaClave.disabled = true;
    }
    if (d.listaUsuarios) {
      d.listaUsuarios.disabled = true;
    }
    if (d.recuperar) {
      d.recuperar.disabled = true;
    }
    try {
      if (d.entradaNuevaClave) {
        d.entradaNuevaClave.focus();
      }
    } catch (e) {
      /* sin foco se puede seguir usando el teclado con el tabulador */
    }
  }

  function ocultarFormularioCambioClave() {
    if (d.formCambioClave) {
      d.formCambioClave.hidden = true;
    }
    if (d.form) {
      d.form.hidden = false;
    }
    if (d.zonaRecuperar) {
      d.zonaRecuperar.hidden = false;
    }
  }

  function confirmarCambioClaveHandler(ev) {
    if (ev && ev.preventDefault) {
      ev.preventDefault();
    }
    if (modo !== MODO_CAMBIO_CLAVE || pasoCambio !== "nueva") {
      return;
    }

    var nueva = d.entradaNuevaClave ? d.entradaNuevaClave.value : "";
    var repite = d.entradaRepiteClave ? d.entradaRepiteClave.value : "";

    if (!nueva) {
      mostrarMensaje("Escriba la contraseña nueva.", "error");
      return;
    }
    if (nueva !== repite) {
      mostrarMensaje("Las dos contraseñas no coinciden.", "error");
      return;
    }
    if (nueva === clave) {
      /* Rechazo seguro: se sabe de antemano que el directorio la va a
         rechazar por ser igual a la actual, así que se avisa aquí mismo en
         vez de hacer un viaje entero a PAM para acabar en lo mismo. */
      mostrarMensaje("La contraseña nueva no puede ser igual a la actual.", "error");
      return;
    }
    /* Cinturón de más: con el botón deshabilitado hasta que se cumple todo,
       aquí no se debería llegar con requisitos sin cumplir. Si se llegara —un
       envío del formulario por otra vía—, no se molesta al directorio para
       que rechace algo que ya sabemos que no vale. */
    if (!evaluarRequisitosClave(nueva, repite).todo) {
      mostrarMensaje("La contraseña nueva no cumple los requisitos.", "error");
      actualizarRequisitosClave();
      return;
    }

    nuevaClave = nueva;
    repiteClave = repite;
    pasoCambio = "repite";
    ocultarFormularioCambioClave();
    /* Se deja oculto el propio form-cambio-clave pero seguimos en
       MODO_CAMBIO_CLAVE: alPrompt() ya sabe que la próxima pregunta secreta es
       la confirmación y la responde sola. */
    if (d.formCambioClave) {
      d.formCambioClave.hidden = true;
    }
    mostrarCubierta("Cambiando la contraseña…");
    mostrarMensaje("", "");
    armarVigilante(ESPERA_AUTENTICACION, "El sistema no responde. Inténtelo de nuevo.");

    try {
      ldm().respond(nueva);
      if (repitePendiente) {
        /* La pregunta de confirmación ya había llegado antes de enviar el
           formulario (PAM entrega «New» y «Retype» seguidas, sin esperar
           respuesta entre medias): se responde también ahora, sin esperar
           una señal show_prompt que ya no va a volver a llegar. */
        repitePendiente = false;
        pasoCambio = null;
        ocultarCubierta();
        armarVigilante(ESPERA_AUTENTICACION, "El sistema no responde. Inténtelo de nuevo.");
        ldm().respond(repiteClave);
      }
    } catch (error) {
      registrar("fallo respondiendo la contraseña nueva", error);
      volverAlInicio("No se ha podido cambiar la contraseña. Inténtelo de nuevo.", "error");
    }
  }

  function cancelarCambioClaveHandler() {
    if (modo !== MODO_CAMBIO_CLAVE) {
      return;
    }
    volverAlInicio("", "");
  }

  /* --------------------------------------------------------------- interfaz */

  function configurarFormulario() {
    if (d.form) {
      d.form.addEventListener("submit", seguro(iniciarAcceso, "envío del formulario"));
    }
    if (d.entradaUsuario) {
      d.entradaUsuario.addEventListener(
        "input",
        seguro(actualizarEstadoEntrar, "estado del botón de acceso")
      );
    }
    if (d.entradaClave) {
      d.entradaClave.addEventListener(
        "input",
        seguro(actualizarEstadoEntrar, "estado del botón de acceso")
      );
    }
    if (d.listaUsuarios) {
      d.listaUsuarios.addEventListener(
        "change",
        seguro(actualizarEstadoEntrar, "estado del botón de acceso")
      );
    }
    if (d.recuperar) {
      d.recuperar.addEventListener(
        "click",
        seguro(iniciarRecuperacion, "botón de recuperación")
      );
    }
    actualizarEstadoEntrar();
  }

  function configurarCambioClave() {
    if (d.formCambioClave) {
      d.formCambioClave.addEventListener(
        "submit",
        seguro(confirmarCambioClaveHandler, "envío del cambio de contraseña")
      );
    }
    if (d.cancelarCambioClave) {
      d.cancelarCambioClave.addEventListener(
        "click",
        seguro(cancelarCambioClaveHandler, "cancelar cambio de contraseña")
      );
    }
    if (d.entradaNuevaClave) {
      d.entradaNuevaClave.addEventListener(
        "input",
        seguro(actualizarRequisitosClave, "requisitos de la contraseña")
      );
    }
    if (d.entradaRepiteClave) {
      d.entradaRepiteClave.addEventListener(
        "input",
        seguro(actualizarRequisitosClave, "requisitos de la contraseña")
      );
    }
  }

  function configurarVerClaveDe(boton, entrada) {
    if (!boton || !entrada) {
      return;
    }
    boton.addEventListener(
      "click",
      seguro(function () {
        var oculta = entrada.type === "password";
        entrada.type = oculta ? "text" : "password";
        boton.setAttribute("aria-pressed", oculta ? "true" : "false");
        var etiqueta = oculta ? "Ocultar la contraseña" : "Mostrar la contraseña";
        boton.setAttribute("aria-label", etiqueta);
        boton.setAttribute("title", etiqueta);
        entrada.focus();
      }, "mostrar contraseña")
    );
  }

  function configurarVerClave() {
    configurarVerClaveDe(d.verClave, d.entradaClave);
    configurarVerClaveDe(d.verNuevaClave, d.entradaNuevaClave);
  }

  function configurarCubierta() {
    if (!d.cubierta) {
      return;
    }
    /* Salida de emergencia: si la cubierta se queda puesta porque algo no ha
       respondido, se cierra con el ratón o con el teclado. */
    d.cubierta.addEventListener(
      "click",
      seguro(function () {
        volverAlInicio("", "");
      }, "cubierta")
    );
  }

  function ponerEquipo() {
    if (!d.equipo) {
      return;
    }
    var nombre = "";
    try {
      nombre = ldm().hostname || "";
    } catch (e) {
      nombre = "";
    }
    d.equipo.textContent = nombre;

    /* El nombre del centro va encima del equipo; si no se configura, no se
       reserva espacio para él. */
    if (d.centro) {
      var centro = cfg().nombreCentro;
      d.centro.textContent = centro;
      d.centro.hidden = !centro;
    }
  }

  /* Reloj con Intl, sin depender de theme_utils ni de ninguna red.
     La zona horaria se fija desde la configuración: la sesión del greeter no
     siempre hereda la del sistema y el reloj aparece desplazado unas horas. */
  function actualizarReloj() {
    var ahora = new Date();
    var hora;
    var fecha;
    var zona = cfg().zonaHoraria;
    var opcionesHora = { hour: "2-digit", minute: "2-digit" };
    var opcionesFecha = { weekday: "long", day: "numeric", month: "long" };

    if (zona) {
      opcionesHora.timeZone = zona;
      opcionesFecha.timeZone = zona;
    }

    try {
      hora = new Intl.DateTimeFormat("es-ES", opcionesHora).format(ahora);
      fecha = new Intl.DateTimeFormat("es-ES", opcionesFecha).format(ahora);
    } catch (error) {
      /* Zona inválida o sin datos de zonas horarias: se usa la del equipo. */
      registrar("no se pudo aplicar la zona horaria «" + zona + "»", error);
      try {
        hora = new Intl.DateTimeFormat("es-ES", {
          hour: "2-digit",
          minute: "2-digit"
        }).format(ahora);
        fecha = new Intl.DateTimeFormat("es-ES", {
          weekday: "long",
          day: "numeric",
          month: "long"
        }).format(ahora);
      } catch (error2) {
        hora = ("0" + ahora.getHours()).slice(-2) + ":" + ("0" + ahora.getMinutes()).slice(-2);
        fecha = "";
      }
    }
    /* «lunes, 17 de agosto» -> «Lunes, 17 de agosto». Intl siempre devuelve el
       día en minúscula en es-ES. */
    if (fecha) {
      fecha = fecha.charAt(0).toUpperCase() + fecha.substring(1);
    }

    if (d.hora) {
      d.hora.textContent = hora;
    }
    if (d.fecha) {
      d.fecha.textContent = fecha;
    }
  }

  function iniciarReloj() {
    actualizarReloj();
    if (relojId === null) {
      relojId = window.setInterval(seguro(actualizarReloj, "reloj"), 10000);
    }
  }

  function capturarNodos() {
    d.form = nodo("form-acceso");
    d.campoLista = nodo("campo-lista-usuarios");
    d.listaUsuarios = nodo("lista-usuarios");
    d.campoUsuario = nodo("campo-usuario");
    d.entradaUsuario = nodo("entrada-usuario");
    d.entradaClave = nodo("entrada-clave");
    d.verClave = nodo("ver-clave");
    d.entrar = nodo("entrar");
    d.mensaje = nodo("mensaje");
    d.zonaRecuperar = nodo("zona-recuperar");
    d.recuperar = nodo("recuperar");
    d.formCambioClave = nodo("form-cambio-clave");
    d.entradaNuevaClave = nodo("entrada-nueva-clave");
    d.verNuevaClave = nodo("ver-nueva-clave");
    d.entradaRepiteClave = nodo("entrada-repite-clave");
    d.confirmarCambioClave = nodo("confirmar-cambio-clave");
    d.cancelarCambioClave = nodo("cancelar-cambio-clave");
    d.listaRequisitos = nodo("requisitos-clave");
    d.requisitoLongitud = nodo("requisito-longitud");
    d.requisitoMayuscula = nodo("requisito-mayuscula");
    d.requisitoMinuscula = nodo("requisito-minuscula");
    d.requisitoNumero = nodo("requisito-numero");
    d.requisitoSimbolo = nodo("requisito-simbolo");
    d.requisitoDistinta = nodo("requisito-distinta");
    d.requisitoCoincide = nodo("requisito-coincide");
    d.zonaSesion = nodo("zona-sesion");
    d.listaSesiones = nodo("lista-sesiones");
    d.apagar = nodo("apagar");
    d.reiniciar = nodo("reiniciar");
    d.suspender = nodo("suspender");
    d.hibernar = nodo("hibernar");
    d.cubierta = nodo("cubierta");
    d.cubiertaTexto = nodo("cubierta-texto");
    d.equipo = nodo("equipo");
    d.centro = nodo("centro");
    d.confirmacion = nodo("confirmacion");
    d.confirmacionTitulo = nodo("confirmacion-titulo");
    d.confirmacionAceptar = nodo("confirmacion-aceptar");
    d.confirmacionCancelar = nodo("confirmacion-cancelar");
    d.hora = nodo("hora");
    d.fecha = nodo("fecha");
  }

  /* ---------------------------------------------------------------- arranque */

  function iniciar() {
    capturarNodos();

    /* Lo primero, y fuera del camino crítico: si la apariencia fallara, el
       acceso tiene que seguir funcionando igual. */
    try {
      aplicarApariencia();
    } catch (error) {
      registrar("no se pudo aplicar la apariencia", error);
    }

    if (!ldm()) {
      throw new Error("no hay objeto lightdm disponible");
    }

    longitudMinimaClave = cfg().longitudMinimaClave;
    /* En paralelo con todo lo demás: para cuando el usuario llegue al
       formulario (tras iniciar sesión) ya suele haber contestado. */
    cargarRequisitosClaveRemotos();

    conectarSenales();
    conectarMando();
    rellenarUsuarios();
    rellenarSesiones();
    configurarConfirmacion();
    configurarEnergia();
    configurarFormulario();
    configurarCambioClave();
    configurarVerClave();
    configurarCubierta();
    ponerEquipo();
    iniciarReloj();
    enfocarEntrada();
  }

  /* Último recurso: si el arranque normal falla, se intenta dejar al menos el
     acceso con usuario y contraseña, y se dice por pantalla qué hacer. */
  function modoDegradado(error) {
    registrar("arranque fallido; se pasa a modo degradado", error);
    try {
      capturarNodos();
      mostrarMensaje(
        "El tema no ha cargado del todo. Puede intentar iniciar sesión igualmente; " +
          "si no funciona, pulse Ctrl+Alt+F2 para abrir una consola.",
        "error"
      );
      conectarSenales();
      conectarMando();
      configurarFormulario();
      configurarCambioClave();
      if (d.campoUsuario) {
        d.campoUsuario.hidden = false;
      }
      if (d.campoLista) {
        d.campoLista.hidden = true;
      }
      bloquear(false);
    } catch (error2) {
      registrar("el modo degradado también ha fallado", error2);
    }
  }

  function arrancar() {
    if (arrancado) {
      return;
    }
    arrancado = true;
    try {
      iniciar();
    } catch (error) {
      modoDegradado(error);
    }
  }

  window.addEventListener("GreeterReady", arrancar);

  /* Red de seguridad: si el evento no llegara (o llegara antes de registrar el
     manejador), se arranca igualmente en cuanto haya objeto lightdm. */
  window.setTimeout(function () {
    if (!arrancado && window.lightdm) {
      registrar("GreeterReady no ha llegado; se arranca por el temporizador");
      arrancar();
    }
  }, 3000);
})();
