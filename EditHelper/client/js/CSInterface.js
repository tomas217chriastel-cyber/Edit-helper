/*
 * Minimal CSInterface wrapper for Adobe CEP panels.
 * Exposes the subset of the standard CSInterface.js API this extension uses:
 * evalScript(), getSystemPath(), and hostEnvironment access. It talks to the
 * native `window.__adobe_cep__` object that the CEP runtime injects into every
 * panel's page - that object is what actually does the work; this file is
 * just a thin, documented convenience wrapper around it.
 */
function CSInterface() {}

CSInterface.SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
};

CSInterface.prototype.getHostEnvironment = function () {
    this.hostEnvironment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    return this.hostEnvironment;
};

CSInterface.prototype.evalScript = function (script, callback) {
    callback = callback || function () {};
    window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getSystemPath = function (pathType) {
    var path = "";
    try {
        path = JSON.parse(window.__adobe_cep__.getSystemPath(pathType)).path;
    } catch (e) {
        path = "";
    }
    return path;
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
    window.__adobe_cep__.addEventListener(type, listener, obj);
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
        window.cep.util.openURLInDefaultBrowser(url);
    } else {
        window.__adobe_cep__.invokeSync("openURLInDefaultBrowser", url);
    }
};
