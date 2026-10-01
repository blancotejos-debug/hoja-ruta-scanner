/**
 * ============================================================
 * BACKEND — Escáner de Hoja de Ruta
 * ============================================================
 * Qué hace:
 *   1. Recibe la foto del documento desde la app del celular.
 *   2. La guarda en una carpeta de Google Drive (respaldo).
 *   3. La convierte temporalmente a Google Doc con OCR para leer el texto
 *      y extraer los campos (Hoja de Ruta, Orden de venta, vehículo, etc.).
 *   4. Cuando el usuario confirma los datos en el celular, agrega una fila
 *      a una planilla de Google Sheets (la "base de datos").
 *
 * PRIMEROS PASOS (una sola vez):
 *   1. Abre este proyecto en https://script.google.com (ver README.md).
 *   2. Menú "Servicios" (ícono +) -> agrega el servicio avanzado "Drive API"
 *      (déjalo como "Drive", versión v3).
 *   3. En el editor, selecciona la función "setup" en el menú desplegable de
 *      arriba y presiona "Ejecutar". La primera vez pedirá autorización.
 *   4. Abre "Ver > Registro de ejecución" (o Ctrl+Enter) y copia el
 *      API_TOKEN que se imprime ahí.
 *   5. Despliega como aplicación web (Implementar > Nueva implementación):
 *        - Tipo: Aplicación web
 *        - Ejecutar como: Yo (tu cuenta)
 *        - Quién tiene acceso: Cualquier usuario
 *      Copia la URL que termina en /exec.
 *   6. Pega esa URL y el API_TOKEN en js/config.js del frontend.
 * ============================================================
 */

// ------------------------------------------------------------
// CONFIGURACIÓN INICIAL — correr una sola vez desde el editor
// ------------------------------------------------------------
function setup() {
  const props = PropertiesService.getScriptProperties();

  let sheetId = props.getProperty("SHEET_ID");
  if (!sheetId) {
    const ss = SpreadsheetApp.create("Hojas de Ruta - Registros");
    const sheet = ss.getSheets()[0];
    sheet.setName("Registros");
    sheet.appendRow([
      "Fecha de registro",
      "Hoja de Ruta",
      "Orden(es) de venta",
      "Vehículo / Conductor",
      "Fecha de despacho",
      "Cliente",
      "Total Volumen y Peso",
      "Casa Matriz",
      "Foto (Drive)",
      "ID archivo Drive",
    ]);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 10);
    sheetId = ss.getId();
    props.setProperty("SHEET_ID", sheetId);
  }

  let folderId = props.getProperty("DRIVE_FOLDER_ID");
  if (!folderId) {
    const folder = DriveApp.createFolder("Hojas de Ruta - Fotos");
    folderId = folder.getId();
    props.setProperty("DRIVE_FOLDER_ID", folderId);
  }

  let token = props.getProperty("API_TOKEN");
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty("API_TOKEN", token);
  }

  const sheetUrl = "https://docs.google.com/spreadsheets/d/" + sheetId;
  const folderUrl = "https://drive.google.com/drive/folders/" + folderId;

  Logger.log("========================================================");
  Logger.log("CONFIGURACIÓN LISTA — copia esto a js/config.js del frontend:");
  Logger.log("API_TOKEN: " + token);
  Logger.log("(la APPS_SCRIPT_URL se obtiene al desplegar como app web, ver paso 5)");
  Logger.log("--------------------------------------------------------");
  Logger.log("Planilla (base de datos): " + sheetUrl);
  Logger.log("Carpeta de respaldo de fotos: " + folderUrl);
  Logger.log("========================================================");
}

