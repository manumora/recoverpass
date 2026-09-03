/*
 * Objeto «lightdm» simulado para desarrollar el tema en un Chrome normal, sin
 * reiniciar LightDM.
 *
 * SÓLO se activa fuera del greeter: dentro, web-greeter inyecta bootstrap.js
 * al crear el documento, que define window._ready_event y el puente QWebChannel
 * (window.qt). Si alguno de los dos existe, este fichero no hace nada.
 *
 * Reproduce el comportamiento observado en web-greeter 3.5.3:
 *   - las señales son objetos con .connect()
 *   - las señales llegan con unos 60 ms de retraso respecto a la llamada
 *   - start_session(clave, callback) entrega el resultado por el callback
 *   - la cuenta «recoverpass» entra sin que PAM llegue a preguntar
 *
 * Escenarios, por parámetros en la URL (véase mock/index.html):
 *   ?prompt=1              PAM sí pregunta durante la recuperación
 *   ?fallo=acceso          el acceso normal falla siempre
 *   ?fallo=recuperacion    la autenticación de recoverpass falla
 *   ?fallo=sesion          start_session devuelve false
 *   ?silencio=1            LightDM no contesta nunca (prueba del vigilante)
 *   ?usuarios=0            sin lista de usuarios (hide_users_hint)
 *   ?rechazo=X             el directorio rechaza el acceso y PAM explica por
 *                          qué, con el literal inglés que manda de verdad.
 *                          Valores: bloqueada, desactivada, expirada,
 *                          caducada, avisocaducidad y desconocido. El último
 *                          manda «Permission denied», que es ambiguo: el tema
 *                          NO debe adivinar nada y tiene que salir el genérico
 *                          «Usuario o contraseña incorrectos.». Manda sobre
 *                          ?debecambiar=1.
 *   ?debecambiar=1         tras la contraseña correcta, PAM exige cambiarla
 *                          (pwdReset+pwdMustChange): pide «nueva» y «repite»
 *                          como preguntas secretas adicionales, igual que
 *                          hace pam_sss de verdad. Si no coinciden entre sí,
 *                          o si la nueva es igual a la actual, PAM avisa por
 *                          show_message y vuelve a preguntar (reintento).
 *
 * La contraseña de los usuarios simulados es «demo».
 *
 * Para el caso de la pantalla duplicada —dos ventanas del tema compartiendo un
 * solo objeto lightdm— el simulado lo sirve mock/dos-pantallas.html; ver la
 * comprobación de window.parent.RECOVERPASS_BANCO más abajo.
 */
