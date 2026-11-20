# Directrices de seguridad para aplicaciones y servidores

Este documento dice **qué controles de seguridad debe cumplir cada aplicación y cada servidor** de los proyectos que
vigila Jano. Cada requisito tiene un código (`APP-01`, `SRV-01`…) y la referencia al control del estándar del que
sale, para poder auditarlo. Lo que tiene que ver con registros está en [`directrices-logs.md`](directrices-logs.md) y
aquí solo se enlaza.

> **Alcance.** Es una guía de trabajo alineada con los estándares, no una certificación. Cumplirla no equivale a estar
> certificado en ISO/IEC 27001 ni a una evaluación formal del NIST: para eso hacen falta el sistema de gestión completo
> (política, análisis de riesgos, declaración de aplicabilidad, auditorías) y un auditor. Los números de control son
> referencias; el texto oficial es el de cada estándar.

## 1. Estándares de referencia

| Estándar | Para qué se usa aquí | Cómo se cita |
|---|---|---|
| **ISO/IEC 27001:2022**, Anexo A (y su guía ISO/IEC 27002:2022) | Catálogo de controles: organizativos (5), de personas (6), físicos (7) y tecnológicos (8). | `ISO 8.5` |
| **NIST Cybersecurity Framework (CSF) 2.0** | Las seis funciones que ordenan el trabajo: Gobernar, Identificar, Proteger, Detectar, Responder y Recuperar. | `CSF PR.AA` |
| **NIST SP 800-53 Rev. 5** | Controles detallados por familia (acceso, auditoría, configuración…). | `AC-6` |
| **NIST SP 800-63B** | Contraseñas y autenticación. | `800-63B` |
| **NIST SP 800-218 (SSDF)** | Desarrollo seguro de software. | `SSDF` |
| **NIST SP 800-123, 800-190, 800-52, 800-40, 800-61, 800-34, 800-92** | Servidores, contenedores, TLS, parches, incidentes, contingencia y gestión de logs. | por su número |
| **OWASP ASVS y OWASP Top 10** | Requisitos verificables y riesgos más comunes de las aplicaciones web. | `ASVS`, `Top 10` |
| **CIS Controls v8 y CIS Benchmarks** | Controles priorizados y guías de endurecimiento por sistema (Ubuntu, Docker, PostgreSQL, nginx). | `CIS 4` |
| **PCI DSS 4.0** | Solo si el proyecto toca datos de tarjetas. | `PCI` |
| **Ley 1581 de 2012** (Colombia) | Protección de datos personales. | `Ley 1581` |

Las funciones del CSF, como mapa de todo el documento:

| Función | Pregunta | Dónde se cubre |
|---|---|---|
| **Gobernar** (GV) | ¿Quién responde y con qué reglas? | Secciones 2 y 7 |
| **Identificar** (ID) | ¿Qué tenemos y qué riesgo corre? | Sección 2 |
| **Proteger** (PR) | ¿Cómo evitamos el incidente? | Secciones 3 y 4 |
| **Detectar** (DE) | ¿Cómo nos enteramos? | Sección 5 y `directrices-logs.md` |
| **Responder** (RS) | ¿Qué hacemos cuando pasa? | Sección 6 |
| **Recuperar** (RC) | ¿Cómo volvemos a operar? | Sección 6 |

**Niveles.** Cada requisito es **Obligatorio** (sin él el proyecto no sale a producción) o **Recomendado** (se
planea y se deja fecha). Una excepción a un obligatorio se escribe: qué no se cumple, por qué, qué lo compensa, quién
la aprobó y hasta cuándo.

