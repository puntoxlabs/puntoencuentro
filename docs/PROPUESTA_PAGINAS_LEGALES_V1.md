# Propuesta de Páginas y Textos Legales — PuntoEncuentro V1

> **Estado del Documento:** Borrador formal para revisión y validación legal humana.  
> **Alcance:** Preparado para el primer lanzamiento público (V1) en `https://puntoencuentro.com.ar`.  
> **Aviso:** No contiene datos ficticios. Los campos que requieren definición jurídica por parte de los responsables del proyecto están delimitados con corchetes `[PENDIENTE REVISIÓN HUMANA]`.

---

## 1. Delimitación: Capa Técnica Verificada vs. Aprobación Humana

Para garantizar total transparencia ante el lanzamiento:

```mermaid
flowchart TD
    subgraph Tecnica ["1. Garantías Técnicas Verificadas en Código"]
        T1["Minimización de datos (sin tracking publicitario ni venta de datos)"]
        T2["Logística privada: 'lugar_texto' solo accesible a confirmados"]
        T3["Cifrado VAPID RFC 8291/8292 en notificaciones push"]
        T4["Derecho al olvido y portabilidad (Transfer Tickets criptográficos)"]
        T5["Circuito de controversias con 7 días para descargo"]
    end
    subgraph Humana ["2. Definiciones Pendientes de Aprobación Humana"]
        H1["Razón Social / Titularidad legal del servicio"]
        H2["CUIT / Identificación tributaria"]
        H3["Domicilio legal constituido"]
        H4["Tribunales competentes y jurisdicción aplicable"]
        H5["Designación formal del responsable de protección de datos"]
    end
```

---

## 2. Borrador: Política de Privacidad (Privacy Policy)

**Última actualización:** `[FECHA DE LANZAMIENTO PÚBLICO]`

### 1. Responsable del Tratamiento
El presente servicio digital PuntoEncuentro (en adelante, la "Plataforma") es operado por `[NOMBRE / RAZÓN SOCIAL DEL RESPONSABLE]`, con domicilio en `[DOMICILIO LEGAL / CIUDAD, PROVINCIA, PAÍS]` y correo de contacto `[EMAIL DE CONTACTO OFICIAL]`.

### 2. Datos Personales que Recopilamos
PuntoEncuentro aplica el principio de **minimización de datos**:
- **Cuentas y Autenticación:** Para usuarios autenticados mediante Google OAuth, recopilamos identificador de usuario (`sub`), nombre visible y dirección de correo electrónico provista por el proveedor de identidad. No almacenamos contraseñas de Google.
- **Participación sin Registro (Invitados Anónimos):** Cuando un usuario participa mediante un enlace privado, se genera un identificador seudónimo único (`token_invitacion` UUID) almacenado localmente en el navegador. No se exige registro para coordinar fechas o confirmar asistencia privada.
- **Datos de Encuentros y Logística:** Título, descripción, fecha, hora, modalidad (presencial o virtual). En encuentros presenciales, la dirección exacta o punto de encuentro (`lugar_texto`) es confidencial y solo se revela a los participantes formalmente confirmados y al anfitrión. En la vista pública comunitaria (Discovery) únicamente se proyecta una zona territorial orientativa aproximada (`open_public_zone`).
- **Notificaciones Web Push:** Para usuarios que aceptan voluntariamente notificaciones en el navegador o dispositivo móvil, recopilamos el endpoint público y las claves criptográficas (`p256dh` y `auth`). Los payloads viajan cifrados bajo los estándares IETF RFC 8291 y RFC 8292.
- **Mensajería Interna:** Los mensajes publicados en el panel interno del encuentro son accesibles exclusivamente a los participantes confirmados y al anfitrión. Se aplica una política de retención automática tras la realización del evento.
- **Telemetría y Métricas de Rendimiento:** Eventos de uso anónimos y agregados para asegurar la estabilidad del servicio, sin seguimiento individualizado con fines comerciales de terceros. La retención máxima de telemetría operativa es de 90 días, tras lo cual se purga automáticamente.

### 3. Finalidad del Tratamiento
Los datos se utilizan exclusivamente para:
1. Permitir la creación, gestión, invitación y coordinación de encuentros sociales o de interés común.
2. Gestionar cupos, listas de espera y reconfirmaciones de asistencia.
3. Despachar avisos y recordatorios operativos de cambios logísticos o cancelaciones.
4. Prevenir abusos, suplantaciones o conductas perjudiciales mediante herramientas de moderación y reporte.
5. Calcular métricas objetivas y factuales de cumplimiento de asistencia para Encuentros Abiertos (sin scoring subjetivo ni valoraciones discriminatorias).

### 4. Seguridad y Aislamiento de la Información
- La plataforma implementa Seguridad a Nivel de Fila (Row Level Security - RLS) en la base de datos para asegurar que ningún usuario pueda consultar información logística ni de contacto a la que no esté formalmente autorizado.
- Las funciones privilegiadas operan bajo el principio de menor privilegio (`SECURITY DEFINER` con `search_path` aislado).

