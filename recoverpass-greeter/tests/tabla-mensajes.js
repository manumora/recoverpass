#!/usr/bin/env node
/* Prueba de TRADUCCIONES_MENSAJE_PAM, la tabla que traduce al castellano los
 * avisos que PAM manda por show_message.
 *
 *     cd recoverpass-greeter && node tests/tabla-mensajes.js
 *
 * Sale con 0 si todo pasa y con el número de fallos si no. No tiene
 * dependencias: sólo hace falta Node, y sólo para lanzar esta prueba. El
 * paquete no necesita Node para nada.
 *
 * POR QUÉ EXISTE
 *
 * En esa tabla gana la PRIMERA fila que encaja, así que el orden es parte del
 * comportamiento y no una cuestión de estilo. Al añadir los rechazos de
 * pam_pwquality aparecieron dos errores del mismo tipo: cracklib devuelve casi
 * todas sus razones envueltas en la misma cadena,
 *
 *     BAD PASSWORD: The password fails the dictionary check - <razón>
 *
 * así que «it is WAY too short» y «it is based on your username» contienen
 * también el texto del diccionario. Con la fila del diccionario colocada antes
 * de las concretas, a quien ponía una contraseña corta se le decía que había
 * usado una palabra del diccionario. Esta prueba fija ese orden.
 *
 * Si se toca el orden de la tabla, hay que volver a lanzarla.
 */

"use strict";

var fs = require("fs");
var path = require("path");

var RUTA_TEMA = path.join(__dirname, "..", "theme", "js", "greeter.js");
/* Sólo informativo: si no cuadra se avisa, pero no se falla. Añadir una fila
   legítima no debe romper la prueba. */
var FILAS_ESPERADAS = 26;

var ROJO = "[31m";
var VERDE = "[32m";
var AMARILLO = "[33m";
var FIN = "[0m";

var fallos = 0;
var avisos = 0;

function falla(texto) {
  console.log(ROJO + "  FALLA" + FIN + " " + texto);
  fallos++;
}

function ok(texto) {
  console.log(VERDE + "  OK" + FIN + "   " + texto);
}

function avisa(texto) {
  console.log(AMARILLO + "  AVISO" + FIN + " " + texto);
  avisos++;
}

function aborta(texto) {
  console.log(ROJO + "  FALLA" + FIN + " " + texto);
  console.log(
    "\n" + ROJO + "La prueba no ha podido leer la tabla, así que NO ha comprobado nada." + FIN
  );
  console.log("Revise " + RUTA_TEMA + ": ¿se ha renombrado la tabla o cambiado su formato?");
  process.exit(1);
}

/* --- Sacar la tabla de greeter.js ------------------------------------------
   La tabla vive dentro de la IIFE del tema y no está exportada. Extraerla
   recortando el fichero es más barato que refactorizar código que corre en la
   pantalla de acceso, pero tiene un riesgo: que alguien renombre la variable y
   esta prueba deje de comprobar nada sin avisar. De ahí que cada paso que no
   encuentre lo que busca llame a aborta() y salga con error, nunca en vacío. */

var fuente;
try {
  fuente = fs.readFileSync(RUTA_TEMA, "utf8");
} catch (error) {
  aborta("no se puede leer " + RUTA_TEMA + ": " + error.message);
}

function constanteDeTexto(nombre) {
  var regla = new RegExp("var\\s+" + nombre + '\\s*=\\s*"([^"]*)"');
  var encontrado = regla.exec(fuente);
  if (!encontrado) {
    aborta("no se encuentra la constante " + nombre + " en greeter.js");
  }
  return encontrado[1];
}

/* Los valores se leen del propio tema en vez de repetirlos aquí: si cambian,
   la prueba los sigue. */
var CTX_ACCESO = constanteDeTexto("CTX_ACCESO");
var CTX_CAMBIO = constanteDeTexto("CTX_CAMBIO");
var CTX_AMBOS = constanteDeTexto("CTX_AMBOS");

var ANCLA_INICIO = "var TRADUCCIONES_MENSAJE_PAM = [";
var ANCLA_FIN = "\n  ];";

var inicio = fuente.indexOf(ANCLA_INICIO);
if (inicio === -1) {
  aborta("no se encuentra «" + ANCLA_INICIO + "» en greeter.js");
}
var fin = fuente.indexOf(ANCLA_FIN, inicio);
if (fin === -1) {
  aborta("no se encuentra el cierre de la tabla («\\n  ];») tras la declaración");
}

var literal = fuente.slice(inicio + ANCLA_INICIO.length - 1, fin + "\n  ]".length);

var TABLA;
try {
  /* new Function en vez de eval para pasarle las constantes de contexto como
     argumentos, sin juegos de ámbito. */
  var fabricar = new Function(
    "CTX_ACCESO",
    "CTX_CAMBIO",
    "CTX_AMBOS",
    "return " + literal + ";"
  );
  TABLA = fabricar(CTX_ACCESO, CTX_CAMBIO, CTX_AMBOS);
} catch (error) {
  aborta("el literal de la tabla no se puede evaluar: " + error.message);
}