## 2. Reglas comunes a todo proyecto

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `GEN-01` | **Responsable con nombre.** Cada aplicación y cada servidor tiene un responsable y un suplente. | Obligatorio | ISO 5.2 · CSF GV.RR |
| `GEN-02` | **Inventario.** Lista al día de aplicaciones, servidores, bases de datos, dominios, certificados y servicios de terceros, con su responsable y su entorno. | Obligatorio | ISO 5.9 · CSF ID.AM · CM-8 · CIS 1 y 2 |
| `GEN-03` | **Clasificación de la información.** Cada proyecto dice qué datos maneja: públicos, internos, personales o sensibles (salud, menores, financieros). La clasificación decide los controles. | Obligatorio | ISO 5.12 · CSF ID.AM |
| `GEN-04` | **Análisis de riesgos** al empezar y con cada cambio grande: qué puede salir mal, qué tan probable y grave es, y qué se hace. | Obligatorio | ISO 27001 cláusula 6.1 · CSF ID.RA · RA-3 |
| `GEN-05` | **Mínimo privilegio.** Personas, aplicaciones y servicios tienen solo los permisos que necesitan, por el tiempo que los necesitan. | Obligatorio | ISO 5.15 y 8.2 · CSF PR.AA · AC-6 |
| `GEN-06` | **Entornos separados.** Desarrollo, pruebas y producción no comparten base de datos, credenciales ni claves. En pruebas no se usan datos reales sin enmascarar. | Obligatorio | ISO 8.31 y 8.33 · CM-4 |
| `GEN-07` | **Datos personales.** Se recoge lo mínimo, con autorización y finalidad declarada, y se atienden las solicitudes de consulta, corrección y supresión. | Obligatorio | ISO 5.34 · Ley 1581 |
| `GEN-08` | **Proveedores.** Los servicios de terceros (nube, mensajería, modelos de IA, pagos) se listan con qué datos reciben; no se les envía más de lo necesario. | Obligatorio | ISO 5.19 a 5.23 · CSF GV.SC · SR-3 |
| `GEN-09` | **Cambios controlados.** Todo cambio a producción pasa por el repositorio, con revisión y forma de devolverlo. | Obligatorio | ISO 8.32 · CM-3 |
| `GEN-10` | **Formación.** Quien desarrolla u opera conoce estas directrices y el OWASP Top 10. | Recomendado | ISO 6.3 · CSF PR.AT |

## 3. Aplicaciones

### Identidad, autenticación y sesiones

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `APP-01` | **Contraseñas con las reglas del NIST.** Largo mínimo de 15 caracteres si es el único factor y de 8 si hay segundo factor; se permiten al menos 64, con espacios y cualquier carácter. Sin reglas de composición (mayúscula, símbolo) y sin cambio periódico obligatorio: se cambian cuando hay indicio de filtración. Se rechazan las que aparecen en listas de contraseñas filtradas o comunes. | Obligatorio | 800-63B · ISO 5.17 · IA-5 |
| `APP-02` | **Contraseñas guardadas con una función de derivación lenta y con sal** (Argon2id; bcrypt o scrypt como alternativa). Nunca en texto claro, cifradas de forma reversible ni con MD5 o SHA sin más. | Obligatorio | 800-63B · ISO 8.5 y 8.24 · ASVS |
| `APP-03` | **Segundo factor** para administradores y para todo acceso a datos sensibles. De preferencia aplicación de códigos o llave física; el SMS es el último recurso. | Obligatorio | ISO 8.5 · IA-2 · CIS 6 |
| `APP-04` | **Freno a la fuerza bruta.** Límite de intentos por cuenta y por dirección, con espera creciente. Un intento rechazado responde 401, 403 o 429 (así además lo ve Jano). | Obligatorio | AC-7 · 800-63B · ASVS |
| `APP-05` | **Sesiones seguras.** Identificador aleatorio generado en el servidor; cookie con `HttpOnly`, `Secure` y `SameSite`; vence por inactividad y por tiempo total; se invalida al cerrar sesión y al cambiar la contraseña. | Obligatorio | ISO 8.5 · AC-12 · SC-23 · ASVS |
| `APP-06` | **Recuperación de cuenta** con enlace de un solo uso y vida corta; la respuesta no revela si el correo existe. | Obligatorio | 800-63B · ASVS |
| `APP-07` | **Mensajes de error iguales** para usuario inexistente y contraseña incorrecta. | Obligatorio | ASVS · Top 10 (fallos de autenticación) |