// ------------------------------------------------------------
// ENDPOINTS HTTP
// ------------------------------------------------------------
function doGet() {
  return ContentService
    .createTextOutput("Backend Escáner Hoja de Ruta activo.")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut({ success: false, error: "Solicitud vacía" });
    }
    const payload = JSON.parse(e.postData.contents);

    const props = PropertiesService.getScriptProperties();
    const expectedToken = props.getProperty("API_TOKEN");
    if (!expectedToken) {
      return jsonOut({ success: false, error: "Backend sin configurar: corre setup() primero" });
    }
    if (payload.token !== expectedToken) {
      return jsonOut({ success: false, error: "No autorizado" });
    }

    if (payload.action === "extract") return jsonOut(handleExtract(payload));
    if (payload.action === "save") return jsonOut(handleSave(payload));
    return jsonOut({ success: false, error: "Acción desconocida: " + payload.action });
  } catch (err) {
    return jsonOut({ success: false, error: String(err && err.message ? err.message : err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// ACCIÓN: extract — guarda la foto y lee los campos con OCR
// ------------------------------------------------------------
function handleExtract(payload) {
  if (!payload.imageBase64) return { success: false, error: "Falta la imagen" };

  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty("DRIVE_FOLDER_ID");
  if (!folderId) return { success: false, error: "Backend sin configurar: corre setup() primero" };
  const folder = DriveApp.getFolderById(folderId);

  const bytes = Utilities.base64Decode(payload.imageBase64);
  const stamp = Utilities.formatDate(new Date(), tz(), "yyyyMMdd_HHmmss");
  const blob = Utilities.newBlob(bytes, "image/jpeg", "pendiente_" + stamp + ".jpg");

  // Se guarda de inmediato: esto es el respaldo, independiente de si el OCR funciona o no.
  const backupFile = folder.createFile(blob);

  let text = "";
  let warnings = [];
  try {
    text = ocrImageToText(blob);
  } catch (err) {
    Logger.log("OCR falló: " + err);
    warnings.push("ocr_failed");
  }

  const parsed = parseFields(text);
  warnings = warnings.concat(parsed.warnings);

  return {
    success: true,
    driveFileId: backupFile.getId(),
    fields: parsed.fields,
    warnings: warnings,
  };
}

// Convierte la imagen a un Google Doc temporal con OCR, lee el texto y borra el temporal.
// Requiere el servicio avanzado "Drive API" (Drive, v3) habilitado en el proyecto.
function ocrImageToText(blob) {
  const resource = { name: "ocr_temp_" + Date.now(), mimeType: MimeType.GOOGLE_DOCS };
  const tempFile = Drive.Files.create(resource, blob, { ocr: true, ocrLanguage: "es" });
  try {
    const doc = DocumentApp.openById(tempFile.id);
    return doc.getBody().getText();
  } finally {
    deleteDriveFileSafe(tempFile.id);
  }
}

function deleteDriveFileSafe(fileId) {
  try {
    Drive.Files.remove(fileId);
  } catch (e1) {
    try {
      Drive.Files.delete(fileId);
    } catch (e2) {
      Logger.log("No se pudo borrar el archivo temporal de OCR: " + fileId);
    }
  }
}

// ------------------------------------------------------------
// ACCIÓN: save — guarda la fila confirmada en la planilla
// ------------------------------------------------------------
function handleSave(payload) {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty("SHEET_ID");
  const folderId = props.getProperty("DRIVE_FOLDER_ID");
  if (!sheetId || !folderId) return { success: false, error: "Backend sin configurar: corre setup() primero" };

  const fields = payload.fields || {};
  const folder = DriveApp.getFolderById(folderId);

  // La foto ya debería existir en Drive (subida durante "extract"). Si no llega el id
  // (por ejemplo, un registro que quedó en la cola sin conexión), se sube ahora.
  let file = null;
  if (payload.driveFileId) {
    try {
      file = DriveApp.getFileById(payload.driveFileId);
    } catch (err) {
      file = null;
    }
  }
  if (!file && payload.imageBase64) {
    const bytes = Utilities.base64Decode(payload.imageBase64);
    const stamp = Utilities.formatDate(new Date(), tz(), "yyyyMMdd_HHmmss");
    const blob = Utilities.newBlob(bytes, "image/jpeg", "foto_" + stamp + ".jpg");
    file = folder.createFile(blob);
  }
  if (!file) return { success: false, error: "No hay foto asociada a este registro" };

  const safeHoja = String(fields.hojaRuta || "SIN_HR").replace(/[^A-Za-z0-9_-]/g, "_");
  const stamp2 = Utilities.formatDate(new Date(), tz(), "yyyyMMdd_HHmmss");
  try {
    file.setName(safeHoja + "_" + stamp2 + ".jpg");
  } catch (err) {
    // no crítico si falla el renombrado
  }

  const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
  sheet.appendRow([
    new Date(),
    fields.hojaRuta || "",
    fields.ordenVenta || "",
    fields.vehiculoConductor || "",
    fields.fechaDespacho || "",
    fields.cliente || "",
    fields.totalVolumenPeso || "",
    fields.casaMatriz || "",
    file.getUrl(),
    file.getId(),
  ]);

  return { success: true, driveUrl: file.getUrl() };
}

function tz() {
  return Session.getScriptTimeZone() || "America/Santiago";
}

// ------------------------------------------------------------
// Extracción de campos por expresiones regulares
// Ajustado al formato de "Hoja de Ruta" de DIPISA. Si tus documentos
// cambian de formato, ajusta estos patrones — de todas formas el usuario
// siempre revisa y corrige los campos antes de guardar.
// ------------------------------------------------------------
function parseFields(rawText) {
  const text = String(rawText || "").replace(/\r/g, "");
  const warnings = [];

  function firstMatch(patterns) {
    for (let i = 0; i < patterns.length; i++) {
      const m = text.match(patterns[i]);
      if (m) return (m[1] || m[0]).trim();
    }
    return "";
  }

  const hojaRuta = firstMatch([
    /Hoja de Ruta[\s\S]{0,40}?#?\s*(HR ?\d{4,})/i,
    /#\s*(HR ?\d{4,})/i,
    /\b(HR ?\d{4,})\b/i,
  ]).replace(/\s+/g, "");

  let casaMatriz = firstMatch([
    /Casa Matriz\s*\(Dipisa\)\s*:?\s*([^\n]+)/i,
    /Casa Matriz\s*:?\s*([^\n]+)/i,
  ]);
  // corta si el OCR pegó la fecha de la esquina a continuación del nombre de la bodega
  casaMatriz = casaMatriz.replace(/\s{2,}\d{1,2}\/\d{1,2}\/\d{2,4}.*$/, "").trim();

  const vehiculoConductor = firstMatch([/Veh[ií]culo\s*:?\s*([^\n]+)/i]).trim();

  const fechaDespacho = firstMatch([
    /Fecha y hora de despacho\s*:?\s*([^\n]+)/i,
    /Fecha de despacho\s*:?\s*([^\n]+)/i,
  ]).trim();

  const totalVolumenPeso = firstMatch([/Total Volumen y Peso\s*:?\s*([\d.,]+)/i]).trim();

  // Orden de venta: en la tabla cada fila trae primero el N° de "Factura de venta" y
  // luego el de "Orden de venta" (#DIPxxxxx). Por eso, de cada línea que contenga uno o
  // más números #DIP, se toma el ÚLTIMO como Orden de venta. Puede haber varias líneas
  // (una por pedido dentro de la misma Hoja de Ruta); se listan todas separadas por coma
  // y el usuario elimina/corrige las que no correspondan.
  const ordenVentaSet = [];
  text.split("\n").forEach(function (line) {
    const nums = [];
    const reDip = /#\s*(DIP\s?\d{4,})/gi;
    let m;
    while ((m = reDip.exec(line)) !== null) nums.push(m[1].replace(/\s+/g, ""));
    if (nums.length) {
      const v = nums[nums.length - 1];
      if (ordenVentaSet.indexOf(v) === -1) ordenVentaSet.push(v);
    }
  });
  const ordenVenta = ordenVentaSet.join(", ");

  // Cliente: nombres de empresa que terminan en "S.A.", "S.A.P", "LTDA" o "LIMITADA"
  // (con al menos dos palabras antes del sufijo, para no confundir siglas sueltas como
  // "DIPISA"). Se ignora la línea "Transportista:" porque esa es la propia transportista,
  // no el cliente, y se recorta cualquier código numérico que haya quedado pegado adelante
  // (por ejemplo un N° de Orden de venta en la misma línea de la tabla).
  let cliente = "";
  const clienteRe = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9&]*(?:\s[A-ZÁÉÍÓÚÑ0-9&]+)+\s(?:S\.A\.(?:P\.?)?|LTDA\.?|LIMITADA))\b/;
  for (const line of text.split("\n")) {
    if (/^\s*Transportista/i.test(line)) continue;
    const m = line.match(clienteRe);
    if (m) {
      const words = m[1].split(/\s+/);
      while (words.length && /\d/.test(words[0])) words.shift();
      const candidate = words.join(" ").replace(/\s{2,}/g, " ").trim();
      if (candidate) {
        cliente = candidate;
        break;
      }
    }
  }

  const fields = {
    hojaRuta: hojaRuta,
    ordenVenta: ordenVenta,
    vehiculoConductor: vehiculoConductor,
    fechaDespacho: fechaDespacho,
    cliente: cliente,
    totalVolumenPeso: totalVolumenPeso,
    casaMatriz: casaMatriz,
  };

  Object.keys(fields).forEach(function (k) {
    if (!fields[k]) warnings.push(k);
  });

  return { fields: fields, warnings: warnings };
}

// ------------------------------------------------------------
// Prueba manual del parser sin necesidad de una foto real:
// selecciona "testParseFields" en el editor y ejecútala; el resultado
// queda en el Registro de ejecución.
// ------------------------------------------------------------
function testParseFields() {
  const sample = [
    "DIPISA",
    "HR0082193",
    "Transportista: TRANSPORTES GODOY Y BLANCO LIMITADA",
    "Vehiculo: VLLV-42/Kyliams López",
    "Fecha y hora de despacho: 4 sept 2026, 8:45:44 a. m.",
    "Casa Matriz (Dipisa) : DIP BODEGA AEROPARQUE                    04/09/2026",
    "Observaciones:",
    "Docto Pedido Cliente Dirección/Cond. Venta Kilos",
    "Factura de venta Orden de venta EMPRESA EL MERCURIO S.A.P EMPRESA EL MERCURIO S.A.P VICTOR URIBE 2281 4021.32",
    "#DIP191034 #DIP192467 90193000/0 SISTEMA GRAFICO QUILICURA",
    "Factura de venta Orden de venta EMPRESA EL MERCURIO S.A.P ... 3364.216",
    "#DIP191035 #DIP192205 90193000/0",
    "Total Volumen y Peso: 7.385,536",
  ].join("\n");
  // Resultado esperado: hojaRuta=HR0082193, ordenVenta="DIP192467, DIP192205",
  // vehiculoConductor="VLLV-42/Kyliams López", cliente="EMPRESA EL MERCURIO S.A.P",
  // totalVolumenPeso="7.385,536", casaMatriz="DIP BODEGA AEROPARQUE", sin warnings.
  Logger.log(JSON.stringify(parseFields(sample), null, 2));
}
