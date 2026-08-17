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
 *
 * La contraseña de los usuarios simulados es «demo».
 */
(function () {
  "use strict";

  if (window._ready_event !== undefined || typeof qt !== "undefined") {
    return; /* estamos dentro del greeter de verdad */
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
    conUsuarios: parametro("usuarios") !== "0"
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

    var correcta = respuesta === CLAVE_BUENA && opciones.fallo !== "acceso";
    window.setTimeout(function () {
      self.in_authentication = false;
      self.is_authenticated = correcta;
      self.authentication_complete._emitir();
    }, RETRASO);
  };

  Greeter.prototype.cancel_authentication = function () {
    this.authentication_user = null;
    this.in_authentication = false;
    this.is_authenticated = false;
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