### Autorización

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `APP-08` | **Se niega por defecto** y se verifica en el servidor en cada petición; ocultar un botón no es un control. | Obligatorio | ISO 8.3 · AC-3 · Top 10 (control de acceso roto) |
| `APP-09` | **Verificación por objeto.** Además del rol, se comprueba que el registro pedido pertenece a quien lo pide (un usuario no lee el registro `124` cambiando el número en la URL). | Obligatorio | AC-3 · ASVS |
| `APP-10` | **Roles definidos y revisados** al menos cada seis meses; las cuentas de quien se va se desactivan el mismo día. | Obligatorio | ISO 5.18 · AC-2 · CIS 5 y 6 |
| `APP-11` | **Funciones administrativas aparte**, con segundo factor y registro de cada acción. | Obligatorio | ISO 8.2 · AC-6 |

### Entradas, salidas y manejo de datos

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `APP-12` | **Toda entrada se valida en el servidor** contra lo que se espera (tipo, largo, formato, lista de valores), venga de un formulario, una API, un archivo o un webhook. | Obligatorio | ISO 8.26 y 8.28 · SI-10 · ASVS |
| `APP-13` | **Consultas parametrizadas** (o el ORM bien usado). Nunca se arma SQL, comandos del sistema ni rutas de archivo pegando texto del usuario. | Obligatorio | ISO 8.28 · SI-10 · Top 10 (inyección) |
| `APP-14` | **La salida se codifica según el contexto** (HTML, atributo, JavaScript, URL) para evitar XSS; se usa el escape de la plantilla o del framework, no uno propio. | Obligatorio | ISO 8.28 · ASVS |
| `APP-15` | **Carga de archivos controlada:** tipo verificado por contenido, tamaño máximo, nombre generado por el servidor, guardado fuera de la raíz web y sin permiso de ejecución. | Obligatorio | ASVS · SI-3 |
| `APP-16` | **Peticiones salientes restringidas.** Si la aplicación pide URLs que da el usuario, lista de destinos permitidos y bloqueo de direcciones internas (SSRF). | Obligatorio | Top 10 (SSRF) · SC-7 |
| `APP-17` | **Protección contra CSRF** en toda acción que cambie datos con sesión por cookie. | Obligatorio | ASVS |
| `APP-18` | **Cabeceras de seguridad:** `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` y control de marcos (`frame-ancestors`). CORS con lista de orígenes, nunca `*` con credenciales. | Obligatorio | ASVS · ISO 8.26 |
| `APP-19` | **Errores sin detalles hacia fuera.** El usuario ve un mensaje general y un identificador; la traza queda en el log. Modo depuración apagado en producción. | Obligatorio | SI-11 · Top 10 (configuración insegura) |
| `APP-20` | **Límites de uso** por usuario y por dirección en inicio de sesión, registro, recuperación, búsquedas y todo lo que cueste dinero (mensajes, llamadas a un modelo de IA). | Obligatorio | SC-5 · ASVS |
| `APP-21` | **El texto de terceros es dato, no orden.** Lo que escribe un usuario, llega en un correo, un log o un documento nunca se ejecuta ni se obedece como instrucción, tampoco por un modelo de IA; las acciones del modelo pasan por una lista cerrada y con permisos. | Obligatorio | OWASP Top 10 para aplicaciones con LLM (inyección de instrucciones) · SI-10 |

