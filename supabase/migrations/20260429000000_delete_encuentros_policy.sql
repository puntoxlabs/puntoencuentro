-- Migración para habilitar eliminación de encuentros
CREATE POLICY "delete encuentros" ON public.encuentros FOR DELETE USING (true);
CREATE POLICY "update encuentros" ON public.encuentros FOR UPDATE USING (true);
