/*
 * Tema «recoverpass» para web-greeter — apariencia.
 *
 * Deriva la paleta de PRIMARY_COLOR y SECONDARY_COLOR y la aplica como
 * variables CSS sobre <html>.
 *
 * Está aparte de greeter.js —que por lo demás es un solo fichero a propósito—
 * porque index.html y secondary.html lo cargan en el <head>: así el primer
 * pintado ya sale con los colores configurados. Cuando esto lo hacía greeter.js
 * al arrancar (que espera al evento GreeterReady, y va al final del <body>) se
 * veía un fogonazo de unos milisegundos con la paleta de reserva de style.css,
 * que es oscura y violeta.
 *
 * Sólo toca document.documentElement: en el <head> el <body> aún no existe. No
 * usa el objeto lightdm ni espera ningún evento, y todo va en try/catch: si
 * fallara, la pantalla se queda con la paleta de reserva y el acceso sigue
 * funcionando igual.
 */
(function () {
  "use strict";

  /* Sólo lo que hace falta para la paleta. El resto de la configuración lo
     gestiona greeter.js con su propio CONFIG_POR_DEFECTO; estos tres valores
     tienen que coincidir con los de allí. */
  var PREDETERMINADOS = {
    imagenFondo: "",
    colorPrimario: "#1565C0",
    colorSecundario: "#FFFFFF"
  };

  /* Como registrar() de greeter.js pero con console.warn: cualquier
     console.error abre un diálogo de web-greeter (browser/error_prompt.py)
     encima de la pantalla de acceso, y un problema de colores no lo merece. */
  function avisar(texto, error) {
    try {
      if (window.console && console.warn) {
        console.warn("[recoverpass] " + texto, error === undefined ? "" : error);
      }
    } catch (e) {
      /* sin consola no hay nada que hacer */
    }
  }

  function configuracion() {
    var c = window.RECOVERPASS_CONFIG;
    var salida = {};
    for (var clave in PREDETERMINADOS) {
      if (Object.prototype.hasOwnProperty.call(PREDETERMINADOS, clave)) {
        salida[clave] =
          !c || c[clave] === undefined || c[clave] === null ? PREDETERMINADOS[clave] : c[clave];
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
  function aplicar() {
    var c = configuracion();
    var raiz = document.documentElement;

    var primario = aRgb(c.colorPrimario) || aRgb(PREDETERMINADOS.colorPrimario);
    var secundario = aRgb(c.colorSecundario) || aRgb(PREDETERMINADOS.colorSecundario);

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
          avisar("no se pudo aplicar " + nombreVar, error);
        }
      }
    }

    if (c.imagenFondo) {
      try {
        raiz.style.setProperty("--imagen-fondo", 'url("' + c.imagenFondo + '")');
        /* La marca va en <html> y no en <body>: esto se ejecuta desde el
           <head> y el <body> todavía no existe. Los selectores de style.css
           son «.con-imagen body …» por eso mismo. */
        if (raiz.className.indexOf("con-imagen") === -1) {
          raiz.className = (raiz.className ? raiz.className + " " : "") + "con-imagen";
        }
      } catch (error) {
        avisar("no se pudo aplicar la imagen de fondo", error);
      }
    }
  }

  window.RECOVERPASS_APARIENCIA = { aplicar: aplicar };

  try {
    aplicar();
  } catch (error) {
    avisar("no se pudo aplicar la apariencia", error);
  }
})();