### Secretos y criptografía

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `APP-22` | **Ningún secreto en el repositorio**, en la imagen de Docker ni en el código del navegador. Van en variables de entorno o en un gestor de secretos; `.env` está en `.gitignore` y el repositorio se revisa con un detector de secretos. | Obligatorio | ISO 5.17 y 8.24 · IA-5 · SC-12 |
| `APP-23` | **Un secreto por entorno y por uso**, largo y al azar. Se rota al menos una vez al año, cuando alguien con acceso se va y de inmediato si se filtró (también si apareció en un log). | Obligatorio | ISO 8.24 · SC-12 |
| `APP-24` | **Todo viaja cifrado:** HTTPS con TLS 1.2 o superior (de preferencia 1.3) de cara al usuario y también entre servicios y hacia la base de datos. HTTP solo redirige. | Obligatorio | ISO 8.24 · SC-8 · 800-52 |
| `APP-25` | **Lo sensible se cifra en reposo:** disco o volumen cifrado y, para los campos más delicados, cifrado en la aplicación con la clave fuera de la base. | Obligatorio para datos sensibles | ISO 8.24 · SC-28 · CSF PR.DS |
| `APP-26` | **Algoritmos estándar y bibliotecas mantenidas.** Nada de criptografía propia; aleatoriedad del sistema para tokens e identificadores. | Obligatorio | ISO 8.24 · SC-13 |
| `APP-27` | **Datos enmascarados** en pantallas, exportaciones y logs cuando no hace falta el valor completo (documento, teléfono, tarjeta). | Recomendado | ISO 8.11 · Ley 1581 |

### Desarrollo y entrega

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `APP-28` | **Requisitos de seguridad desde el diseño**, con un modelo de amenazas sencillo para lo nuevo que toque autenticación, pagos o datos sensibles. | Recomendado | ISO 8.25 a 8.27 · SSDF · SA-8 |
| `APP-29` | **Revisión de código** por otra persona antes de unir a la rama principal; rama principal protegida. | Obligatorio | ISO 8.4 y 8.28 · SSDF · CIS 16 |
| `APP-30` | **Dependencias vigiladas:** archivo de bloqueo en el repositorio, revisión automática de vulnerabilidades (`npm audit`, Dependabot o similar) y actualización con los plazos de `SRV-09`. Sin paquetes abandonados. | Obligatorio | ISO 8.8 · SSDF · SR-3 · Top 10 (componentes vulnerables) |
| `APP-31` | **Pruebas de seguridad** antes de publicar: análisis estático en cada cambio y una prueba dinámica o de penetración antes de la primera salida y después de cambios grandes. | Obligatorio (estático) · Recomendado (penetración) | ISO 8.29 · SA-11 · RA-5 |
| `APP-32` | **La entrega es automática y repetible** desde el repositorio; nadie edita archivos a mano en producción. | Obligatorio | ISO 8.32 · CM-3 · SSDF |
| `APP-33` | **Registro de eventos de seguridad** según [`directrices-logs.md`](directrices-logs.md): tabla de la aplicación en el esquema `apps`, sin secretos. | Obligatorio | ISO 8.15 · AU-2, AU-3 · 800-92 |

## 4. Servidores

### Endurecimiento y acceso

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `SRV-01` | **Configuración base escrita y repetible** (script, Ansible o imagen), tomando como guía el CIS Benchmark del sistema. | Obligatorio | ISO 8.9 · CM-2, CM-6 · CIS 4 · 800-123 |
| `SRV-02` | **Lo mínimo instalado y escuchando.** Se quitan paquetes y servicios que no se usan; cada puerto abierto tiene dueño y motivo. | Obligatorio | ISO 8.9 y 8.19 · CM-7 · 800-123 |
| `SRV-03` | **SSH solo con llave,** sin inicio de sesión de `root` y sin contraseñas (`PermitRootLogin no`, `PasswordAuthentication no`). Acceso de administración solo desde direcciones conocidas o por VPN. | Obligatorio | ISO 8.5 y 8.20 · AC-17 · IA-2 |
| `SRV-04` | **Cuentas personales.** Cada persona entra con su usuario y eleva con `sudo`; no hay cuentas compartidas. Las cuentas de servicio no tienen intérprete de comandos ni contraseña. | Obligatorio | ISO 5.16 y 8.2 · AC-2, AC-6 · CIS 5 |
| `SRV-05` | **Freno a los intentos repetidos** (fail2ban o equivalente) en SSH y en los servicios publicados, con aviso por el webhook de alertas. | Obligatorio | AC-7 · SI-4 |
| `SRV-06` | **Hora sincronizada** por NTP en todos los equipos. | Obligatorio | ISO 8.17 · AU-8 |
| `SRV-07` | **Protección contra programas maliciosos** donde aplique (equipos Windows, servidores que reciben archivos de usuarios). | Obligatorio donde aplique | ISO 8.7 · SI-3 · CIS 10 |
| `SRV-08` | **Integridad de archivos críticos** vigilada (`auditd`, AIDE o el agente de Wazuh) en `/etc`, llaves SSH, tareas programadas y binarios. | Recomendado | ISO 8.16 · SI-7 |