if (!Array.isArray(TABLA) || TABLA.length === 0) {
  aborta("la tabla extraída no es un array con filas");
}

console.log("\n" + AMARILLO + "== Tabla de traducciones de PAM ==" + FIN);
ok("tabla leída de greeter.js: " + TABLA.length + " filas");
if (TABLA.length !== FILAS_ESPERADAS) {
  avisa(
    "se esperaban " + FILAS_ESPERADAS + " filas y hay " + TABLA.length +
      ". Si el cambio es intencionado, actualice FILAS_ESPERADAS."
  );
}

/* --- La selección de fila --------------------------------------------------
   Se reimplementa a propósito, en vez de extraer traducirMensajePam(): lo que
   esta prueba fija es el contrato «filtrar por contexto y ganar la primera que
   encaje», que es de donde salieron los dos errores. Si la implementación real
   dejara de cumplirlo, esta prueba tiene que seguir diciendo lo que se espera. */
function elegirFila(texto, contexto) {
  for (var i = 0; i < TABLA.length; i++) {
    var fila = TABLA[i];
    if (fila.contexto !== CTX_AMBOS && fila.contexto !== contexto) {
      continue;
    }
    if (fila.prueba.test(texto)) {
      return { indice: i, fila: fila };
    }
  }
  return null;
}

var alcanzadas = {};

/* Resumen de un apartado: sólo dice «OK» si el apartado no ha sumado fallos.
   Sin esto se imprimía un OK tranquilizador justo debajo de sus propios
   fallos. */
function resumen(fallosAntes, texto) {
  if (fallos === fallosAntes) {
    ok(texto);
  }
}

function comprueba(texto, contexto, fragmento) {
  var elegida = elegirFila(texto, contexto);
  if (!elegida) {
    falla('ninguna fila encaja con «' + texto + '»');
    return null;
  }
  alcanzadas[elegida.indice] = true;
  if (elegida.fila.texto.indexOf(fragmento) === -1) {
    falla(
      '«' + texto + '»\n         ha ganado la fila ' + elegida.indice + ' («' +
        elegida.fila.texto + '»)\n         y se esperaba una que dijera «' + fragmento + '»'
    );
  }
  return elegida;
}

/* --- 1. Las razones de cracklib -------------------------------------------
   El corazón de la prueba. Todas llegan envueltas en el texto del diccionario,
   así que cada una tiene que ganar su fila concreta y NO la del diccionario. */

console.log("\n" + AMARILLO + "-- 1. Razones de cracklib (todas envueltas) --" + FIN);

var fallosCracklib = fallos;
var DIC = "BAD PASSWORD: The password fails the dictionary check - ";
var cracklib = [
  ["it is WAY too short", "demasiado corta"],
  ["it is too short", "demasiado corta"],
  ["it is based on your username", "nombre de usuario"],
  ["it is too simplistic/systematic", "previsible"],
  ["it is all whitespace", "espacios"],
  ["it does not contain enough DIFFERENT characters", "repite"],
  ["it looks like a National Insurance number.", "identificación"],
  /* Estas dos sí deben caer en la fila del diccionario, que es la reserva del
     grupo: una por su literal propio y la otra porque no tiene fila específica. */
  ["it is based on a dictionary word", "palabra del diccionario"],
  ["it is based upon your password entry", "palabra del diccionario"]
];
cracklib.forEach(function (caso) {
  comprueba(DIC + caso[0], CTX_CAMBIO, caso[1]);
});
resumen(fallosCracklib, "las " + cracklib.length + " subrazones de cracklib comprobadas");

/* --- 2. Las razones propias de libpwquality, sin envolver ------------------ */

console.log("\n" + AMARILLO + "-- 2. Razones propias de libpwquality --" + FIN);

var fallosPropias = fallos;
var propias = [
  ["The password is shorter than 12 characters", "demasiado corta"],
  ["The password is the same as the old one", "igual a la actual"],
  ["The password is too similar to the old one", "se parece demasiado"],
  ["The password differs with case changes only", "se parece demasiado"],
  ["The password contains the user name in some form", "nombre de usuario"],
  ["The password contains forbidden words in some form", "no admite"],
  ["The password contains too long of a monotonic character sequence", "repite"],
  ["The password contains more than 3 same characters consecutively", "repite"],
  ["The password is a palindrome", "del revés"],
  ["The password contains less than 1 digits", "un número"],
  ["The password contains less than 1 uppercase letters", "mayúscula"],
  ["The password contains less than 1 lowercase letters", "minúscula"],
  ["The password contains less than 1 non-alphanumeric characters", "un símbolo"],
  ["The password contains less than 3 character classes", "combinar"]
];
propias.forEach(function (caso) {
  comprueba("BAD PASSWORD: " + caso[0], CTX_CAMBIO, caso[1]);
});
resumen(fallosPropias, "las " + propias.length + " razones de libpwquality comprobadas");

