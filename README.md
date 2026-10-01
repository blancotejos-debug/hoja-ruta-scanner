# Escáner de Hoja de Ruta

App web (instalable como app en el celular) para fotografiar la Hoja de Ruta de DIPISA,
extraer automáticamente los datos y guardarlos en Google Sheets, con la foto respaldada
en Google Drive.

## Qué hace

1. Abre la cámara, detecta los bordes del documento en vivo (como Adobe Scan) y dibuja el contorno.
2. Si falta luz, enciende la linterna automáticamente (**solo funciona en Android/Chrome** — ver
   "Limitaciones" más abajo).
3. Cuando el documento está bien encuadrado y estable, toma la foto sola; también hay un botón
   para capturar manualmente en cualquier momento.
4. Endereza y recorta la foto al tamaño del documento.
5. Envía la foto al backend, que la guarda en Drive y usa OCR para leer:
   Hoja de Ruta, Orden(es) de venta, Vehículo/Conductor, Fecha de despacho, Cliente,
   Total Volumen y Peso, Casa Matriz.
6. Muestra un formulario editable para revisar/corregir esos datos antes de guardar (el OCR
   nunca es 100% exacto).
7. Al guardar, agrega una fila a una planilla de Google Sheets y deja la foto como respaldo
   permanente en Drive.
8. Si no hay conexión, el registro queda guardado en el celular y se reintenta enviar solo
   cuando vuelve internet (ver "Historial" en la app).

## Arquitectura

- **Frontend**: carpeta raíz — HTML/CSS/JS puro (sin build, sin frameworks), es una PWA
  (Progressive Web App) instalable. Se publica en cualquier hosting estático con HTTPS
  (GitHub Pages, por ejemplo).
- **Backend**: carpeta `apps-script/` — un proyecto de Google Apps Script que hace de API
  (recibe la foto, corre OCR, guarda en Drive y en Sheets). No hay servidor propio que
  mantener: corre en la infraestructura de Google, gratis para este volumen de uso.

```
Celular (PWA) --HTTPS--> Google Apps Script --> Google Drive (fotos)
                                              --> Google Sheets (datos)
```

---

## Paso 1 — Crear el backend en Google Apps Script

