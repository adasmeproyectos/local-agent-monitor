# Navi Cleaner v5.5 — Apple Suite Desktop Edition 🚀

**Navi Cleaner** es una aplicación de escritorio moderna y ultra rápida diseñada para limpieza profunda, indexación inteligente de archivos con clasificación semántica dinámica cero-sesgo, análisis heurístico de procesos y optimización total del sistema antes de jugar en **Windows**, con una estética **Apple Suite Light Mode** fluida y minimalista.

---

## ✨ Características Principales

### 1. 🖥️ Diseño Apple Suite Light Mode 100% Fluido
- **UI Líquida Sin Scroll Horizontal**: Se adapta dinámicamente al 100% del ancho de tu pantalla (1080p, 1440p, 4K) sin márgenes muertos.
- **Glassmorphism y Tipografía Crisp**: Contraste alto con negro carbón sobre fondos translúcidos estilo macOS Sonoma.
- **HUD Integrado**: Avatar interactivo del asistente en la barra superior.

### 2. 🧠 Clasificación Semántica Dinámica Cero-Sesgo (User-Adaptive Clustering)
- **Motor Adaptativo Multi-Dominio**: Elimina sesgos rígidos de código y descubre automáticamente los perfiles del usuario según el análisis heurístico de cabeceras de archivos (por ejemplo, *Construcción & Obra*, *Finanzas & Contable*, *Desarrollo & Software*, *Académico & Estudio*, *Legal & Corporativo*, *Diseño & Creativo* o *Gestión & Operaciones*).
- **Registro Dinámico en SQLite**: Las nuevas categorías semánticas descubiertas se registran automáticamente en la base de datos (`dynamic_categories`) y actualizan dinámicamente los filtros de la interfaz en español.
- **Indexación Profunda Raíz (`C:\`) & Modo Delta**: El primer escaneo exhaustivo analiza sin restricciones la raíz del sistema (con notificación modal clara de 30 minutos). Los escaneos posteriores transicionan al indexador Delta instantáneo.
- **Protección Exclusiva para Juegos**: Ningún juego de Steam, Epic Games, Riot Games ni EA App será modificado o clasificado erróneamente.

### 3. 🕹️ Optimización y Garantía Cero Segundo Plano para Gaming
- **Destructor Contextual Inteligente**:
  - Para aplicaciones oficiales de lanzadores: ofrece **Desinstalación Oficial** invocando el desinstalador de Windows o el launcher original sin romper manifiestos.
  - Para restos huérfanos o aplicaciones sin instalador: ofrece **Eliminar de Raíz** para purgar el directorio.
- **Apagado Inmediato (`/api/shutdown`)**: Cierra el servidor Node.js y la ventana del explorador al instante con cero procesos residuales antes de abrir tus juegos.

### 4. 🛡️ Monitor de Seguridad de Procesos Heurístico (100% en Español)
- Analiza procesos activos en busca de:
  - **Mineros de Criptomonedas ocultos** (`🔴 MINERO DE CRIPTOMONEDAS DETECTADO`).
  - **Puertas traseras de monetización silenciosa** (`⚠️ PUERTA TRASERA DE MONETIZACIÓN SILENCIOSA`).
  - **Rutas anómalas** (`TEMP`, `AppData Roaming`, o procesos ocultos sin ruta accesible).
- **Inspección Interactiva & Finalización Inmediata**: Haz clic en cualquier proceso de la tabla para ver el diagnóstico detallado y finalizarlo directamente con `taskkill /F /PID`.

### 5. 🔍 Explorador y Eliminación Segura Directa
- **Resaltado Exacto en Explorador (`explorer.exe /select,"<ruta>"`)**: Abre la ubicación exacta del archivo y lo resalta automáticamente en el Explorador de Windows.
- **Purgado Permanente de Archivos**: Elimina archivos basura o pesados directamente desde el panel de control.

---

## 🛠️ Instalación y Uso Rápido

### Requisitos Previos
- **Windows 10 / 11**
- **Node.js v18+** instalado en tu sistema.

### 1. Clonar el Repositorio
```powershell
git clone https://github.com/tu-usuario/navi-cleaner.git
cd navi-cleaner
```

### 2. Instalar Dependencias
```powershell
npm install
```

### 3. Ejecutar como Administrador (Recomendado)
Para permitir el análisis profundo de la raíz del disco (`C:\`), consultas al Registro de Windows e inspección de procesos ocultos, ejecuta la aplicación con privilegios elevados:
```powershell
# Opción A: Haciendo clic derecho en tu terminal y seleccionando "Ejecutar como Administrador"
npm start

# Opción B: Ejecutando el script de elevación directa
node start-elevated.js
```

La interfaz se abrirá automáticamente en tu navegador o ventana dedicada en:
👉 **http://localhost:3141**

---

## 📂 Arquitectura del Proyecto

```text
navi-cleaner/
├── modules/
│   ├── classifier.js        # Motor de clasificación heurística e indexación universitaria
│   ├── crawler.js           # Escáner recursivo y descubrimiento de archivos en raíz (C:\)
│   ├── db.js                # Gestión de base de datos SQLite con modo WAL de alto rendimiento
│   ├── extractor.js         # Extractor de metadatos de PDF/documentos (ventana 8KB)
│   ├── game-scanner.js      # Escáner del Registro de Windows y diferenciador de juegos vs apps
│   └── process-monitor.js   # Analizador de amenazas en procesos activos y puntuación heurística
├── public/
│   ├── app.js               # Lógica del frontend y gestor de estado Apple Suite
│   ├── index.html           # Interfaz de usuario responsiva y modal de alertas
│   └── styles.css           # Sistema de diseño fluido Apple Suite Light Mode
├── server.js                # Servidor Express, endpoints REST y puente con PowerShell
├── package.json
└── README.md
```

---

## 🔒 Privacidad y Seguridad
- **100% Local**: Todos los datos e índices SQLite (`navi.db`) se almacenan de manera local y privada en tu perfil de usuario (`%USERPROFILE%\.navi-cleaner\navi.db`).
- **Sin Telemetría ni Nube**: Navi Cleaner no envía información personal, nombres de archivo ni listados de aplicaciones a ningún servidor externo.