/* --- 3. La fila de último recurso ----------------------------------------- */

console.log("\n" + AMARILLO + "-- 3. Último recurso --" + FIN);

var desconocido = comprueba(
  "BAD PASSWORD: some reason nobody has seen yet",
  CTX_CAMBIO,
  "fácil de adivinar"
);
if (desconocido) {
  if (desconocido.fila.anotar === true) {
    ok("la fila de último recurso lleva «anotar», así que el literal se registra");
  } else {
    falla(
      "la fila de último recurso (" + desconocido.indice + ") no lleva «anotar»: " +
        "el literal original se perdería y no habría con qué ampliar la tabla"
    );
  }
}

/* --- 4. Lo que ya traducía antes: ppolicy, pam_sss y pam_unix -------------- */

console.log("\n" + AMARILLO + "-- 4. ppolicy, pam_sss y pam_unix --" + FIN);

var fallosPrevios = fallos;
var previos = [
  [
    "Password change failed: Server message: Password is in history of old passwords",
    CTX_CAMBIO,
    "ya se ha usado"
  ],
  [
    "Password change failed: Server message: Password fails quality checking policy",
    CTX_CAMBIO,
    "calidad del directorio"
  ],
  ["Sorry, passwords do not match.", CTX_CAMBIO, "no coinciden"],
  /* Los dos literales de la fila de «no se pudo verificar la actual».
     «Invalid credentials» sólo se traduce en el cambio, nunca en el acceso: ahí
     es ambiguo y cae en el genérico (ver el apartado 5). */
  ["Old password not accepted", CTX_CAMBIO, "verificar la contraseña actual"],
  ["Invalid credentials", CTX_CAMBIO, "verificar la contraseña actual"],
  ["Password expired. Change your password now.", CTX_ACCESO, "ha caducado"],
  ["Account is locked", CTX_ACCESO, "bloqueada"],
  ["Account is disabled", CTX_ACCESO, "desactivada"],
  ["Your account has expired; please contact your system administrator", CTX_ACCESO, "ha expirado"],
  ["Your password will expire in 7 days.", CTX_ACCESO, "caducará pronto"]
];
previos.forEach(function (caso) {
  comprueba(caso[0], caso[1], caso[2]);
});
resumen(fallosPrevios, "los " + previos.length + " literales de ppolicy y pam_sss comprobados");

/* --- 5. Los que NO se traducen a propósito -------------------------------- */

console.log("\n" + AMARILLO + "-- 5. Sin traducción a propósito (acceso) --" + FIN);

/* Decisión de diseño explícita del tema: decir «su cuenta está bloqueada» a
   quien sólo se ha equivocado de contraseña es peor que no decir nada. Estos
   tienen que seguir sin encajar con ninguna fila en el contexto de acceso. */
var fallosSinTraducir = fallos;
var sinTraducir = [
  "Permission denied.",
  "Authentication failure",
  "Access denied for this service.",
  "System is offline, please try later"
];
sinTraducir.forEach(function (texto) {
  var elegida = elegirFila(texto, CTX_ACCESO);
  if (elegida) {
    falla(
      '«' + texto + '» ya no cae en el genérico del acceso: encaja con la fila ' +
        elegida.indice + ' («' + elegida.fila.texto + '»)'
    );
  }
});
resumen(fallosSinTraducir, "los " + sinTraducir.length + " literales ambiguos siguen sin traducirse en el acceso");

/* --- 6. Filas que ninguna cadena de prueba alcanza ------------------------ */

console.log("\n" + AMARILLO + "-- 6. Cobertura de la tabla --" + FIN);

var huerfanas = [];
for (var i = 0; i < TABLA.length; i++) {
  if (!alcanzadas[i]) {
    huerfanas.push(i + " (" + TABLA[i].prueba + ")");
  }
}
if (huerfanas.length === 0) {
  ok("todas las filas se alcanzan con alguna cadena de prueba");
} else {
  /* Aviso y no fallo: hay filas deliberadamente defensivas, para equipos con un
     pwquality.conf más estricto que la lista que pinta el tema. Pero una fila
     inalcanzable también es la forma que tenía el error corregido: una fila
     tapada por otra anterior. Conviene mirar cada una. */
  avisa("filas sin alcanzar (revise si alguna está tapada por otra anterior):");
  huerfanas.forEach(function (fila) {
    console.log("         " + fila);
  });
}

/* --- Resultado ------------------------------------------------------------ */

console.log("\n" + AMARILLO + "== Resultado ==" + FIN);
if (fallos === 0) {
  console.log(
    VERDE + "Todas las comprobaciones han pasado." + FIN +
      (avisos ? " (" + avisos + " aviso" + (avisos === 1 ? "" : "s") + ")" : "")
  );
} else {
  console.log(ROJO + fallos + " comprobaciones han fallado." + FIN);
}
process.exit(fallos);
