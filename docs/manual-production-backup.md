# Guía Operativa de Respaldo Manual de Producción

Herramienta autónoma y reutilizable para respaldar la base de datos, autenticación y almacenamiento del entorno de Producción (`aurbicjwftjhwryhyjiq`) mientras el proyecto permanezca en el plan Free de Supabase (sin PITR ni backups programados automatizados).

---

## 1. Requisitos Previos
- **Windows PowerShell 5.1+** (incorporado en Windows 10/11).
- **Sesión activa de Supabase CLI** (`~/.supabase/access-token`) o variable de entorno `SUPABASE_ACCESS_TOKEN` configurada.
- Acceso a internet hacia los endpoints de Supabase (`api.supabase.com` y `aurbicjwftjhwryhyjiq.supabase.co`).

---

## 2. Cómo Ejecutar el Respaldo

### Opción A: Doble Clic (Explorador de Windows)
Hacer doble clic sobre el archivo ejecutable:
```text
scripts\backup-production.bat
```
La ventana permanecerá abierta al concluir para permitir verificar el resultado final.

### Opción B: Terminal (PowerShell o CMD)
```powershell
.\scripts\backup-production.bat
```
*(Opcionalmente se puede invocar directamente `.\scripts\backup-production.ps1` especificando `-BackupDestination "D:\MisBackups"`).*

---

## 3. Destino de los Respaldo
Por defecto, los respaldos se generan fuera del repositorio en la carpeta del usuario:
```text
C:\Users\<usuario>\Documents\PuntoEncuentro-Backups\production-YYYYMMDD-HHmmss\
```

Estructura interna generada:
- `database/`: DDL completo de esquema (`schema.sql`), volcados de datos en SQL INSERTs (`data-public.sql`, `data-auth.sql`, `data-storage.sql`, `data-migrations.sql`) y formato JSON por tabla.
- `storage/custom-invitation-templates/`: Descarga exacta de todos los archivos y plantillas del bucket de storage.
- `manifests/`: Conteos agregados (`database-counts.json`), manifiesto de storage (`storage-manifest.json`), estado de migraciones (`migration-state.json`), estado del entorno (`predeploy-state.txt`) y sumas de comprobación criptográficas (`SHA256SUMS.txt`).
- `logs/`: Registro de ejecución paso a paso (`backup.log`) sin datos personales ni secretos.

---

## 4. Cómo Reconocer BACKUP OK
Al concluir satisfactoriamente, el script presentará en verde:
```text
=======================================
PUNTOENCUENTRO PRODUCTION BACKUP
BACKUP OK
=======================================
Backup path:  C:\Users\...\Documents\PuntoEncuentro-Backups\production-...
Database:     PASS
Auth:         PASS
Storage:      N/N PASS
SHA256:       PASS
Manifest:     PASS
Total size:   ...
```
Si cualquier componente (Auth, Storage, DB) fallara o el conteo de objetos difiriera, el script mostrará `BACKUP FAILED` con código de salida distinto de 0.

---

## 5. Necesidad de Segunda Copia
> [!IMPORTANT]
> El respaldo se crea localmente en el disco de la máquina de desarrollo. Para cumplir con las buenas prácticas de recuperación ante desastres:
> **Copie inmediatamente la carpeta generada a un soporte físico externo o almacenamiento en la nube cifrado.**
> Estado operacional: `SECOND_EXTERNAL_COPY = PENDING_HUMAN_ACTION`.

---

## 6. Recomendaciones Operativas (Plan Free)
- **Frecuencia:** Ejecutar diariamente durante períodos con actividad real de usuarios.
- **Pre-deploy:** Ejecutar **SIEMPRE** antes de aplicar migraciones (`db push`) o despliegues productivos.
- **Transición a Pro:** Al migrar a un plan de pago con PITR activo, mantener esta herramienta como mecanismo complementario de exportación lógica independiente.
- *(Nota técnica: Este procedimiento es un respaldo lógico de emergencia y no sustituye la recuperación continua Point-In-Time a nivel de bloque WAL de la infraestructura gestionada).*
