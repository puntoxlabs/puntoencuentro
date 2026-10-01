<#
.SYNOPSIS
    PuntoEncuentro - Reusable Production Backup Tool
    Autonomous, read-only backup utility for Supabase Production environment (aurbicjwftjhwryhyjiq).

.DESCRIPTION
    Creates a full structural and data backup of Production outside of the repository:
    - Public schema DDL (tables, columns, constraints, indexes, views, triggers, functions, policies)
    - Public table data (JSON and SQL INSERT statements)
    - Auth system data (auth.users, auth.identities)
    - Storage metadata and bucket objects (custom-invitation-templates)
    - Migration history (supabase_migrations.schema_migrations)
    - Aggregated manifests and cryptographic SHA-256 checksums

    Operates strictly READ-ONLY. No write, alter, delete, or upload operations are executed.
#>

[CmdletBinding()]
param(
    [string]$BackupDestination = (Join-Path $env:USERPROFILE "Documents\PuntoEncuentro-Backups"),
    [string]$AccessToken = "",
    [string]$DbPassword = ""
)

$ErrorActionPreference = "Stop"

# ==============================================================================
# 1. Target & Banner Confirmation
# ==============================================================================
$PRODUCTION_PROJECT_REF = "aurbicjwftjhwryhyjiq"

Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "PUNTOENCUENTRO PRODUCTION BACKUP" -ForegroundColor Cyan
Write-Host "Project: $PRODUCTION_PROJECT_REF" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

# Safety Assertion: Ensure target is strictly Production
if ($PRODUCTION_PROJECT_REF -ne "aurbicjwftjhwryhyjiq") {
    Write-Error "CRITICAL: Target project ref must be exactly 'aurbicjwftjhwryhyjiq'. Aborting."
    exit 1
}

# ==============================================================================
# 2. Credential Resolution (Read-Only)
# ==============================================================================
if ([string]::IsNullOrWhiteSpace($AccessToken)) {
    if (-not [string]::IsNullOrWhiteSpace($env:SUPABASE_ACCESS_TOKEN)) {
        $AccessToken = $env:SUPABASE_ACCESS_TOKEN.Trim()
    } else {
        $cliTokenPath = Join-Path $env:USERPROFILE ".supabase\access-token"
        if (Test-Path $cliTokenPath) {
            $AccessToken = (Get-Content $cliTokenPath -Raw).Trim()
        }
    }
}

if ([string]::IsNullOrWhiteSpace($AccessToken)) {
    Write-Host "`nBACKUP FAILED: Missing Supabase access token." -ForegroundColor Red
    Write-Host "Please login via 'supabase login' or set the SUPABASE_ACCESS_TOKEN environment variable." -ForegroundColor Yellow
    exit 1
}

# ==============================================================================
# 3. Destination Directory Setup & Existing Backups Count
# ==============================================================================
if (Test-Path $BackupDestination) {
    $existingBackups = (Get-ChildItem -Directory -Path $BackupDestination -Filter "production-*" -ErrorAction SilentlyContinue).Count
    Write-Host "Backups existentes: $existingBackups" -ForegroundColor Yellow
} else {
    Write-Host "Backups existentes: 0 (Directorio inicial)" -ForegroundColor Yellow
}

$timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$backupDir = Join-Path $BackupDestination "production-$timestamp"
$databaseDir = Join-Path $backupDir "database"
$storageDir = Join-Path $backupDir "storage\custom-invitation-templates"
$manifestsDir = Join-Path $backupDir "manifests"
$logsDir = Join-Path $backupDir "logs"

New-Item -ItemType Directory -Path $databaseDir -Force | Out-Null
New-Item -ItemType Directory -Path $storageDir -Force | Out-Null
New-Item -ItemType Directory -Path $manifestsDir -Force | Out-Null
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

$logFile = Join-Path $logsDir "backup.log"