1. Ve a [script.google.com](https://script.google.com) → **Proyecto nuevo**.
2. Ponle un nombre, por ejemplo "Backend Hoja de Ruta".
3. Borra el contenido de `Code.gs` que trae por defecto y pega el contenido de
   [`apps-script/Code.gs`](apps-script/Code.gs) de este proyecto.
4. En el menú lateral, click en el ícono **+** junto a "Servicios" → busca **Drive API**
   → **Agregar** (déjalo con el identificador "Drive", versión v3). Esto habilita el OCR.
5. En el menú desplegable de funciones (arriba, junto al ícono ▷ Ejecutar), elige **setup**
   y presiona **Ejecutar**.
   - La primera vez te va a pedir autorizar permisos (Drive y Sheets) — es tu propia cuenta
     de Google, así que puedes aceptar con confianza.
6. Abre **Ver → Registro de ejecución** (o `Ctrl+Enter`). Vas a ver algo así:

   ```
   API_TOKEN: 8f14e45f-ceea-467d-a3e0-...
   Planilla (base de datos): https://docs.google.com/spreadsheets/d/...
   Carpeta de respaldo de fotos: https://drive.google.com/drive/folders/...
   ```

   Copia el **API_TOKEN** — lo necesitas en el Paso 3. Guarda también los links de la
   planilla y la carpeta, son tu base de datos y tu respaldo de fotos.

## Paso 2 — Publicar el backend como aplicación web

1. Arriba a la derecha, botón **Implementar → Nueva implementación**.
2. Tipo: **Aplicación web**.
3. Configuración:
   - **Ejecutar como**: Yo (tu cuenta)
   - **Quién tiene acceso**: Cualquier usuario
4. **Implementar**. Copia la URL que termina en `/exec` — esa es tu `APPS_SCRIPT_URL`.

> Si más adelante cambias el código de `Code.gs`, tienes que crear una **nueva versión** de
> la implementación (Implementar → Administrar implementaciones → ✏️ → Nueva versión) para
> que los cambios tomen efecto; solo guardar el archivo no alcanza.

## Paso 3 — Configurar el frontend

Abre `js/config.js` y reemplaza los dos valores:

```js
window.APP_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycb.../exec",
  API_TOKEN: "8f14e45f-ceea-467d-a3e0-...",
};
```

## Paso 4 — Publicar el frontend (hosting estático)

Toda la carpeta raíz (`index.html`, `css/`, `js/`, `manifest.json`, `sw.js`, `icons/`) es
un sitio estático normal — no necesita build ni Node, solo debe servirse por **HTTPS**
(la cámara no funciona por HTTP salvo en `localhost`).

**Con GitHub Pages:**

1. Crea un repositorio nuevo y sube el contenido de esta carpeta (todo excepto `apps-script/`,
   que se queda en Apps Script y no necesita subirse a ningún hosting).
2. En el repo: **Settings → Pages → Deploy from branch**, rama `main`, carpeta `/root`.
3. Espera un par de minutos y GitHub te da una URL como
   `https://tu-usuario.github.io/tu-repo/`.

**Con cualquier otro hosting estático** (Netlify, Vercel, un servidor propio, etc.): sube
la misma carpeta tal cual, no hay pasos especiales — es HTML/CSS/JS plano.

## Paso 5 — Instalar la app en el celular (Android)

1. Abre la URL publicada en **Chrome** del celular.
2. Menú (⋮) → **Agregar a pantalla de inicio** / **Instalar app**.
3. Ábrela desde el ícono — corre a pantalla completa como una app nativa.
4. La primera vez te va a pedir permiso de cámara: acepta.

---

## Dónde quedan los datos

- **Base de datos**: la planilla de Google Sheets creada en el Paso 1 (hoja "Registros"),
  una fila por documento guardado.
- **Respaldo de fotos**: la carpeta de Drive creada en el Paso 1, una foto por documento
  (nombrada con el N° de Hoja de Ruta y la fecha/hora).
- La planilla incluye una columna con el link directo a la foto de cada fila.

## Limitaciones importantes

- **Linterna automática**: solo funciona en **Chrome para Android** (usa la API `torch` de
  `MediaStreamTrack`, que Android expone y iPhone/Safari no). En iPhone la app avisa con un
  mensaje en pantalla cuando detecta poca luz, pero la linterna hay que encenderla a mano.
  Como elegiste Android como plataforma principal, esto no debería afectarte, pero queda
  documentado por si en el futuro se usa también en iPhone.
- **Precisión del OCR**: la lectura automática de campos está afinada para el formato de
  Hoja de Ruta de DIPISA que se usó como referencia. Si el formato cambia (otro proveedor,
  otro layout), puede que algunos campos no se lean bien — por eso el formulario siempre
  se muestra editable antes de guardar. Si notas que un campo falla sistemáticamente,
  se puede ajustar el patrón correspondiente en la función `parseFields` de `Code.gs`
  (hay una función `testParseFields` en el mismo archivo para probar cambios sin necesidad
  de sacar una foto real).
- **Seguridad**: el backend usa un token compartido simple (`API_TOKEN`) en vez de login de
  usuarios — suficiente para una herramienta interna de uso limitado, pero cualquiera con la
  URL y el token puede escribir en la planilla. No publiques el token en un repositorio
  público; si usas GitHub Pages, sube el repositorio como **privado**, o considera pedir
  que cada usuario ingrese su propio token la primera vez en vez de dejarlo fijo en el código.
- **Tamaño de fotos**: cada foto se reduce a máx. 1600px de ancho antes de enviarse, para
  cuidar los datos móviles; igual queda perfectamente legible para respaldo.

## Estructura de archivos

```
index.html              Pantallas de la app (cámara, revisión, formulario, éxito, historial)
css/styles.css           Estilos
js/app.js                 Cámara, detección de bordes, linterna automática, cola offline
js/config.js               URL y token del backend (edítalo tú)
manifest.json             Metadatos de instalación PWA
sw.js                      Service worker (caché del shell de la app)
icons/                    Íconos de la app
apps-script/Code.gs        Backend: OCR, Drive, Sheets
apps-script/appsscript.json Manifest del proyecto de Apps Script (útil si usas `clasp`)
```