### Parches y vulnerabilidades

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `SRV-09` | **Parches con plazo.** Actualizaciones de seguridad automáticas del sistema. Plazos de este documento, contados desde que hay corrección: **crítica o explotada activamente, 7 días; alta, 30 días; media, 90 días.** Aplican también a imágenes de contenedor y dependencias. | Obligatorio | ISO 8.8 · SI-2 · 800-40 · CIS 7 |
| `SRV-10` | **Escaneo de vulnerabilidades** mensual de los servidores y de lo publicado en internet, y después de cada cambio grande. | Obligatorio | ISO 8.8 · RA-5 · CIS 7 |
| `SRV-11` | **Solo sistemas con soporte.** Ninguna versión de sistema operativo, base de datos o lenguaje sin actualizaciones de seguridad. | Obligatorio | ISO 8.8 · SA-22 |

### Red

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `SRV-12` | **Cortafuegos que niega por defecto** la entrada y permite solo lo publicado. Las conexiones bloqueadas se registran. | Obligatorio | ISO 8.20 · SC-7 · CIS 12 y 13 |
| `SRV-13` | **Redes separadas.** La base de datos, los paneles de administración y los servicios internos no se publican en internet: red interna o VPN. | Obligatorio | ISO 8.22 · SC-7 · AC-4 |
| `SRV-14` | **Proxy inverso al frente** de las aplicaciones: termina TLS, pone límites de tamaño y de ritmo y entrega la dirección real del cliente. | Obligatorio | ISO 8.20 y 8.21 · SC-7 |
| `SRV-15` | **Certificados vigentes y renovados solos;** el vencimiento se vigila. | Obligatorio | ISO 8.24 · SC-17 · 800-52 |
| `SRV-16` | **Salida controlada.** Los servidores salen a internet solo hacia lo que necesitan. | Recomendado | ISO 8.20 y 8.23 · SC-7 |

### Contenedores

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `SRV-17` | **El contenedor no corre como `root`,** no es privilegiado y no monta el socket de Docker. | Obligatorio | 800-190 · AC-6 · CIS Benchmark de Docker |
| `SRV-18` | **Imágenes oficiales o propias,** con versión fija (no `latest`), lo más pequeñas posible y escaneadas antes de desplegar. | Obligatorio | 800-190 · ISO 8.8 · SR-3 |
| `SRV-19` | **Sin secretos en la imagen** ni en sus capas; llegan al arrancar. | Obligatorio | 800-190 · IA-5 |
| `SRV-20` | **Límites de memoria y de procesador,** sistema de archivos de solo lectura donde se pueda y volúmenes solo para lo que debe persistir. | Recomendado | 800-190 · SC-5 |
| `SRV-21` | **Solo se publican los puertos necesarios;** lo interno se queda en la red de Docker. Un puerto publicado por Docker se salta UFW: se comprueba desde fuera. | Obligatorio | 800-190 · SC-7 |

