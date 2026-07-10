-- ============================================================
-- Migración: Storage para Diseños Personalizados
-- 20260710000002_custom_storage_policies.sql
-- ============================================================
-- Alcance:
--   1. Crear bucket 'custom-invitation-templates' (public = true)
--   2. Aplicar policies de INSERT, UPDATE, DELETE para dueños
-- ============================================================

BEGIN;

-- 1. Crear el bucket si no existe
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'custom-invitation-templates',
    'custom-invitation-templates',
    true,
    5242880, -- 5 MB
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2. Policies de escritura y lectura propia (NO hay policy SELECT anon/public)

DROP POLICY IF EXISTS "custom_storage_owner_select" ON storage.objects;
CREATE POLICY "custom_storage_owner_select"
ON storage.objects FOR SELECT
TO authenticated
USING (
    bucket_id = 'custom-invitation-templates'
    AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "custom_storage_owner_insert" ON storage.objects;
CREATE POLICY "custom_storage_owner_insert"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'custom-invitation-templates'
    AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "custom_storage_owner_update" ON storage.objects;
CREATE POLICY "custom_storage_owner_update"
ON storage.objects FOR UPDATE
USING (
    bucket_id = 'custom-invitation-templates'
    AND auth.uid()::text = (storage.foldername(name))[1]
)
WITH CHECK (
    bucket_id = 'custom-invitation-templates'
    AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "custom_storage_owner_delete" ON storage.objects;
CREATE POLICY "custom_storage_owner_delete"
ON storage.objects FOR DELETE
USING (
    bucket_id = 'custom-invitation-templates'
    AND auth.uid()::text = (storage.foldername(name))[1]
);

COMMIT;