### 5. Derechos del Usuario (Acceso, Rectificación, Supresión y Transferencia)
El usuario puede en cualquier momento:
- **Rectificar sus datos:** Modificar su perfil o actualizar su estado de asistencia.
- **Transferir titularidad:** Si un usuario comenzó como invitado anónimo y decide iniciar sesión permanente con Google, el protocolo Transfer Ticket permite migrar sus encuentros y asistencias sin pérdida de historial.
- **Supresión de Datos (Derecho al Olvido):** El usuario puede solicitar la baja de su cuenta y la eliminación de sus datos personales enviando un correo a `[EMAIL DE CONTACTO OFICIAL]`. Los encuentros pasados preservarán únicamente el registro numérico disociado necesario para la coherencia histórica del servicio.

### 6. Jurisdicción y Autoridad de Aplicación
`[DEFINIR SEGÚN PAÍS/JURISDICCIÓN, EJ: En la República Argentina, de conformidad con la Ley N° 25.326 de Protección de los Datos Personales, la Agencia de Acceso a la Información Pública es el órgano de control]`.

---

## 3. Borrador: Términos y Condiciones de Uso

**Última actualización:** `[FECHA DE LANZAMIENTO PÚBLICO]`

### 1. Naturaleza de la Plataforma
PuntoEncuentro es una plataforma tecnológica que facilita herramientas de software para que personas humanas organicen, coordinen y se sumen voluntariamente a encuentros presenciales o virtuales.
**PuntoEncuentro NO organiza, financia, auspicia, supervisa ni garantiza los eventos organizados por los usuarios**, actuando únicamente como canal de intermediación técnica.

### 2. Responsabilidad de los Participantes y Encuentros Presenciales
- **Carácter Voluntario:** La asistencia a cualquier encuentro presencial se realiza bajo la entera y exclusiva responsabilidad y riesgo de cada participante.
- **Seguridad Personal y Sentido Común:** Se exhorta a los usuarios a realizar los encuentros en lugares públicos iluminados, concurridos y seguros, e informar a allegados sobre su participación.
- **Conducta y Convivencia:** Los participantes deben guardar respeto mutuo y abstenerse de cualquier conducta violenta, discriminatoria, acosadora o ilícita.

### 3. Ciclo de Vida del Encuentro, Cupos y Asistencia
- **Compromiso de Asistencia:** En los Encuentros Abiertos, el anfitrión y los participantes asumen el compromiso de asistir puntualmente en la fecha y hora coordinadas.
- **Retiro y Lista de Espera:** Si un participante no puede asistir, debe registrar su retiro voluntario a través de la plataforma para liberar el cupo al siguiente postulante en la lista de espera.
- **Cierre Posterior y Registro de Hechos:** Concluido el evento, el anfitrión asentará el estado de asistencia efectivo de cada participante.
- **Derecho a Descargo y Controversias:** Si un participante fue reportado ausente de forma errónea, cuenta con un plazo perentorio de siete (7) días corridos para solicitar una revisión o descargo. Un equipo de moderación humana revisará las evidencias y rectificará la constancia fáctica si correspondiere.

### 4. Herramientas de Confianza, Bloqueo y Moderación
- **Bloqueo Bilateral:** Todo usuario puede bloquear a otro en cualquier momento. El bloqueo es bilateral e inmediato: impide ver iniciativas mutuas en Discovery, desestima postulaciones cruzadas y suprime notificaciones.
- **Reportes:** Los usuarios pueden reportar encuentros o conductas inapropiadas. PuntoEncuentro se reserva el derecho de cancelar encuentros, revocar cupos o suspender cuentas que infrinjan estos términos.

### 5. Limitación de Responsabilidad
En la máxima medida permitida por las leyes aplicables, `[NOMBRE / RAZÓN SOCIAL DEL RESPONSABLE]` no será responsable por daños indirectos, incidentales, extravíos, perjuicios o desavenencias personales ocurridas antes, durante o después de un encuentro físico entre particulares.

---

## 4. Borrador: Centro de Soporte y Contacto

### Canales Disponibles

1. **Soporte y Feedback In-App:**
   - Accesible directamente desde el menú de la aplicación: botón **"Dar feedback o reportar error"**.
   - Permite clasificar la consulta (problema técnico, sugerencia, consulta de asistencia) y adjuntar detalles contextuales sin intermediarios.
2. **Contacto Electrónico Oficial:**
   - **Consultas Generales y Soporte Técnico:** `[soporte@puntoencuentro.com.ar]`
   - **Reportes de Seguridad o Abusos:** `[seguridad@puntoencuentro.com.ar]`
   - **Consultas sobre Privacidad y Datos Personales:** `[privacidad@puntoencuentro.com.ar]`
3. **Plazos de Respuesta Estimados:**
   - Notificaciones de moderación urgente / reportes de contenido: dentro de las 24 horas hábiles.
   - Controversias de asistencia post-evento: dentro de la ventana de 7 días corridos.
   - Consultas de soporte operativo: entre 24 y 48 horas hábiles.
