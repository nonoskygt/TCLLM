// --init-script para el Playwright MCP de TCLLM (config playwright.blockLeaveDialogs, activo por defecto).
// Se ejecuta en cada página y cada iframe ANTES que los scripts del sitio.
//
// Impide que las páginas registren el evento "beforeunload", que es el que hace aparecer los cuadros de Chrome
// "¿Salir del sitio? Es posible que no se guarden los cambios" al navegar, al cerrar una pestaña o al cerrar el
// navegador. Esos cuadros dejaban a los agentes bloqueados esperando y trababan el cierre limpio del navegador
// (el que vuelca los logins al perfil). Contrapartida: un formulario a medio llenar se pierde sin aviso al salir.
(() => {
  try {
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === 'beforeunload' && this === window) return;   // solo el de la ventana; lo demás pasa igual
      return add.call(this, type, listener, options);
    };
    Object.defineProperty(window, 'onbeforeunload', { configurable: false, get: () => null, set: () => {} });
  } catch { /* página con CSP o contexto raro: no rompemos nada */ }
})();