### Bases de datos

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `SRV-22` | **Un usuario por aplicación,** con permisos solo sobre sus tablas. La aplicación nunca se conecta como superusuario ni como dueña del esquema si no hace falta. | Obligatorio | ISO 8.3 · AC-6 |
| `SRV-23` | **Sin acceso desde internet;** conexión cifrada y autenticada (en PostgreSQL, `scram-sha-256`). | Obligatorio | ISO 8.20 y 8.24 · SC-8 · IA-5 |
| `SRV-24` | **Auditoría de la base:** conexiones fallidas, cambios de permisos y de esquema. | Obligatorio | ISO 8.15 · AU-2 |

### Respaldo y continuidad

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `SRV-25` | **Respaldo automático diario** de bases de datos y de lo que no se puede regenerar, con la regla 3-2-1: tres copias, en dos medios, una fuera del equipo y del proveedor. | Obligatorio | ISO 8.13 · CP-9 · CIS 11 · CSF PR.DS |
| `SRV-26` | **Respaldos cifrados** y con acceso separado: quien compromete el servidor no puede borrar las copias. | Obligatorio | ISO 8.13 y 8.24 · CP-9 |
| `SRV-27` | **Restauración probada** al menos cada tres meses, en un entorno vacío, midiendo cuánto tarda. Un respaldo que no se ha restaurado no cuenta. | Obligatorio | ISO 8.13 · CP-4, CP-10 · CSF RC.RP |
| `SRV-28` | **Objetivos escritos por sistema:** cuánto se puede perder (RPO) y en cuánto tiempo debe volver (RTO). | Obligatorio | ISO 5.30 · CP-2 · 800-34 |
| `SRV-29` | **Borrado seguro** de discos, volúmenes y respaldos al retirarlos. | Obligatorio | ISO 7.14 y 8.10 · MP-6 |

## 5. Registro y vigilancia

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `MON-01` | **Logs según [`directrices-logs.md`](directrices-logs.md):** aplicaciones en el esquema `apps`, servidores en el esquema `servers`, una tabla por cada uno. | Obligatorio | ISO 8.15 · AU-2, AU-3, AU-12 · 800-92 · CIS 8 |
| `MON-02` | **Logs protegidos:** quien escribe solo inserta, hay copia fuera del equipo y la retención es de 90 días a la mano y 12 meses archivados para lo de seguridad. | Obligatorio | ISO 8.15 · AU-9, AU-11 |
| `MON-03` | **Revisión de los logs.** Jano, como analista de nivel 1, los revisa y le informa a Camilo; lo urgente avisa por el webhook de alertas. | Obligatorio | ISO 8.16 · AU-6 · SI-4 · CSF DE.CM, DE.AE |
| `MON-04` | **Vigilancia de disponibilidad:** `GET /health` (o equivalente) revisado desde fuera, con aviso si cae. | Obligatorio | ISO 8.16 · CSF DE.CM |
| `MON-05` | **Detector de intrusos o SIEM** (Suricata, Wazuh) cuando el proyecto maneja datos sensibles o tiene varios servidores. | Recomendado | ISO 8.16 · SI-4 · CIS 13 |

## 6. Incidentes y recuperación

