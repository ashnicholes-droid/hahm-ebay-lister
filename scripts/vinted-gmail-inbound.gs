/**
 * Lee ventas confirmadas de Vinted, Poshmark y Depop y las envía solo al endpoint de la aplicación.
 * No envía, reenvía, modifica ni elimina correos.
 *
 * Permisos que debe pedir Google:
 * - Ver tus mensajes y ajustes de Gmail (gmail.readonly).
 * - Conectarse a un servicio externo (el endpoint de Vercel).
 * Si aparece "enviar" o "eliminar permanentemente", no lo aceptes: el manifiesto no está activo.
 *
 * Actualizar el proyecto
 * 1. En Configuración del proyecto, activa "Mostrar el archivo de manifiesto appsscript.json".
 * 2. Sustituye appsscript.json por scripts/vinted-gmail-appsscript.json.
 * 3. Sustituye Code.gs por este archivo y guarda ambos.
 * 4. En el editor, abre Servicios y comprueba que aparece Gmail API.
 *    Si no está, pulsa + y añade Gmail API.
 * 5. Abre https://myaccount.google.com/permissions y quita el acceso de este proyecto
 *    si lo autorizaste antes. Así desaparece el permiso amplio anterior.
 * 6. En Propiedades de la secuencia de comandos:
 *      APP_URL          https://hahm-ebay-lister-tau-one.vercel.app/api/vinted/inbound
 *      INBOUND_SECRET   el mismo valor que VINTED_INBOUND_SECRET en Vercel
 *      DRY_RUN          true
 *    No escribas el secreto en este archivo.
 * 7. Ejecuta baselineExistingSales. Solo guarda la hora de activación; no lee correos antiguos.
 * 8. El activador de checkVintedSales cada 10 minutos se crea solo después de confirmar
 *    la publicación. DRY_RUN debe seguir en true hasta esa confirmación.
 *    previewNewestVintedEmail siempre usa simulación y no envía Telegram.
 */

var ALLOWED_URL = "https://hahm-ebay-lister-tau-one.vercel.app/api/vinted/inbound";

function checkVintedSales() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty("BASELINED") !== "true") {
      baselineExistingSales();
      return;
    }
    var activatedAt = Date.parse(props.getProperty("ACTIVATED_AT") || "");
    if (!activatedAt) {
      Logger.log("Falta ACTIVATED_AT. Ejecuta baselineExistingSales.");
      return;
    }
    var dryRun = isDryRun_();
    var skip = loadIdSet_(dryRun ? "DRY_SEEN" : "PROCESSED");
    listCandidateIds_(activatedAt).forEach(function (id) {
      if (skip[id]) return;
      var email = readMessage_(id);
      if (!email || email.receivedMs < activatedAt) return;
      var result = postSale_(email, dryRun);
      Logger.log(JSON.stringify({
        messageId: id,
        dryRun: dryRun,
        status: result.status,
        body: result.body,
      }));
      if (dryRun && result.status === 200 && result.body && result.body.dryRun === true) {
        rememberId_("DRY_SEEN", id);
      }
      if (!dryRun && result.settled) rememberId_("PROCESSED", id);
    });
  } finally {
    lock.releaseLock();
  }
}

function baselineExistingSales() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("BASELINED") === "true" && props.getProperty("ACTIVATED_AT")) {
    Logger.log("La línea base ya existe. ACTIVATED_AT=" + props.getProperty("ACTIVATED_AT"));
    return;
  }
  var activatedAt = new Date();
  props.setProperty("ACTIVATED_AT", activatedAt.toISOString());
  props.setProperty("BASELINED", "true");
  if (!props.getProperty("DRY_RUN")) props.setProperty("DRY_RUN", "true");
  Logger.log("Línea base lista. No se leyeron ni modificaron correos. ACTIVATED_AT=" + activatedAt.toISOString());
}

/** Envía la venta nueva más reciente solo en dryRun y escribe la respuesta. */
function previewNewestVintedEmail() {
  var activatedAt = Date.parse(PropertiesService.getScriptProperties().getProperty("ACTIVATED_AT") || "");
  if (!activatedAt) {
    Logger.log("Ejecuta baselineExistingSales antes de la vista previa.");
    return;
  }
  var ids = listCandidateIds_(activatedAt);
  for (var i = 0; i < ids.length; i++) {
    var email = readMessage_(ids[i]);
    if (!email || email.receivedMs < activatedAt) continue;
    var result = postSale_(email, true);
    Logger.log(JSON.stringify({
      messageId: email.id,
      subject: email.subject,
      date: new Date(email.receivedMs).toISOString(),
      status: result.status,
      body: result.body,
    }));
    return;
  }
  Logger.log("No hay ventas nuevas desde la activación. No se envió ningún correo.");
}