(function () {
  "use strict";

  if (window._ready_event !== undefined || typeof qt !== "undefined") {
    return; /* estamos dentro del greeter de verdad */
  }

  /* Banco de dos pantallas (mock/dos-pantallas.html): reproduce lo que hace
     web-greeter en una pantalla duplicada —dos ventanas con este tema y UN
     solo objeto lightdm, cuyas señales llegan a las dos—. Si estamos dentro
     de ese banco, el objeto lo sirve él y aquí no hay nada que simular. */
  try {
    if (window.parent !== window && window.parent.RECOVERPASS_BANCO) {
      window.parent.RECOVERPASS_BANCO.montar(window);
      return;
    }
  } catch (error) {
    /* otro origen: no es el banco, se sigue con el simulado normal */
  }

  var RETRASO = 60;
  var CLAVE_BUENA = "demo";

  function parametro(nombre) {
    var busqueda = window.location.search || "";
    var partes = busqueda.replace(/^\?/, "").split("&");
    for (var i = 0; i < partes.length; i++) {
      var par = partes[i].split("=");
      if (decodeURIComponent(par[0]) === nombre) {
        return decodeURIComponent(par[1] || "");
      }
    }
    return null;
  }

  var opciones = {
    prompt: parametro("prompt") === "1",
    fallo: parametro("fallo") || "",
    silencio: parametro("silencio") === "1",
    conUsuarios: parametro("usuarios") !== "0",
    debeCambiar: parametro("debecambiar") === "1",
    rechazo: parametro("rechazo") || ""
  };

  /* Motivos que el directorio da para rechazar el acceso, con el literal EN
     INGLÉS tal y como lo manda PAM por show_message. Los de ppolicy salen de
     ldap_passwordpolicy_err2txt() de OpenLDAP, la misma función de la que
     salió el «Password is in history of old passwords» comprobado en un equipo
     real. «desconocido» está a propósito: es el caso en el que el tema NO debe
     adivinar el motivo. */
  var MOTIVOS_RECHAZO = {
    bloqueada: "Account is locked",
    desactivada: "Account is disabled",
    expirada: "Your account has expired; please contact your system administrator",
    caducada: "Password has expired",
    avisocaducidad: "Your password will expire in 7 days.",
    desconocido: "Permission denied."
  };

  function Senal(nombre) {
    this._nombre = nombre;
    this._destinos = [];
  }
  Senal.prototype.connect = function (callback) {
    if (typeof callback === "function") {
      this._destinos.push(callback);
    }
  };
  Senal.prototype.disconnect = function (callback) {
    for (var i = 0; i < this._destinos.length; i++) {
      if (this._destinos[i] === callback) {
        this._destinos.splice(i, 1);
        return;
      }
    }
  };
  Senal.prototype._emitir = function () {
    var args = Array.prototype.slice.call(arguments);
    var destinos = this._destinos.slice();
    window.setTimeout(function () {
      for (var i = 0; i < destinos.length; i++) {
        destinos[i].apply(null, args);
      }
    }, RETRASO);
  };

  function Usuario(username, display_name, session) {
    this.username = username;
    this.display_name = display_name;
    this.session = session || "";
    this.home_directory = "/home/" + username;
    this.image = "";
    this.logged_in = false;
    this.layouts = [];
  }

  function Sesion(key, name, comment) {
    this.key = key;
    this.name = name;
    this.comment = comment || "";
    this.type = "x";
  }

  function Greeter() {
    this.authentication_complete = new Senal("authentication_complete");
    this.autologin_timer_expired = new Senal("autologin_timer_expired");
    this.idle = new Senal("idle");
    this.reset = new Senal("reset");
    this.show_message = new Senal("show_message");
    this.show_prompt = new Senal("show_prompt");
    this.brightness_update = new Senal("brightness_update");
    this.battery_update = new Senal("battery_update");

    this.authentication_user = null;
    this.in_authentication = false;
    this.is_authenticated = false;

    /* Estado del escenario ?debecambiar=1, ver Greeter.prototype.respond. */
    this._pasoCambio = null;
    this._claveActual = "";
    this._nuevaClave = "";

    this.can_shutdown = true;
    this.can_restart = true;
    this.can_suspend = true;
    this.can_hibernate = false;

    this.hostname = "xubuntu-simulado";
    this.default_session = "xfce";
    this.hide_users_hint = !opciones.conUsuarios;
    this.select_user_hint = "";
    this.lock_hint = false;
    this.has_guest_account = false;

    this.languages = [];
    this.layouts = [];

    /* La sesión «recoverpass» no aparece aquí a propósito: liblightdm filtra
       las entradas con NoDisplay=true, así que el greeter real tampoco la ve. */
    this.sessions = [
      new Sesion("xfce", "Xfce Session", "Sesión de escritorio Xfce"),
      new Sesion("xubuntu", "Xubuntu", "Sesión de Xubuntu")
    ];

    /* Tampoco aparece «recoverpass»: AccountsService la marca SystemAccount. */
    this.users = [
      new Usuario("mgarcia", "María García", "xfce"),
      new Usuario("jlopez", "Javier López", "xfce"),
      new Usuario("adelgado", "Alba Delgado", "xubuntu")
    ];
  }

  Greeter.prototype.authenticate = function (username) {
    this.authentication_user = username || null;
    this.in_authentication = true;
    this.is_authenticated = false;

    if (opciones.silencio) {
      return; /* LightDM se queda mudo: debe saltar el vigilante del tema */
    }

    var self = this;

    if (username === "recoverpass") {
      if (opciones.fallo === "recuperacion") {
        window.setTimeout(function () {
          self.in_authentication = false;
          self.is_authenticated = false;
          self.authentication_complete._emitir();
        }, RETRASO);
        return;
      }
      if (opciones.prompt) {
        /* Caso de que PAM sí pregunte pese a pam_succeed_if. */
        this.show_prompt._emitir("Contraseña: ", 1);
        return;
      }
      window.setTimeout(function () {
        self.in_authentication = false;
        self.is_authenticated = true;
        self.authentication_complete._emitir();
      }, RETRASO);
      return;
    }

    if (!username) {
      this.show_prompt._emitir("login:", 0);
      return;
    }
    this.show_prompt._emitir("Contraseña: ", 1);
  };

  Greeter.prototype.respond = function (respuesta) {
    if (!this.in_authentication) {
      return;
    }
    var self = this;

    if (this.authentication_user === "recoverpass") {
      /* pam_succeed_if no mira la respuesta. */
      window.setTimeout(function () {
        self.in_authentication = false;
        self.is_authenticated = opciones.fallo !== "recuperacion";
        self.authentication_complete._emitir();
      }, RETRASO);
      return;
    }

    if (this.authentication_user === null) {
      this.authentication_user = respuesta;
      this.show_prompt._emitir("Contraseña: ", 1);
      return;
    }

    /* ?rechazo=...: el acceso se rechaza aunque la contraseña sea la buena,
       porque una cuenta bloqueada no entra ni escribiéndola bien. Primero
       llega el show_message con el texto en inglés y después el
       authentication_complete, que es el orden real. La excepción es
       «avisocaducidad», que es informativo: ahí la sesión sí arranca. */
    if (opciones.rechazo && MOTIVOS_RECHAZO[opciones.rechazo]) {
      var textoMotivo = MOTIVOS_RECHAZO[opciones.rechazo];
      var entra = opciones.rechazo === "avisocaducidad" && respuesta === CLAVE_BUENA;
      window.setTimeout(function () {
        self.show_message._emitir(textoMotivo, 1);
        window.setTimeout(function () {
          self.in_authentication = false;
          self.is_authenticated = entra;
          self.authentication_complete._emitir();
        }, RETRASO);
      }, RETRASO);
      return;
    }

    /* Fuera del escenario ?debecambiar=1: comportamiento de siempre. */
    if (!opciones.debeCambiar) {
      var correcta = respuesta === CLAVE_BUENA && opciones.fallo !== "acceso";
      window.setTimeout(function () {
        self.in_authentication = false;
        self.is_authenticated = correcta;
        self.authentication_complete._emitir();
      }, RETRASO);
      return;
    }

    /* Con ?debecambiar=1: tras la contraseña correcta, PAM exige cambiarla
       (como pam_sss con pwdReset+pwdMustChange). Reproduce lo comprobado en
       un equipo real: un aviso, una REPREGUNTA por la contraseña actual
       («Current Password: », en inglés, sin traducir) y sólo entonces las
       preguntas de la nueva y su confirmación — «New Password: » y
       «Retype new Password: » entregadas seguidas, sin esperar respuesta
       entre medias, tal cual se vio en /var/log/lightdm/lightdm.log. */
    if (this._pasoCambio === null) {
      var claveOk = respuesta === CLAVE_BUENA && opciones.fallo !== "acceso";
      if (!claveOk) {
        window.setTimeout(function () {
          self.in_authentication = false;
          self.is_authenticated = false;
          self.authentication_complete._emitir();
        }, RETRASO);
        return;
      }
      this._claveActual = respuesta;
      this._pasoCambio = "actual";
      window.setTimeout(function () {
        self.show_message._emitir("Password expired. Change your password now.", 1);
        window.setTimeout(function () {
          self.show_prompt._emitir("Current Password: ", 1);
        }, RETRASO);
      }, RETRASO);
      return;
    }

    if (this._pasoCambio === "actual") {
      if (respuesta !== this._claveActual) {
        window.setTimeout(function () {
          self.in_authentication = false;
          self.is_authenticated = false;
          self.authentication_complete._emitir();
        }, RETRASO);
        return;
      }
      this._pasoCambio = "nueva";
      window.setTimeout(function () {
        self.show_prompt._emitir("New Password: ", 1);
        self.show_prompt._emitir("Retype new Password: ", 1);
      }, RETRASO);
      return;
    }

    if (this._pasoCambio === "nueva") {
      /* La pregunta de «Retype» ya se emitió junto con esta (ver arriba): no
         se vuelve a emitir aquí, tal y como pasa de verdad. */
      this._nuevaClave = respuesta;
      this._pasoCambio = "repite";
      return;
    }

    /* this._pasoCambio === "repite" */
    var coincide = respuesta === this._nuevaClave;
    /* «Prohibida9$» simula un rechazo (política de calidad) que sí vuelve a
       preguntar, como pam_pwquality/pam_unix. «Repetida9$» simula que está
       en pwdHistory: comprobado en un equipo real que ESE rechazo no vuelve
       a preguntar — cierra la autenticación entera con un aviso, ver más
       abajo. El greeter no puede adivinar ninguno de los dos de antemano
       como sí hace con «igual a la actual». */
    var esNueva =
      this._nuevaClave !== this._claveActual &&
      this._nuevaClave !== "" &&
      this._nuevaClave !== "Prohibida9$" &&
      this._nuevaClave !== "Repetida9$";
    this._pasoCambio = null;

    if (coincide && esNueva) {
      window.setTimeout(function () {
        self.in_authentication = false;
        self.is_authenticated = true;
        self.authentication_complete._emitir();
      }, RETRASO);
      return;
    }

    if (coincide && this._nuevaClave === "Repetida9$") {
      /* Igual que un rechazo por pwdHistory real: un show_message con el
         motivo y, sin volver a preguntar nada, la autenticación entera
         termina en fallo. */
      window.setTimeout(function () {
        self.show_message._emitir(
          "Password change failed: Server message: Password is in history of old passwords",
          1
        );
        window.setTimeout(function () {
          self.in_authentication = false;
          self.is_authenticated = false;
          self.authentication_complete._emitir();
        }, RETRASO);
      }, RETRASO);
      return;
    }

    /* Rechazo: PAM avisa del motivo y vuelve a preguntar, igual que
       pam_pwquality/pam_unix con reintentos — no tumba la autenticación
       entera por una contraseña nueva inválida. */
    var motivo = !esNueva
      ? "BAD PASSWORD: la contraseña nueva no puede ser igual a la actual."
      : "Las dos contraseñas no coinciden.";
    this._pasoCambio = "nueva";
    window.setTimeout(function () {
      self.show_message._emitir(motivo, 1);
      window.setTimeout(function () {
        self.show_prompt._emitir("New Password: ", 1);
        self.show_prompt._emitir("Retype new Password: ", 1);
      }, RETRASO);
    }, RETRASO);
  };

  Greeter.prototype.cancel_authentication = function () {
    this.authentication_user = null;
    this.in_authentication = false;
    this.is_authenticated = false;
    this._pasoCambio = null;
    this._claveActual = "";
    this._nuevaClave = "";
    this.authentication_complete._emitir();
  };

  Greeter.prototype.cancel_autologin = function () {};
  Greeter.prototype.authenticate_as_guest = function () {};
  Greeter.prototype.set_language = function () {};

  Greeter.prototype.start_session = function (clave, callback) {
    var correcto = opciones.fallo !== "sesion";
    if (window.console && console.info) {
      console.info("[mock] start_session(" + clave + ") -> " + correcto);
    }
    if (correcto) {
      window.setTimeout(function () {
        document.body.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;' +
          'height:100vh;font:16px \'Open Sans\',sans-serif;color:#f0f1f5;' +
          'background:#14161d;text-align:center">Sesión «' +
          clave +
          '» iniciada.<br>Recargue la página para volver a empezar.</div>';
      }, 400);
    }
    if (typeof callback === "function") {
      window.setTimeout(function () {
        callback(correcto);
      }, RETRASO);
    }
    return correcto;
  };

  function apagado(nombre) {
    return function () {
      if (window.console && console.info) {
        console.info("[mock] " + nombre + "()");
      }
      window.setTimeout(function () {
        window.location.reload();
      }, 1200);
      return true;
    };
  }
  Greeter.prototype.shutdown = apagado("shutdown");
  Greeter.prototype.restart = apagado("restart");
  Greeter.prototype.suspend = apagado("suspend");
  Greeter.prototype.hibernate = apagado("hibernate");

  window.lightdm = new Greeter();

  window.greeter_config = {
    branding: { background_images_dir: "", logo_image: "", user_image: "" },
    greeter: {
      debug_mode: true,
      detect_theme_errors: true,
      screensaver_timeout: 300,
      secure_mode: true,
      theme: "recoverpass",
      icon_theme: null,
      time_language: null
    },
    features: { battery: false, backlight: { enabled: false, value: 10, steps: 0 } },
    layouts: []
  };

  window.theme_utils = {
    bind_this: function (contexto) {
      return contexto;
    },
    dirlist: function (ruta, soloImagenes, callback) {
      if (typeof callback === "function") {
        callback([]);
      }
    },
    dirlist_sync: function () {
      return [];
    },
    get_current_localized_time: function () {
      return new Date().toLocaleTimeString("es-ES", {
        hour: "2-digit",
        minute: "2-digit"
      });
    },
    get_current_localized_date: function () {
      return new Date().toLocaleDateString("es-ES");
    }
  };

  window._ready_event = new Event("GreeterReady");

  if (window.console && console.warn) {
    console.warn(
      "[mock] lightdm simulado activo. Contraseña de prueba: «" + CLAVE_BUENA + "»."
    );
  }

  window.addEventListener("DOMContentLoaded", function () {
    window.setTimeout(function () {
      window.dispatchEvent(window._ready_event);
    }, 2);
  });
})();