| Código | Requisito | Nivel | Referencia |
|---|---|---|---|
| `INC-01` | **Plan de respuesta escrito:** a quién se avisa, quién decide y los pasos para lo más probable (cuenta comprometida, secreto filtrado, servidor intervenido, fuga de datos, secuestro de datos). | Obligatorio | ISO 5.24 · IR-8 · 800-61 · CSF RS.MA |
| `INC-02` | **Clasificación por gravedad** con la escala de `directrices-logs.md` (`baja`, `media`, `alta`, `critica`). Un intento no es una intrusión: la gravedad sube con evidencia de éxito. | Obligatorio | ISO 5.25 · IR-4 · CSF RS.AN |
| `INC-03` | **Contener, erradicar y recuperar,** en ese orden: aislar el equipo, cortar el acceso, rotar las credenciales expuestas, reconstruir desde una fuente limpia y restaurar. | Obligatorio | ISO 5.26 · IR-4 · CSF RS.MI, RC.RP |
| `INC-04` | **Conservar la evidencia** antes de limpiar: logs, imágenes de disco y capturas, con hora y quién las tomó. | Obligatorio | ISO 5.28 · AU-9 · IR-4 |
| `INC-05` | **Avisar a quien corresponde:** responsables internos, afectados y autoridad. Los incidentes con datos personales se reportan a la Superintendencia de Industria y Comercio según sus plazos. | Obligatorio | ISO 5.26 · IR-6 · CSF RS.CO · Ley 1581 |
| `INC-06` | **Lecciones aprendidas** por escrito después de cada incidente `alta` o `critica`: qué pasó, por qué no se detectó antes y qué se cambia. | Obligatorio | ISO 5.27 · IR-4 · CSF ID.IM |
| `INC-07` | **Simulacro** al menos una vez al año (en Jano, una alerta manual desde el panel sirve para practicarlo). | Recomendado | IR-3 · CP-4 |

## 7. Cómo se aplica y se revisa

1. **Al empezar un proyecto:** inventario, clasificación de datos y análisis de riesgos (`GEN-02` a `GEN-04`).
2. **Antes de salir a producción:** todos los obligatorios cumplidos o con excepción escrita.
3. **Cada seis meses:** revisión de accesos, de excepciones y de esta lista.
4. **Cada año:** revisión del documento contra las versiones vigentes de los estándares.
5. **Evidencia:** cada requisito cumplido deja algo que se puede mostrar (una configuración, una captura, un informe,
   un registro). Sin evidencia, en una auditoría no cuenta.

### Lista de comprobación de una aplicación

- [ ] Tiene responsable, está en el inventario y sus datos están clasificados.
- [ ] Contraseñas con las reglas del NIST y guardadas con Argon2id o bcrypt; segundo factor para administradores.
- [ ] Hay límite de intentos de inicio de sesión y los rechazos responden 401, 403 o 429.
- [ ] La autorización se verifica en el servidor, por rol y por objeto.
- [ ] Las entradas se validan en el servidor y las consultas son parametrizadas.
- [ ] Tiene cabeceras de seguridad, protección CSRF y CORS con lista de orígenes.
- [ ] No hay secretos en el repositorio ni en la imagen; cada entorno tiene los suyos.
- [ ] Todo el tráfico va por TLS 1.2 o superior; los datos sensibles están cifrados en reposo.
- [ ] Las dependencias se revisan de forma automática y no hay vulnerabilidades críticas o altas fuera de plazo.
- [ ] Hay revisión de código, análisis estático y entrega automática.
- [ ] Los errores no muestran trazas y la depuración está apagada en producción.
- [ ] Registra sus eventos de seguridad en su tabla del esquema `apps`.

### Lista de comprobación de un servidor

- [ ] Tiene responsable, está en el inventario y su configuración base es repetible.
- [ ] SSH solo con llave, sin `root`, con cuentas personales y freno a intentos repetidos.
- [ ] Solo están instalados y escuchando los servicios necesarios; el cortafuegos niega por defecto.
- [ ] La base de datos y los paneles no son accesibles desde internet (comprobado desde fuera).
- [ ] Actualizaciones de seguridad automáticas, parches dentro de plazo y escaneo mensual.
- [ ] Los contenedores no corren como `root`, usan imágenes con versión fija y no llevan secretos.
- [ ] La hora está sincronizada por NTP.
- [ ] Hay respaldo diario cifrado, con copia fuera, y la restauración se probó en los últimos tres meses.
- [ ] Los logs llegan a su tabla del esquema `servers` y Jano los revisa.
- [ ] Hay vigilancia de disponibilidad y de vencimiento de certificados.
- [ ] Existe el plan de respuesta a incidentes y se sabe a quién avisar.