function postSale_(email, dryRun) {
  var config = scriptConfig_();
  if (!config) return { status: 0, body: { ok: false, error: "Missing script properties" }, settled: false };
  var response = UrlFetchApp.fetch(config.url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + config.secret },
    muteHttpExceptions: true,
    followRedirects: false,
    validateHttpsCertificates: true,
    payload: JSON.stringify({
      messageId: email.id,
      from: email.from,
      subject: email.subject,
      text: email.text,
      html: email.html,
      date: new Date(email.receivedMs).toISOString(),
      dryRun: dryRun === true,
    }),
  });
  var status = response.getResponseCode();
  if (status >= 300 && status < 400) {
    Logger.log("La aplicación respondió con una redirección y no se siguió.");
    return { status: status, body: { ok: false, error: "Redirect blocked" }, settled: false };
  }
  var body = {};
  try {
    body = JSON.parse(response.getContentText() || "{}");
  } catch (error) {
    body = { ok: false, error: "Invalid response" };
  }
  return { status: status, body: body, settled: isSettled_(status, body) };
}

function listCandidateIds_(activatedAt) {
  var ids = [];
  var pageToken = "";
  for (var page = 0; page < 5 && ids.length < 50; page++) {
    var args = { q: vintedSearchQuery_(activatedAt), maxResults: 20 };
    if (pageToken) args.pageToken = pageToken;
    var listed = Gmail.Users.Messages.list("me", args);
    var messages = (listed && listed.messages) || [];
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].id) ids.push(messages[i].id);
    }
    pageToken = (listed && listed.nextPageToken) || "";
    if (!pageToken || !messages.length) break;
  }
  return ids;
}

function readMessage_(id) {
  var message = Gmail.Users.Messages.get("me", id, { format: "full" });
  if (!message) return null;
  var bodies = { "text/plain": "", "text/html": "" };
  collectText_(message.payload, bodies);
  return {
    id: message.id,
    from: headerValue_(message, "from"),
    subject: headerValue_(message, "subject"),
    text: String(bodies["text/plain"] || "").slice(0, 20000),
    html: bodies["text/plain"] ? "" : String(bodies["text/html"] || "").slice(0, 20000),
    receivedMs: Number(message.internalDate || "0"),
  };
}

function collectText_(part, found) {
  if (!part) return;
  var type = String(part.mimeType || "");
  if ((type === "text/plain" || type === "text/html") && part.body && part.body.data && !found[type]) {
    found[type] = decodeBase64Url_(part.body.data);
  }
  var parts = part.parts || [];
  for (var i = 0; i < parts.length; i++) collectText_(parts[i], found);
}

function headerValue_(message, name) {
  var headers = (message.payload && message.payload.headers) || [];
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name || "").toLowerCase() === name) return headers[i].value || "";
  }
  return "";
}

function decodeBase64Url_(data) {
  try {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString("UTF-8");
  } catch (error) {
    return "";
  }
}

function isSettled_(status, body) {
  if (status !== 200 || !body || body.ok !== true) return false;
  if (body.dryRun === true) return false;
  if (body.status === "needs_review") return false;
  return body.ignored === true || body.suppressed === true || body.duplicate === true || body.status === "sent";
}

function isDryRun_() {
  return String(PropertiesService.getScriptProperties().getProperty("DRY_RUN") || "true").toLowerCase() !== "false";
}

function scriptConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = String(props.getProperty("APP_URL") || "").trim();
  var secret = String(props.getProperty("INBOUND_SECRET") || "").trim();
  if (url !== ALLOWED_URL || !secret) {
    Logger.log("APP_URL debe ser exactamente el endpoint de Production y INBOUND_SECRET debe existir.");
    return null;
  }
  return { url: ALLOWED_URL, secret: secret };
}

function vintedSearchQuery_(activatedAt) {
  var day = Utilities.formatDate(new Date(activatedAt - 86400000), "America/New_York", "yyyy/MM/dd");
  return (
    "after:" +
    day +
    " ((from:vinted.com (sold OR vendido OR vendiste)) OR (from:poshmark.com (sold OR \"made a sale\" OR \"you sold\")) OR (from:depop.com (sold OR \"you sold\" OR \"you've sold\")))"
  );
}

function loadIdSet_(key) {
  var props = PropertiesService.getScriptProperties();
  var chunks = Number(props.getProperty(key + "_CHUNKS") || "0");
  var ids = {};
  for (var i = 0; i < chunks; i++) {
    String(props.getProperty(key + "_" + i) || "").split(",").forEach(function (id) {
      if (id) ids[id] = true;
    });
  }
  return ids;
}

function rememberId_(key, id) {
  if (!id || loadIdSet_(key)[id]) return;
  var props = PropertiesService.getScriptProperties();
  var chunks = Number(props.getProperty(key + "_CHUNKS") || "0");
  if (!chunks) {
    props.setProperty(key + "_0", id);
    props.setProperty(key + "_CHUNKS", "1");
    return;
  }
  var index = chunks - 1;
  var current = props.getProperty(key + "_" + index) || "";
  if ((current + "," + id).length > 8000) {
    props.setProperty(key + "_" + chunks, id);
    props.setProperty(key + "_CHUNKS", String(chunks + 1));
    return;
  }
  props.setProperty(key + "_" + index, current ? current + "," + id : id);
}
