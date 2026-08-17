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

  var USUARIO_RECUPERACION = "recoverpass";
  var SESION_RECUPERACION = "recoverpass";
  var OTRO_USUARIO = "__otro__";

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
    zonaHoraria: "Europe/Madrid"
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

  /* #rgb o #rrggbb -> [r, g, b]. Devuelve null si no se entiende. */
  function aRgb(hex) {
    if (typeof hex !== "string") {
      return null;
    }
    var v = hex.replace("#", "").trim();
    if (v.length === 3) {
      v = v.charAt(0) + v.charAt(0) + v.charAt(1) + v.charAt(1) + v.charAt(2) + v.charAt(2);
    }
    if (!/^[0-9A-Fa-f]{6}$/.test(v)) {
      return null;
    }
    return [
      parseInt(v.substring(0, 2), 16),
      parseInt(v.substring(2, 4), 16),
      parseInt(v.substring(4, 6), 16)
    ];
  }

  function aHex(rgb) {
    var salida = "#";
    for (var i = 0; i < 3; i++) {
      var n = Math.max(0, Math.min(255, Math.round(rgb[i])));
      salida += ("0" + n.toString(16)).slice(-2);
    }
    return salida;
  }

  /* Luminancia relativa (WCAG), para decidir si el texto va claro u oscuro. */
  function luminancia(rgb) {
    var canal = [];
    for (var i = 0; i < 3; i++) {
      var c = rgb[i] / 255;
      canal[i] = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * canal[0] + 0.7152 * canal[1] + 0.0722 * canal[2];
  }

  function mezclar(rgbA, rgbB, proporcion) {
    return [
      rgbA[0] + (rgbB[0] - rgbA[0]) * proporcion,
      rgbA[1] + (rgbB[1] - rgbA[1]) * proporcion,
      rgbA[2] + (rgbB[2] - rgbA[2]) * proporcion
    ];
  }

  function rgba(rgb, alfa) {
    return "rgba(" + Math.round(rgb[0]) + ", " + Math.round(rgb[1]) + ", " +
           Math.round(rgb[2]) + ", " + alfa + ")";
  }

  /* Deriva la paleta entera de los dos colores configurados y la aplica como
     variables CSS. La clave es la luminancia del secundario: con un secundario
     claro los textos se oscurecen y con uno oscuro se aclaran, de modo que
     poner blanco o negro funciona sin dejar nada ilegible. */
  function aplicarApariencia() {
    var c = cfg();
    var raiz = document.documentElement;

    var primario = aRgb(c.colorPrimario) || aRgb(CONFIG_POR_DEFECTO.colorPrimario);
    var secundario = aRgb(c.colorSecundario) || aRgb(CONFIG_POR_DEFECTO.colorSecundario);

    var BLANCO = [255, 255, 255];
    var NEGRO = [0, 0, 0];
    var claro = luminancia(secundario) > 0.4;      // ¿el panel es de color claro?
    var contraste = claro ? NEGRO : BLANCO;        // hacia dónde tirar los textos

    var texto = mezclar(secundario, contraste, 0.92);
    var textoTenue = mezclar(secundario, contraste, 0.55);
    var borde = mezclar(secundario, contraste, 0.35);
    var bordeFuerte = mezclar(secundario, contraste, 0.5);
    var linea = mezclar(secundario, contraste, 0.14);
    var superficie = mezclar(secundario, contraste, 0.06);

    // El texto sobre el color principal: claro u oscuro según lo pida él mismo
    var sobrePrimario = luminancia(primario) > 0.5 ? NEGRO : BLANCO;
    var primarioClaro = mezclar(primario, claro ? NEGRO : BLANCO, 0.18);

    var vars = {
      "--fondo": aHex(secundario),
      "--superficie": aHex(superficie),
      "--borde": aHex(borde),
      "--borde-fuerte": aHex(bordeFuerte),
      "--linea": aHex(linea),
      "--texto": aHex(texto),
      "--texto-tenue": aHex(textoTenue),
      "--acento": aHex(primario),
      "--acento-claro": aHex(primarioClaro),
      "--sobre-acento": aHex(sobrePrimario),
      /* Panel translúcido sobre la imagen de fondo, para que el formulario se
         lea sin tapar del todo la fotografía. */
      "--panel": rgba(secundario, 0.88),
      "--velo": rgba(claro ? BLANCO : NEGRO, 0.35)
    };

    for (var nombreVar in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, nombreVar)) {
        try {
          raiz.style.setProperty(nombreVar, vars[nombreVar]);
        } catch (error) {
          registrar("no se pudo aplicar " + nombreVar, error);
        }
      }
    }

    if (c.imagenFondo) {
      try {
        raiz.style.setProperty("--imagen-fondo", 'url("' + c.imagenFondo + '")');
        document.body.classList.add("con-imagen");
      } catch (error) {
        registrar("no se pudo aplicar la imagen de fondo", error);
      }
    }
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
    var controles = [
      d.listaUsuarios,
      d.entradaUsuario,
      d.entradaClave,
      d.verClave,
      d.entrar,
      d.recuperar
    ];
    for (var i = 0; i < controles.length; i++) {
      if (controles[i]) {
        controles[i].disabled = !!si;
      }
    }
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
    cancelarVigilante();
    /* El modo se marca antes de cancelar: cancel_authentication() emite
       authentication_complete y no debe leerse como un intento fallido. */
    modo = MODO_INACTIVO;
    cancelarAutenticacionPendiente();
    clave = "";
    if (d.entradaClave) {
      d.entradaClave.value = "";
    }
    ocultarCubierta();
    bloquear(false);
    mostrarMensaje(texto, clase);
    enfocarEntrada();
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
      } else if (clase === PROMPT_SECRETO) {
        g.respond(clave);
      } else {
        g.respond("");
      }
      return;
    }

    /* Pregunta inesperada estando parados: se cancela la conversación con PAM
       en vez de contestar a ciegas, para no dejarla a medias bloqueando la
       siguiente autenticación. */
    registrar("prompt inesperado estando parados: " + texto);
    cancelarAutenticacionPendiente();
  }

  function alMensajePam(texto) {
    if (texto) {
      mostrarMensaje(String(texto), "");
    }
  }

  function alCompletar() {
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
      if (modo === MODO_RECUPERACION) {
        volverAlInicio(
          "No se ha podido abrir la recuperación de contraseña. Avise al departamento de sistemas.",
          "error"
        );
      } else {
        volverAlInicio("Usuario o contraseña incorrectos.", "error");
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
      return;
    }

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

  /* --------------------------------------------------------------- interfaz */

  function configurarFormulario() {
    if (d.form) {
      d.form.addEventListener("submit", seguro(iniciarAcceso, "envío del formulario"));
    }
    if (d.recuperar) {
      d.recuperar.addEventListener(
        "click",
        seguro(iniciarRecuperacion, "botón de recuperación")
      );
    }
  }

  function configurarVerClave() {
    if (!d.verClave || !d.entradaClave) {
      return;
    }
    d.verClave.addEventListener(
      "click",
      seguro(function () {
        var oculta = d.entradaClave.type === "password";
        d.entradaClave.type = oculta ? "text" : "password";
        d.verClave.setAttribute("aria-pressed", oculta ? "true" : "false");
        var etiqueta = oculta ? "Ocultar la contraseña" : "Mostrar la contraseña";
        d.verClave.setAttribute("aria-label", etiqueta);
        d.verClave.setAttribute("title", etiqueta);
        d.entradaClave.focus();
      }, "mostrar contraseña")
    );
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
    d.recuperar = nodo("recuperar");
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

    conectarSenales();
    rellenarUsuarios();
    rellenarSesiones();
    configurarConfirmacion();
    configurarEnergia();
    configurarFormulario();
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
      configurarFormulario();
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