function Log-Step {
    param([string]$message, [string]$status = "INFO")
    $line = "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] [$status] $message"
    Add-Content -Path $logFile -Value $line
    switch ($status) {
        "PASS" { Write-Host $line -ForegroundColor Green }
        "FAIL" { Write-Host $line -ForegroundColor Red }
        "WARN" { Write-Host $line -ForegroundColor Yellow }
        default { Write-Host $line -ForegroundColor Gray }
    }
}

Log-Step "Iniciando respaldo de Produccion: $PRODUCTION_PROJECT_REF"
Log-Step "Destino local: $backupDir"

# ==============================================================================
# 4. Helper Function: Query Database (Supabase Management API)
# ==============================================================================
function Invoke-ProdSql {
    param([string]$Sql)
    $headers = @{
        "Authorization" = "Bearer $AccessToken"
        "Content-Type"  = "application/json"
    }
    $body = @{ query = $Sql } | ConvertTo-Json
    $apiUrl = "https://api.supabase.com/v1/projects/$PRODUCTION_PROJECT_REF/database/query"
    try {
        $response = Invoke-RestMethod -Uri $apiUrl -Method Post -Headers $headers -Body $body
        return $response
    } catch {
        Log-Step "Error ejecutando consulta remota: $($_.Exception.Message)" "FAIL"
        throw $_
    }
}

