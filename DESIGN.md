# Design Document: Punto Encuentro

## Modelo MVP (Sin Login)

El MVP de Punto Encuentro está diseñado para operar sin necesidad de autenticación de usuarios (sin login). Esto reduce la fricción de uso y permite organizar encuentros de forma instantánea mediante un **Modelo Basado en Links**.

### Flujo de Anfitrión (Host)
1. **Creación Rápida:** El usuario ingresa a la aplicación y crea un encuentro definiendo configuración básica, detalles y ubicación (presencial o virtual).
2. **Generación de Link:** Al finalizar el Paso 4, el sistema genera dos tipos de enlaces únicos:
   - **Link de Administración (Host):** Un enlace privado guardado localmente en el dispositivo del anfitrión (vía almacenamiento local/cookies) que le permite acceder a la pantalla "Detalle - Host" para ver quiénes han confirmado.
   - **Link de Invitación (Guest):** Un enlace público que el anfitrión comparte con sus invitados mediante WhatsApp u otros medios.

### Flujo de Invitado (Guest)
1. **Acceso Inmediato:** El invitado recibe el "Link de Invitación" y al hacer clic, accede directamente a la pantalla de "Invitación Individual".
2. **Confirmación:** El invitado revisa los detalles del encuentro e ingresa su nombre (y opcionalmente otra información básica) para confirmar su asistencia.
3. **Registro:** La confirmación se envía al backend y el estado se actualiza en el panel del anfitrión. El invitado es redirigido a la pantalla de "Éxito - Confirmado".

### Seguridad y Persistencia
- **Anonimato Controlado:** Dado que no hay cuentas de usuario, la identidad de los invitados se basa en la autodeclaración al momento de confirmar.
- **Persistencia Local:** Los encuentros creados por un anfitrión se guardan en el almacenamiento local de su dispositivo para que pueda volver a acceder a su panel de administración sin perder los datos.
- **Links Únicos:** Se utilizarán identificadores criptográficamente seguros (UUIDs) para los enlaces, evitando que puedan ser adivinados.
---
# 🔧 Modelo Técnico MVP (Sin Login basado en Links)
---

# 🔧 Modelo Técnico MVP (Sin Login basado en Links)

## 🎯 Enfoque general

El MVP de “Encuentros” funciona sin autenticación de usuarios, priorizando:

- velocidad  
- simplicidad  
- mínima fricción  

La interacción se basa en:

- enlaces únicos (UUID)  
- identidad local simple (nombre + identificador local)  

---

## 🧩 Identidad del usuario (sin login)

- Al ingresar por primera vez:
  - el usuario introduce su nombre
  - el nombre se guarda en almacenamiento local (localStorage)

- El sistema genera un identificador único local (`device_id` UUID)

- Este identificador se utiliza para:
  - asociar respuestas del usuario
  - evitar duplicaciones
  - identificar al usuario en ese dispositivo

---

## 🔗 Tipos de enlaces

### 1. Link de administración (Host)
- Se genera al crear el encuentro
- Permite:
  - ver detalle completo
  - gestionar invitados
  - compartir enlace
- Debe mantenerse privado

---

### 2. Link público del encuentro
- Permite acceso abierto
- No requiere login

Flujo:
1. El usuario ingresa su nombre
2. Accede al resumen del encuentro
3. Puede confirmar o rechazar asistencia

---

### 3. (Futuro) Link individual
- Asociado a un invitado específico
- Permite identificación directa
- No se implementa en el MVP

---

## 👥 Estados de participantes

- `pendiente`  
- `confirmado`  
- `rechazado`  

### Reglas:
- El usuario puede cambiar su estado  
- La última acción reemplaza la anterior  
- Debe existir un solo estado activo por usuario por encuentro  

---

## 📅 Estados del encuentro

MVP:
- `activo`  

Futuro:
- `finalizado`  
- `cancelado`  

---

## 🔄 Actualización de datos

- Los datos se cargan al ingresar a cada pantalla  
- No se requiere tiempo real en el MVP  
- Se actualiza:
  - al refrescar  
  - al reingresar  

---

## 🧠 Gestión de confirmaciones

- Cada confirmación o rechazo:
  - actualiza el estado en la base de datos  

- Para evitar duplicaciones:
  - se utiliza `device_id` + `encuentro_id`  

- Si el usuario vuelve a ingresar:
  - se actualiza el registro existente  

---

## 🔐 Seguridad (MVP)

- Los enlaces utilizan UUID  
- No se exponen datos sensibles  
- No hay autenticación  
- El acceso depende del link  

---

## 💾 Persistencia local

Se guarda en el dispositivo:

- `user_name`  
- `device_id`  

Objetivo:

- evitar reingreso  
- mejorar experiencia  

---

# 🗄️ Modelo de Datos (Supabase)

## Tabla: encuentros

Campos sugeridos:

- `id` (UUID)  
- `titulo`  
- `descripcion` (nullable)  
- `fecha_hora`  
- `modalidad` (presencial | virtual)  
- `lugar_texto` (nullable)  
- `link_virtual` (nullable)  
- `tipo_invitacion` (individual | link)  
- `estado` (activo)  
- `created_at`  

---

## Tabla: participantes

Campos sugeridos:

- `id` (UUID)  
- `encuentro_id`  
- `nombre`  
- `device_id`  
- `tipo_invitacion`  
- `token_invitacion` (nullable)  
- `estado` (pendiente | confirmado | rechazado)  
- `created_at`  
- `updated_at`  

---

## Reglas clave

- Un participante es único por:
  👉 (`encuentro_id` + `device_id`)  

- Para link público:
  - se crea participante al confirmar  

- Para invitados manuales:
  - se crean en estado `pendiente`  

---

# 🔁 Flujo funcional completo

## Creación

1. Host crea encuentro  
2. Se guarda en base de datos  
3. Se genera:
   - link público  
   - link host  

---

## Invitación

### Opción A — Invitados manuales
- Se agregan nombres  
- Estado inicial: `pendiente`  

### Opción B — Link público
- Se comparte enlace  
- El usuario se registra al ingresar  

---

## Confirmación

1. Usuario entra por link  
2. Ingresa nombre (si no existe)  
3. Confirma o rechaza  
4. Se guarda estado  

---

## Visualización

- Host ve:
  - Confirmados  
  - Pendientes  
  - Rechazados  

---

# 🧭 Reglas UX (alineadas al diseño)

- Una acción principal por pantalla  
- Sin fricción  
- Inputs simples  
- Feedback inmediato  
- Mobile-first  
- No sobrecargar información  

---

# 🚫 Fuera del MVP (NO implementar)

- login / autenticación  
- reputación de usuarios  
- cupos automáticos  
- co-host  
- calendario  
- notificaciones push  
- mapas integrados  
- QR  
- integraciones externas (WhatsApp, etc.)  

---

# 🚀 Objetivo del MVP

Validar:

- creación de encuentros  
- uso de links  
- confirmación de asistencia  
- adopción real frente a WhatsApp  

---

# 🧠 Resultado

Este modelo permite:

- rapidez de uso  
- baja fricción  
- implementación simple  
- validación temprana  