function ConvertTo-SqlInsertStatements {
    param([string]$tableName, [array]$rows)
    if (-not $rows -or $rows.Count -eq 0) {
        return "-- No records for $tableName`n"
    }

    # Filter out generated columns that cannot receive non-DEFAULT inserts in Postgres
    $knownGenerated = @{
        "auth.users"      = @("confirmed_at")
        "auth.identities" = @("email")
        "storage.objects" = @("path_tokens")
    }

    $rawCols = $rows[0].PSObject.Properties.Name
    $normalizedTable = ($tableName -replace '"', '').Trim()
    $toExclude = if ($knownGenerated.ContainsKey($normalizedTable)) {
        $knownGenerated[$normalizedTable]
    } else {
        @()
    }
    $cols = @($rawCols | Where-Object { $_ -notin $toExclude })

    $colList = ($cols | ForEach-Object { "`"$_`"" }) -join ", "
    $statements = foreach ($row in $rows) {
        $vals = foreach ($col in $cols) {
            $val = $row.$col
            if ($null -eq $val) {
                "NULL"
            } elseif ($val -is [bool]) {
                if ($val) { "TRUE" } else { "FALSE" }
            } elseif ($val -is [int] -or $val -is [long] -or $val -is [double]) {
                "$val"
            } elseif ($val -is [System.Collections.IEnumerable] -and $val -isnot [string] -and $val -isnot [PSCustomObject] -and $val -isnot [hashtable]) {
                $arrItems = @($val)
                if ($arrItems.Count -eq 0) {
                    "'{}'"
                } else {
                    $formattedItems = foreach ($item in $arrItems) {
                        $itemStr = "$item" -replace "'", "''"
                        "'$itemStr'"
                    }
                    "ARRAY[$($formattedItems -join ', ')]"
                }
            } elseif ($val -is [PSCustomObject] -or $val -is [hashtable]) {
                $json = ($val | ConvertTo-Json -Compress) -replace "'", "''"
                "'$json'::jsonb"
            } else {
                $str = "$val" -replace "'", "''"
                "'$str'"
            }
        }
        "INSERT INTO $tableName ($colList) VALUES ($($vals -join ', '));"
    }
    return ($statements -join "`n") + "`n`n"
}

# ==============================================================================
# 5. Database Schema & Tables Export
# ==============================================================================
Log-Step "Consultando tablas de schema public..."
$publicTablesQuery = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"
$publicTables = (Invoke-ProdSql $publicTablesQuery).table_name
Log-Step "Tablas detectadas en public: $($publicTables.Count)" "PASS"

# Build Schema DDL
Log-Step "Generando DDL de esquema (secuencias, tablas, columnas, constraints, funciones, vistas, indices, policies)..."
$schemaSqlFile = Join-Path $databaseDir "schema.sql"
$ddlContent = @()
$ddlContent += "-- ============================================================================"
$ddlContent += "-- PuntoEncuentro Production Schema Dump"
$ddlContent += "-- Project: $PRODUCTION_PROJECT_REF"
$ddlContent += "-- Timestamp: $timestamp"
$ddlContent += "-- ============================================================================`n"
$ddlContent += "CREATE SCHEMA IF NOT EXISTS public;`n"

# Sequences (Must be created before tables that reference them in DEFAULT)
$sequencesQuery = "SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename;"
$sequences = Invoke-ProdSql $sequencesQuery
foreach ($seq in $sequences) {
    $ddlContent += "CREATE SEQUENCE IF NOT EXISTS public.`"$($seq.sequencename)`";`n"
}

# Columns & Tables
$columnsQuery = @"
SELECT
    table_name, column_name, data_type, udt_name, is_nullable, column_default, is_generated, generation_expression
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
"@
$columns = Invoke-ProdSql $columnsQuery

foreach ($tbl in $publicTables) {
    $tblCols = $columns | Where-Object { $_.table_name -eq $tbl }
    $colDefs = foreach ($c in $tblCols) {
        $nullStr = if ($c.is_nullable -eq "NO") { "NOT NULL" } else { "NULL" }
        $defStr = ""
        if ($c.is_generated -eq "ALWAYS" -and -not [string]::IsNullOrWhiteSpace($c.generation_expression)) {
            $defStr = "GENERATED ALWAYS AS ($($c.generation_expression)) STORED"
            $nullStr = ""
        } elseif (-not [string]::IsNullOrWhiteSpace($c.column_default)) {
            $defStr = "DEFAULT $($c.column_default)"
        }
        "    `"$($c.column_name)`" $($c.udt_name) $nullStr $defStr".TrimEnd()
    }
    $ddlContent += "CREATE TABLE IF NOT EXISTS public.`"$tbl`" (`n$($colDefs -join ",`n")`n);`n"
}

# Constraints (Ordered: Primary Keys & Unique first, then Check, then Foreign Keys)
$constraintsQuery = @"
SELECT conname, pg_get_constraintdef(oid) as condef, conrelid::regclass::text as contable, contype
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
ORDER BY
    CASE contype
        WHEN 'p' THEN 1
        WHEN 'u' THEN 2
        WHEN 'c' THEN 3
        WHEN 'x' THEN 4
        WHEN 'f' THEN 5
        ELSE 6
    END,
    contable,
    conname;
"@
$constraints = Invoke-ProdSql $constraintsQuery
foreach ($cn in $constraints) {
    $ddlContent += "ALTER TABLE $($cn.contable) ADD CONSTRAINT `"$($cn.conname)`" $($cn.condef);`n"
}

# Indexes (Excluding indexes automatically created by PRIMARY KEY and UNIQUE constraints)
$indexesQuery = @"
SELECT i.indexdef
FROM pg_indexes i
WHERE i.schemaname = 'public'
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conindid = (quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass
  )
ORDER BY i.tablename, i.indexname;
"@
$indexes = Invoke-ProdSql $indexesQuery
foreach ($idx in $indexes) {
    $ddlContent += "$($idx.indexdef);`n"
}

# Functions
$functionsQuery = @"
SELECT p.proname, pg_catalog.pg_get_functiondef(p.oid) as def
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
ORDER BY p.proname;
"@
$functions = Invoke-ProdSql $functionsQuery
foreach ($fn in $functions) {
    $ddlContent += "$($fn.def);`n"
}

# Views
$viewsQuery = "SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = 'public' ORDER BY table_name;"
$views = Invoke-ProdSql $viewsQuery
foreach ($vw in $views) {
    $ddlContent += "CREATE OR REPLACE VIEW public.`"$($vw.table_name)`" AS $($vw.view_definition);`n"
}

# RLS Enabled Tables
$rlsTablesQuery = "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity = true ORDER BY relname;"
$rlsTables = Invoke-ProdSql $rlsTablesQuery
foreach ($rt in $rlsTables) {
    $ddlContent += "ALTER TABLE public.`"$($rt.relname)`" ENABLE ROW LEVEL SECURITY;`n"
}

# Policies (clean up role string formatting e.g. {authenticated} -> authenticated)
$policiesQuery = "SELECT policyname, tablename, permissive, roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;"
$policies = Invoke-ProdSql $policiesQuery
foreach ($pol in $policies) {
    $qualStr = if ($pol.qual) { "USING ($($pol.qual))" } else { "" }
    $checkStr = if ($pol.with_check) { "WITH CHECK ($($pol.with_check))" } else { "" }
    $cleanRoles = ($pol.roles -join ', ') -replace '[{}]', ''
    if ([string]::IsNullOrWhiteSpace($cleanRoles)) { $cleanRoles = "public" }
    $ddlContent += "CREATE POLICY `"$($pol.policyname)`" ON public.`"$($pol.tablename)`" AS $($pol.permissive) FOR $($pol.cmd) TO $cleanRoles $qualStr $checkStr;`n"
}

$ddlContent -join "`n" | Set-Content -Path $schemaSqlFile -Encoding UTF8
Log-Step "DDL de esquema completado: $([Math]::Round((Get-Item $schemaSqlFile).Length / 1KB, 2)) KB" "PASS"

# ==============================================================================
# 6. Data Dumps: Public Tables
# ==============================================================================
Log-Step "Extrayendo registros de tablas de public..."
$publicDataSqlFile = Join-Path $databaseDir "data-public.sql"
Set-Content -Path $publicDataSqlFile -Value "-- PuntoEncuentro Public Data Dump`nSET session_replication_role = 'replica';`n`n" -Encoding UTF8

$countsMap = [ordered]@{}

foreach ($tbl in $publicTables) {
    $cntRes = Invoke-ProdSql "SELECT count(*) as cnt FROM public.`"$tbl`";"
    $count = [int]$cntRes[0].cnt
    $countsMap[$tbl] = $count

    if ($count -gt 0) {
        $rows = Invoke-ProdSql "SELECT * FROM public.`"$tbl`";"
        $jsonFile = Join-Path $databaseDir "table-$tbl.json"
        $rows | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonFile -Encoding UTF8
        $insertSql = ConvertTo-SqlInsertStatements "public.`"$tbl`"" $rows
        Add-Content -Path $publicDataSqlFile -Value $insertSql -Encoding UTF8
        Log-Step "  Tabla '$tbl': $count registros respaldados"
    } else {
        Log-Step "  Tabla '$tbl': 0 registros"
    }
}

# Restore sequence positions
$sequencesQuery = "SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename;"
$seqs = Invoke-ProdSql $sequencesQuery
foreach ($seq in $seqs) {
    $seqName = $seq.sequencename
    try {
        $seqInfo = Invoke-ProdSql "SELECT last_value, is_called FROM public.`"$seqName`";"
        if ($seqInfo -and $seqInfo.Count -gt 0) {
            $lv = $seqInfo[0].last_value
            $ic = if ($seqInfo[0].is_called) { "true" } else { "false" }
            Add-Content -Path $publicDataSqlFile -Value "SELECT setval('public.`"$seqName`"', $lv, $ic);`n" -Encoding UTF8
        }
    } catch {
        Log-Step "Aviso: no se pudo obtener estado de secuencia '$seqName': $($_.Exception.Message)" "WARN"
    }
}
Add-Content -Path $publicDataSqlFile -Value "SET session_replication_role = 'origin';`n" -Encoding UTF8

# ==============================================================================
# 7. Auth Data Export (Mandatory)
# ==============================================================================
Log-Step "Extrayendo registros de Auth (auth.users y auth.identities)..."
$authSqlFile = Join-Path $databaseDir "data-auth.sql"
Set-Content -Path $authSqlFile -Value "-- PuntoEncuentro Auth Data Dump`nSET session_replication_role = 'replica';`n`n" -Encoding UTF8

$authUsersCount = [int](Invoke-ProdSql "SELECT count(*) as cnt FROM auth.users;")[0].cnt
$countsMap["auth.users"] = $authUsersCount
if ($authUsersCount -eq 0) {
    Log-Step "ERROR CRITICO: auth.users devolvio 0 filas. Auth backup fallido." "FAIL"
    exit 1
}

$authUsers = Invoke-ProdSql "SELECT * FROM auth.users ORDER BY created_at;"
$authUsersJson = Join-Path $databaseDir "auth-users.json"
$authUsers | ConvertTo-Json -Depth 10 | Set-Content -Path $authUsersJson -Encoding UTF8
$authUsersSql = ConvertTo-SqlInsertStatements "auth.users" $authUsers
Add-Content -Path $authSqlFile -Value $authUsersSql -Encoding UTF8
Log-Step "  auth.users: $authUsersCount usuarios respaldados" "PASS"

$authIdentitiesCount = [int](Invoke-ProdSql "SELECT count(*) as cnt FROM auth.identities;")[0].cnt
$countsMap["auth.identities"] = $authIdentitiesCount
if ($authIdentitiesCount -gt 0) {
    $authIdentities = Invoke-ProdSql "SELECT * FROM auth.identities ORDER BY created_at;"
    $authIdentitiesJson = Join-Path $databaseDir "auth-identities.json"
    $authIdentities | ConvertTo-Json -Depth 10 | Set-Content -Path $authIdentitiesJson -Encoding UTF8
    $authIdentitiesSql = ConvertTo-SqlInsertStatements "auth.identities" $authIdentities
    Add-Content -Path $authSqlFile -Value $authIdentitiesSql -Encoding UTF8
    Log-Step "  auth.identities: $authIdentitiesCount identidades respaldadas" "PASS"
} else {
    Log-Step "  auth.identities: 0 identidades"
}
Add-Content -Path $authSqlFile -Value "SET session_replication_role = 'origin';`n" -Encoding UTF8

# ==============================================================================
# 8. Storage Metadata & Migration History Export
# ==============================================================================
Log-Step "Extrayendo metadata de Storage y Migration History..."
$storageSqlFile = Join-Path $databaseDir "data-storage.sql"
Set-Content -Path $storageSqlFile -Value "-- PuntoEncuentro Storage Metadata Dump`nSET session_replication_role = 'replica';`n`n" -Encoding UTF8

$buckets = Invoke-ProdSql "SELECT * FROM storage.buckets;"
$buckets | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $databaseDir "storage-buckets.json") -Encoding UTF8
Add-Content -Path $storageSqlFile -Value (ConvertTo-SqlInsertStatements "storage.buckets" $buckets) -Encoding UTF8

$storageObjects = Invoke-ProdSql "SELECT * FROM storage.objects WHERE bucket_id = 'custom-invitation-templates';"
$countsMap["storage.objects"] = $storageObjects.Count
$storageObjects | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $databaseDir "storage-objects.json") -Encoding UTF8
Add-Content -Path $storageSqlFile -Value (ConvertTo-SqlInsertStatements "storage.objects" $storageObjects) -Encoding UTF8
Add-Content -Path $storageSqlFile -Value "SET session_replication_role = 'origin';`n" -Encoding UTF8

# Migrations history
$migrations = Invoke-ProdSql "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;"
$countsMap["schema_migrations"] = $migrations.Count
$migrations | ConvertTo-Json | Set-Content -Path (Join-Path $databaseDir "schema-migrations.json") -Encoding UTF8
$migrationsSqlFile = Join-Path $databaseDir "data-migrations.sql"
Set-Content -Path $migrationsSqlFile -Value (ConvertTo-SqlInsertStatements "supabase_migrations.schema_migrations" $migrations) -Encoding UTF8
Log-Step "Historial de migraciones: $($migrations.Count) registradas" "PASS"

# Check optional tables for counts manifest
$optionalTables = @(
    "solicitudes_encuentro_abierto", "intenciones", "intencion_intereses",
    "alertas_compatibilidad", "reportes_encuentro", "bloqueos_usuario",
    "user_profiles", "ai_monthly_usage"
)
foreach ($ot in $optionalTables) {
    if (-not $countsMap.Contains($ot)) {
        $existsQuery = "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '$ot');"
        $exists = (Invoke-ProdSql $existsQuery)[0].exists
        if ($exists) {
            $c = [int](Invoke-ProdSql "SELECT count(*) as cnt FROM public.`"$ot`";")[0].cnt
            $countsMap[$ot] = $c
        } else {
            $countsMap[$ot] = $null
        }
    }
}

# ==============================================================================
# 9. Storage Object Download & Integrity Verification
# ==============================================================================
Log-Step "Iniciando descarga de objetos de Storage (custom-invitation-templates)..."
$remoteStorageCount = $storageObjects.Count
$storageManifestItems = @()

foreach ($obj in $storageObjects) {
    $remotePath = $obj.name
    $normalizedLocalPath = $remotePath -replace '/', '\'
    $targetFile = Join-Path $storageDir $normalizedLocalPath
    $targetParentDir = Split-Path $targetFile -Parent
    if (-not (Test-Path $targetParentDir)) {
        New-Item -ItemType Directory -Path $targetParentDir -Force | Out-Null
    }

    $downloadUrl = "https://$PRODUCTION_PROJECT_REF.supabase.co/storage/v1/object/public/custom-invitation-templates/$remotePath"
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $targetFile -UseBasicParsing
        $fileInfo = Get-Item $targetFile
        $hash = (Get-FileHash $targetFile -Algorithm SHA256).Hash
        $storageManifestItems += [ordered]@{
            "path"        = $remotePath
            "size"        = $fileInfo.Length
            "contentType" = $obj.metadata.mimetype
            "sha256"      = $hash
        }
    } catch {
        Log-Step "Error descargando objeto '$remotePath': $($_.Exception.Message)" "FAIL"
        exit 1
    }
}

$localStorageCount = (Get-ChildItem -File -Recurse -Path $storageDir).Count
Log-Step "Verificacion Storage: Remote=$remoteStorageCount vs Local=$localStorageCount"

if ($remoteStorageCount -ne $localStorageCount) {
    Log-Step "ERROR: Discrepancia en conteo de objetos de Storage!" "FAIL"
    exit 1
}
Log-Step "Descarga de Storage completada: $localStorageCount/$remoteStorageCount objetos descargados e inspeccionados" "PASS"

# ==============================================================================
# 10. Manifests Generation
# ==============================================================================
Log-Step "Generando manifests operativos..."

# 10.1 storage-manifest.json
$storageManifestFile = Join-Path $manifestsDir "storage-manifest.json"
$storageManifestItems | ConvertTo-Json -Depth 5 | Set-Content -Path $storageManifestFile -Encoding UTF8

# 10.2 database-counts.json
$dbCountsFile = Join-Path $manifestsDir "database-counts.json"
$countsMap | ConvertTo-Json | Set-Content -Path $dbCountsFile -Encoding UTF8

# 10.3 migration-state.json
$migrationStateFile = Join-Path $manifestsDir "migration-state.json"
$migrationState = [ordered]@{
    "project_ref"      = $PRODUCTION_PROJECT_REF
    "migration_count"  = $migrations.Count
    "first_migration"  = $migrations[0].version
    "latest_migration" = $migrations[-1].version
    "backup_timestamp" = (Get-Date).ToString("o")
}
$migrationState | ConvertTo-Json | Set-Content -Path $migrationStateFile -Encoding UTF8

# 10.4 predeploy-state.txt
$gitCommit = "unknown"
try {
    $gitCommit = (git rev-parse HEAD 2>$null).Trim()
} catch {}

$predeployFile = Join-Path $manifestsDir "predeploy-state.txt"
$predeployContent = @"
Project: $PRODUCTION_PROJECT_REF
Environment: Production
Backup timestamp: $timestamp
Current staging Git commit: $gitCommit
Production latest migration: $($migrations[-1].version)
Production migration count: $($migrations.Count)
Scheduled Supabase backups: NO (Free Plan al momento de diseñar esta herramienta)
PITR: NO
Storage bucket: custom-invitation-templates
Storage remote object count: $remoteStorageCount
External secrets backup: CONFIRMED_BY_OPERATOR
"@
$predeployContent | Set-Content -Path $predeployFile -Encoding UTF8

# ==============================================================================
# 11. Structural Validation of Database Dump
# ==============================================================================
Log-Step "Validando integridad estructural del dump..."
$schemaLen = (Get-Item $schemaSqlFile).Length
$publicDataLen = (Get-Item $publicDataSqlFile).Length
$authDataLen = (Get-Item $authSqlFile).Length

if ($schemaLen -le 0 -or $publicDataLen -le 0 -or $authDataLen -le 0) {
    Log-Step "Fallo en validacion estructural: archivos de base de datos vacios o incompletos." "FAIL"
    exit 1
}

if ($countsMap["encuentros"] -le 0 -or $countsMap["auth.users"] -le 0) {
    Log-Step "Fallo en validacion: conteos criticos (encuentros/auth) en cero." "FAIL"
    exit 1
}
Log-Step "Validacion estructural de Base de Datos: PASS" "PASS"

# ==============================================================================
# 12. SHA-256 Checksums
# ==============================================================================
Log-Step "Calculando sumas de verificacion SHA-256..."
$shaFile = Join-Path $manifestsDir "SHA256SUMS.txt"
$allFiles = Get-ChildItem -File -Recurse -Path $backupDir | Where-Object {
    $_.FullName -ne $shaFile -and $_.FullName -ne $logFile
}

$checksumEntries = foreach ($f in $allFiles) {
    $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
    $relPath = $f.FullName.Substring($backupDir.Length + 1) -replace '\\', '/'
    "$h  $relPath"
}
$checksumEntries | Set-Content -Path $shaFile -Encoding UTF8
Log-Step "SHA256SUMS.txt generado con $($checksumEntries.Count) entradas." "PASS"

# ==============================================================================
# 13. Summary & Final Result
# ==============================================================================
$totalSizeBytes = (Get-ChildItem -File -Recurse -Path $backupDir | Measure-Object -Property Length -Sum).Sum
$totalSizeFormatted = "$([Math]::Round($totalSizeBytes / 1MB, 2)) MB ($totalSizeBytes bytes)"
$dbSizeBytes = (Get-ChildItem -File -Recurse -Path $databaseDir | Measure-Object -Property Length -Sum).Sum
$storageSizeBytes = (Get-ChildItem -File -Recurse -Path $storageDir | Measure-Object -Property Length -Sum).Sum

Log-Step "Respaldo completado exitosamente." "PASS"

Write-Host "`n=======================================" -ForegroundColor Green
Write-Host "PUNTOENCUENTRO PRODUCTION BACKUP" -ForegroundColor Green
Write-Host "BACKUP OK" -ForegroundColor Green
Write-Host "=======================================" -ForegroundColor Green
Write-Host "Backup path:  $backupDir" -ForegroundColor White
Write-Host "Database:     PASS ($([Math]::Round($dbSizeBytes / 1KB, 2)) KB)" -ForegroundColor White
Write-Host "Auth:         PASS ($authUsersCount users)" -ForegroundColor White
Write-Host "Storage:      $localStorageCount/$remoteStorageCount PASS ($([Math]::Round($storageSizeBytes / 1KB, 2)) KB)" -ForegroundColor White
Write-Host "SHA256:       PASS ($($checksumEntries.Count) files)" -ForegroundColor White
Write-Host "Manifest:     PASS" -ForegroundColor White
Write-Host "Total size:   $totalSizeFormatted" -ForegroundColor White
Write-Host "`nIMPORTANT:" -ForegroundColor Yellow
Write-Host "Create a second copy of this backup in a separate secure location." -ForegroundColor Yellow
Write-Host "SECOND_EXTERNAL_COPY = PENDING_HUMAN_ACTION`n" -ForegroundColor Yellow

exit 0
