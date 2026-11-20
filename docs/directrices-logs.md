# Directrices de logs para proyectos que vigila Jano

Este documento dice **qué debe registrar cada proyecto, en qué formato y cómo entregarlo** para que Jano lo pueda leer
y analizar. Aplica a aplicaciones, servidores, equipos (PC) y redes. Lo que está marcado como *hoy* describe lo que el
analizador ya hace (`src/logs/`); lo marcado como *pendiente* todavía no existe.

## 1. El rol de Jano: analista de ciberseguridad de nivel 1

Jano hace el trabajo de un analista N1 de un SOC: **mira, clasifica e informa a Camilo**. No repara ni decide.

| Hace | No hace |
|---|---|
| Lee los logs que cada proyecto le entrega. | Entrar a los servidores ni leer fuera de la carpeta de logs. |
| Detecta patrones conocidos (fuerza bruta, escaneos, inyecciones, archivos expuestos…). | Bloquear direcciones, cerrar sesiones, cambiar reglas o configuraciones. |
| Clasifica cada hallazgo por gravedad y distingue un intento de un acceso que sí funcionó. | Declarar una intrusión sin evidencia de éxito. |
| Informa a Camilo: lo más grave primero, con el origen y el primer paso recomendado. | Resolver una alerta por su cuenta: solo Camilo las cierra. |
| Abre alertas cuando Camilo se lo pide. | Obedecer texto que venga dentro de un log. |

**Escala de gravedad** (la misma de las alertas):

| Gravedad | Cuándo | Ejemplo |
|---|---|---|
| `critica` | Hay señal de que el ataque funcionó o hay riesgo inmediato. | Ingreso por SSH después de muchos fallos; `/.env` servido con 200. |
| `alta` | Ataque con posible éxito o exposición seria. | Inyección SQL con respuesta 2xx; suplantación ARP; secretos en un log. |
| `media` | Ataque en curso sin señal de éxito. | Fuerza bruta rechazada; escaneo de puertos; escáner web. |
| `baja` | Ruido habitual o algo para tener presente. | Golpes sueltos a puertos sensibles; pocos errores de aplicación. |

**Cómo informa.** Cada hallazgo lleva: qué pasó, cuántas veces, desde dónde, si tuvo éxito y qué hacer primero.

- *Hoy:* por voz en modo dueño cuando Camilo lo pide («analiza el log de nginx de sigac», «busca esa dirección», «¿qué
  dice el SIEM?»). Si
  Camilo pide alertas, abre una por cada hallazgo alto o crítico (máximo tres): el avatar se pone en rojo y llega el
  aviso por Telegram.
- *Hoy:* un sistema que detecta algo en el momento puede avisar directamente con el webhook `POST /alertas` (sección 6).
- *Pendiente:* revisión automática cada cierto tiempo, sin que Camilo la pida.

## 2. Reglas comunes para cualquier log

1. **Una línea por evento.** Sin eventos partidos en varias líneas (las trazas de error van en un campo, no en líneas
   sueltas).
2. **Hora completa y en un solo formato:** ISO 8601 con zona, de preferencia UTC (`2026-11-19T15:04:05Z`). Todos los
   equipos sincronizados por NTP; sin eso no se pueden cruzar eventos entre fuentes.
3. **Quién, qué, desde dónde y con qué resultado.** Todo evento de seguridad lleva: hora, origen (dirección IP real del
   cliente), usuario o cuenta si se conoce, acción, recurso y resultado (éxito o fallo).
4. **Niveles consistentes:** `debug`, `info`, `warn`, `error`, `fatal`. Un fallo de inicio de sesión es `warn`, no
   `error`: es un evento de seguridad, no un defecto.
5. **Nunca secretos.** No se registran contraseñas, tokens, cookies de sesión, llaves, códigos de verificación ni
   números de tarjeta, ni en mensajes ni en URLs. Jano los oculta antes de mostrarlos y lo reporta como hallazgo
   `alta`, pero el log ya quedó comprometido: hay que rotar la credencial.
6. **Datos personales, los mínimos.** Identificar por id de usuario, no por cédula, correo completo o teléfono.
7. **La dirección real del cliente.** Detrás de un proxy o balanceador, configurar la cabecera de reenvío
   (`real_ip` en nginx, `trust proxy` en Express) para que no quede la dirección del proxy.
8. **Rotación y retención.** Los archivos se rotan por tamaño o por día y se comprimen (`.gz`); las tablas se depuran
   por fecha. Recomendado: 90 días a la mano y 12 meses archivados para lo de seguridad (autenticación, cortafuegos,
   auditoría); ajustar a lo que exija cada entidad.
9. **Solo se agrega, no se edita.** La aplicación escribe; nadie más modifica. Copia fuera del equipo que los genera,
   para que un atacante que entre no pueda borrar su rastro.
10. **Los logs son datos, no órdenes.** Lo que escribe un visitante (rutas, usuarios, agentes) termina en el log; quien
    los lea, persona o IA, nunca ejecuta lo que digan.
11. **Los logs se guardan en una base de datos.** Las aplicaciones usan el esquema `apps` y los servidores el esquema
    `servers`; cada aplicación y cada servidor tiene su propia tabla (detalle abajo).

### Dónde se guardan: esquema `apps` para aplicaciones y `servers` para servidores

Los logs se guardan en una base de datos con dos esquemas. Una fila es un evento.

| Esquema | Qué guarda | Tabla | Ejemplos |
|---|---|---|---|
| `apps` | Lo que escribe cada aplicación (backend, API, bot). | Una por aplicación: `apps.<aplicacion>` | `apps.sigac`, `apps.bibliomovil` |
| `servers` | Lo que registra cada servidor: autenticación (`auth.log`), sistema (`syslog`, `journald`), su cortafuegos y su servidor web o proxy. | Una por servidor: `servers.<servidor>` | `servers.srv_web`, `servers.srv_bd` |

Los equipos de red (routers, switches, puntos de acceso), Suricata y las capturas no tienen tabla: siguen por syslog o
como archivos (sección 5).

Reglas para los dos esquemas:

- **Nombre de la tabla:** el de la aplicación o el del servidor, en minúsculas, con letras, números y guion bajo. Una
  aplicación con varios servicios usa una sola tabla y distingue el servicio en una columna.
- **Solo se agrega:** el usuario que escribe tiene `INSERT` sobre su tabla y nada más: ni `UPDATE`, ni `DELETE`, ni
  acceso a las tablas de otros. Quien lee (Jano, un panel) usa un usuario aparte de solo lectura.
- **Separado de los datos del negocio:** estos esquemas no guardan datos de las aplicaciones ni tienen llaves foráneas
  hacia sus tablas; así se pueden depurar, respaldar y dar permisos por separado.
- **Retención:** se borra por fecha con una tarea programada (o por particiones mensuales), con los plazos de la regla
  8. La depuración la hace un usuario de mantenimiento, no el que escribe.
- **Las mismas reglas:** hora con zona, niveles, sin secretos y con los datos personales mínimos, igual que en un
  archivo.

**Esquema `apps`.** Las columnas son las de la sección 4, con esos nombres, para que una fila exportada a JSON sea un
log que Jano ya lee; lo propio de cada aplicación va en `extra`. Un fallo al guardar no tumba la aplicación: si la base
no responde, el evento sale por `stderr` y la petición sigue. El log se escribe fuera de la transacción del negocio,
para que no se pierda si esta se deshace.

```sql
CREATE SCHEMA IF NOT EXISTS apps;

CREATE TABLE apps.sigac (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp  timestamptz NOT NULL DEFAULT now(),
  level      text NOT NULL CHECK (level IN ('debug','info','warn','error','fatal')),
  msg        text NOT NULL,
  ip         inet,          -- dirección real del cliente
  user_id    text,          -- id del usuario, no su cédula ni su correo
  method     text,
  path       text,
  status     smallint,
  user_agent text,
  request_id text,
  service    text,          -- si la aplicación tiene varios servicios
  extra      jsonb          -- campos propios de la aplicación, sin secretos
);
CREATE INDEX ON apps.sigac (timestamp);
CREATE INDEX ON apps.sigac (ip);

-- La aplicación solo inserta en su tabla
GRANT USAGE ON SCHEMA apps TO sigac_app;
GRANT INSERT ON apps.sigac TO sigac_app;
```

**Esquema `servers`.** El servidor sigue escribiendo sus archivos de siempre; un reenviador (rsyslog con su salida a
PostgreSQL, Fluent Bit o Vector) inserta cada línea en la tabla del servidor. La línea original se guarda **sin
cambios** en `line`: Jano reconoce el tipo de log por la forma de la línea (sección 4), así que no se reescribe ni se
resume.

```sql
CREATE SCHEMA IF NOT EXISTS servers;

CREATE TABLE servers.srv_web (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timestamp  timestamptz NOT NULL DEFAULT now(),
  source     text NOT NULL,   -- de dónde viene: auth, syslog, ufw, nginx-access, nginx-error…
  program    text,            -- sshd, sudo, kernel, nginx…
  level      text,            -- severidad de syslog, si la hay
  line       text NOT NULL    -- la línea original, sin cambios
);
CREATE INDEX ON servers.srv_web (timestamp);
CREATE INDEX ON servers.srv_web (source, timestamp);

-- El reenviador del servidor solo inserta en su tabla
GRANT USAGE ON SCHEMA servers TO srv_web_logs;
GRANT INSERT ON servers.srv_web TO srv_web_logs;

-- El lector (Jano, un panel) solo consulta, en los dos esquemas
GRANT USAGE ON SCHEMA apps, servers TO jano_lector;
GRANT SELECT ON ALL TABLES IN SCHEMA apps, servers TO jano_lector;
```

En MySQL o MariaDB un esquema es una base de datos: se crean dos bases, `apps` y `servers`, con una tabla por
aplicación o por servidor (`ip` como `VARCHAR(45)` y `extra` como `JSON`).

## 3. Qué debe registrar cada fuente

### Aplicaciones (backend, API, bots)

- Inicio de sesión: éxitos y fallos, con usuario y dirección. Cierre de sesión y sesiones vencidas.
- Cambios de contraseña, de correo, de verificación en dos pasos y de permisos o roles.
- Accesos denegados (401, 403) y validaciones rechazadas de entradas.
- Acciones administrativas y sobre datos sensibles: crear, cambiar, borrar, exportar.
- Errores y excepciones, con un identificador de la petición para seguirla.
- Arranque, parada y cambios de configuración.

Todo esto se guarda en la tabla de la aplicación en el esquema `apps` (sección 2).

### Servidor web y proxy inverso (nginx, apache, traefik)

- Registro de acceso en **formato combinado**: dirección, hora, petición, estado, tamaño, referente y agente.
- Registro de errores aparte.

### Equipos Linux (servidores y PC)

- `auth.log` o `secure`: SSH, sudo, PAM, creación de usuarios.
- `syslog` o `journald`: servicios que arrancan, fallan o se reinician.
- Recomendado: `auditd` para cambios en `/etc/passwd`, `/etc/sudoers`, llaves SSH y tareas programadas.

Los logs de un servidor (estos, los de su cortafuegos y los de su servidor web o proxy) se guardan en la tabla del
servidor en el esquema `servers` (sección 2).

### Equipos Windows (PC y servidores)

Activar la auditoría y conservar al menos estos eventos del registro de seguridad:

| Evento | Qué es |
|---|---|
| 4624, 4625, 4634, 4648 | Inicio de sesión correcto, fallido, cierre, y uso de credenciales explícitas. |
| 4672, 4720, 4722–4726, 4732, 4740 | Privilegios especiales, cuentas creadas o cambiadas, alta en grupos, cuenta bloqueada. |
| 4688, 4698, 7045 | Proceso creado, tarea programada creada, servicio instalado. |
| 1102 | Se borró el registro de auditoría. |
| 1116, 1117 (Defender), 4104 (PowerShell) | Malware detectado y bloques de script ejecutados. |

Con Sysmon, además: procesos (1), conexiones de red (3) y archivos creados (11).

### Red

- **Cortafuegos** (UFW, iptables, pfSense, MikroTik): conexiones bloqueadas siempre; permitidas al menos las entrantes
  a servicios publicados. Con origen, destino, protocolo y puertos.
- **Detector de intrusos** (Suricata): `eve.json` con los eventos de tipo `alert`.
- **Capturas** (tcpdump): puntuales, para investigar. Siempre con `-nn` y con filtro; nunca dejar una captura abierta
  sin límite (`-c` o por tiempo). Una captura contiene el contenido del tráfico: tratarla como dato sensible.
- **DNS y DHCP:** consultas (quién preguntó por qué nombre) y asignaciones (qué equipo tuvo qué dirección y cuándo).
- **Wifi, VPN y acceso remoto:** quién se conectó, desde dónde, cuándo, y los intentos fallidos.

### Bases de datos, contenedores y nube

- **Bases de datos:** conexiones fallidas, cambios de permisos y de esquema, consultas lentas.
- **Contenedores:** la aplicación guarda sus logs en su tabla del esquema `apps`; lo que no pasa por ella (arranque,
  fallos antes de conectar a la base, la base caída) va a la salida estándar (`stdout`/`stderr`), una línea por
  evento. Nada de archivos de log dentro del contenedor, que se pierden al recrearlo.
- **Nube y paneles** (Easypanel, proveedores): inicios de sesión al panel, cambios de despliegue, de dominios y de
  variables de entorno.

### Seguridad física (cámaras, alarmas, control de acceso)

No son archivos de log: avisan en el momento por el webhook de alertas (sección 6). Cada equipo registra por su lado
aperturas, accesos concedidos y denegados, y disparos de sensores, con hora sincronizada.

## 4. Formatos que Jano lee hoy

Jano reconoce cada línea por su forma. Un mismo archivo puede mezclar formatos, pero es mejor uno por archivo.

### Aplicación en JSON (recomendado para proyectos nuevos)

Un objeto por línea. Jano busca estos campos (acepta varios nombres para cada uno):

| Dato | Nombres aceptados | Notas |
|---|---|---|
| Hora | `timestamp`, `time` | Texto ISO 8601. Un número (época) no se usa para el periodo. |
| Nivel | `level`, `severity`, `lvl`, `levelname` | Texto, o número al estilo pino (50 = error, 60 = fatal). |
| Mensaje | `msg`, `message`, `error` | |
| Dirección | `ip`, `remote_addr`, `client_ip`, `clientIp`, `remoteAddress`, `src_ip` | |
| Petición web | `method`, `path` o `url` o `uri`, `status` o `statusCode`, `user_agent` o `userAgent` | Con ruta y estado, la línea se analiza también como acceso web. |

```json
{"timestamp":"2026-11-19T15:04:05Z","level":"warn","msg":"login failed","ip":"203.0.113.7","user_id":42,"method":"POST","path":"/login","status":401,"request_id":"a1b2"}
```

Para que un **fallo de autenticación** cuente, el mensaje debe contener una de estas frases: `login failed`,
`authentication failed`, `invalid password`, `invalid credentials`, `invalid token`, `unauthorized`, `access denied`,
`credenciales inválidas`, `acceso denegado`, `no autorizado`. Usar siempre la misma y poner la dirección en su campo.

### Aplicación en texto

Hora, nivel en mayúsculas y mensaje: `2026-11-19T15:04:05Z ERROR [pagos] no se pudo conectar a la base`.
Cuentan como error `ERROR`, `FATAL`, `CRITICAL`, `SEVERE`, `Exception` y `Traceback`.

### Acceso web (nginx o apache, formato combinado)

```
203.0.113.7 - - [19/Nov/2026:10:04:05 -0500] "POST /login HTTP/1.1" 401 512 "-" "Mozilla/5.0"
```

El primer campo debe ser la dirección real del cliente. Las rutas de inicio de sesión que Jano reconoce contienen
`/login`, `/signin`, `/auth`, `/session`, `/token`, `/oauth`, `/ingresar` o `/acceso`; un intento rechazado debe
responder 401, 403 o 429 (si la aplicación responde 200 con un mensaje de error, la fuerza bruta no se ve).

### Autenticación de Linux

Las líneas estándar de `sshd` y `sudo` en `auth.log` o `secure`, sin cambios.

### Cortafuegos

Líneas con `SRC=… DST=… PROTO=… SPT=… DPT=…` y la acción en el texto (`[UFW BLOCK]`, `DROP`, `REJECT`, `ALLOW`,
`ACCEPT`). En iptables, poner prefijo: `-j LOG --log-prefix "[FW DROP] "`.

### Captura de red

Un archivo `.pcap` (el formato clásico de tcpdump y Wireshark) o el texto de `tcpdump -nn`. De un `.pcap` Jano lee solo
las cabeceras, no el contenido de los paquetes. El formato `pcapng` hay que convertirlo:
`tcpdump -r captura.pcapng -w captura.pcap`.

### Suricata

`eve.json` tal como lo escribe Suricata, como archivo o reenviado por syslog.

### SIEM (Wazuh)

Las alertas en JSON (`alerts.json` o lo que envíe su integración), con `rule.level`, `rule.description`,
`agent.name` y `data.srcip`. Cuentan como hallazgo las de nivel 7 o más: 7 a 9 es `media`, 10 a 12 `alta` y 13 o más
`critica`.

### Lo que todavía no interpreta

| Fuente | Estado | Mientras tanto |
|---|---|---|
| Eventos de Windows | *Pendiente:* no interpreta los números de evento. | Con un agente de Wazuh en el equipo, las alertas llegan por el SIEM. Sin SIEM: exportar a JSON por línea con `level` y `msg` («login failed», etc.). |
| DNS, DHCP, VPN, bases de datos | *Pendiente:* sin reglas propias. | `buscar_en_logs` sirve para seguir una dirección o un usuario. |
| `journald` | No se lee el diario binario. | `journalctl -o short-iso > archivo.log`. |
| Cruce entre archivos y ventanas de tiempo | *Pendiente.* | Las reglas cuentan sobre el final de cada archivo. |
| Tablas de los esquemas `apps` y `servers` | *Pendiente:* Jano no consulta la base de datos directamente. | Exportar las filas recientes y enviarlas por HTTP (sección 5, «Desde las tablas»). |

## 5. Cómo conectar una fuente con Jano

Hay cuatro caminos. Todos terminan igual: Jano lista la fuente con `fuentes_de_logs` y la revisa con `analizar_logs`
y `buscar_en_logs` (el SIEM, con `consultar_siem`).

| Camino | Para qué fuentes | Se enciende con |
|---|---|---|
| **A. Carpeta montada** (solo lectura) | Archivos que ya existen en el equipo: nginx, `auth.log`, `eve.json` de Suricata, capturas `.pcap`, logs de aplicaciones. | `LOGS_DIR` |
| **B. Envío por HTTP** | Cualquier cosa que sepa hacer un POST: SIEM, Fluent Bit, Vector, Logstash, n8n, un script. | `LOGS_INGEST_SECRET` |
| **C. Syslog** (UDP y TCP) | Routers, cortafuegos, switches, puntos de acceso, rsyslog, Suricata, reenviadores de un SIEM. | `LOGS_SYSLOG_PORT` |
| **D. Consulta al SIEM** | Wazuh, Elastic Security, OpenSearch, Security Onion. | `SIEM_URL` |

### A. Carpeta montada

Jano lee la carpeta `LOGS_DIR` (con `docker compose`, la carpeta `./logs` del equipo o `LOGS_HOST_DIR`):

```
logs/
  <proyecto>/
    app.log            registro de la aplicación
    nginx/access.log   acceso web
    auth.log           autenticación del servidor
    suricata/eve.json  detector de intrusos
    red/captura-1005.pcap
```

- **Profundidad:** hasta dos carpetas por debajo de `logs/`.
- **Nombres:** terminados en `.log`, `.txt`, `.json`, `.jsonl`, `.out`, `.gz`, `.pcap` o `.cap`, o llamados `syslog`,
  `messages`, `secure`, `auth` o `kern`. Nombres claros: Jano ubica el archivo por las palabras que diga Camilo.
- **Tamaño:** se lee el final de cada archivo (`LOGS_MAX_MB`, 4 MB por defecto); una captura `.pcap`, hasta 64 MB.
- **Permisos:** legibles por el usuario del contenedor (UID 1000). Los enlaces simbólicos que apuntan fuera se ignoran.

```bash
# Otro contenedor del mismo equipo: montar su carpeta de logs dentro de la de Jano (docker-compose.yml de Jano)
#   - /ruta/al/proyecto/logs:/app/logs/<proyecto>:ro
# Suricata: montar su carpeta
#   - /var/log/suricata:/app/logs/suricata:ro

# Captura continua con tcpdump: un archivo cada 5 minutos, solo cabeceras (-s 96), que se reescribe cada día
sudo tcpdump -nn -i any -s 96 -G 300 -w 'logs/red/captura-%H%M.pcap'

# Logs del sistema o la salida de un contenedor, por cron
cp /var/log/auth.log /var/log/ufw.log logs/<proyecto>/ && chown 1000 logs/<proyecto>/*
docker logs --since 24h mi-app > logs/<proyecto>/app.log 2>&1
```

### B. Envío por HTTP

`POST /logs/<fuente>` con la cabecera `X-Logs-Secret`. Cada evento queda como una línea en
`recibidos/<fuente>.log`. El cuerpo puede ser texto (una línea por evento) o JSON (un arreglo, un objeto con
`lineas`, `lines`, `events`, `records` o `logs`, o un solo objeto).

```bash
# Texto: una línea por evento (hasta 1 MB y 5000 líneas por envío)
tail -n 500 /var/log/auth.log | curl -X POST https://<dominio>/logs/sigac-auth \
  -H "X-Logs-Secret: <clave>" -H "Content-Type: text/plain" --data-binary @-

# JSON: lo que envía la integración o el webhook de un SIEM (hasta 100 KB por envío)
curl -X POST https://<dominio>/logs/wazuh -H "X-Logs-Secret: <clave>" -H "Content-Type: application/json" \
  -d '{"rule":{"level":12,"description":"Multiple authentication failures"},"agent":{"name":"srv-web"},"data":{"srcip":"203.0.113.7"}}'
```

**Desde las tablas.** Jano todavía no lee los esquemas `apps` y `servers` directamente, así que una tarea programada
exporta las filas recientes y las envía, con el usuario de solo lectura. De `apps` sale una línea JSON por fila: como
las columnas tienen los nombres de la sección 4, Jano las reconoce sin más cambios. De `servers` sale la columna
`line` tal cual, una fuente por cada tipo de log:

```bash
# Cada 15 minutos (cron): lo registrado en los últimos 15 minutos en apps.sigac
psql "$LOGS_DATABASE_URL" -At -c "SELECT row_to_json(t) FROM (SELECT * FROM apps.sigac
  WHERE timestamp > now() - interval '15 minutes' ORDER BY id) t" \
  | curl -X POST https://<dominio>/logs/sigac -H "X-Logs-Secret: <clave>" -H "Content-Type: text/plain" --data-binary @-

# Lo mismo para la autenticación del servidor srv_web
psql "$LOGS_DATABASE_URL" -At -c "SELECT line FROM servers.srv_web
  WHERE source = 'auth' AND timestamp > now() - interval '15 minutes' ORDER BY id" \
  | curl -X POST https://<dominio>/logs/srv-web-auth -H "X-Logs-Secret: <clave>" -H "Content-Type: text/plain" --data-binary @-
```

Con Fluent Bit, Vector o Logstash se usa su salida HTTP hacia esa misma dirección, con la cabecera de la clave y
formato de una línea JSON por evento.

### C. Syslog

Jano escucha en `LOGS_SYSLOG_PORT` por UDP y TCP. Cada equipo queda en su archivo: `recibidos/syslog-<dirección>.log`.

- **rsyslog** (servidores Linux): en `/etc/rsyslog.d/90-jano.conf`, `*.* @@<equipo-de-jano>:5514` (`@@` es TCP, `@` es UDP).
- **Routers y cortafuegos** (MikroTik, pfSense, OPNsense, UniFi): activar el registro remoto hacia esa dirección y puerto.
- **Suricata:** salida `eve-log` por syslog; Jano entiende el JSON que llega dentro de la línea.
- **Windows:** un agente que reenvíe el registro de eventos por syslog (NXLog, Winlogbeat hacia Logstash).

Syslog no lleva clave, así que el control es por remitente: `LOGS_SYSLOG_ALLOW` lista las direcciones o prefijos
aceptados (`192.168.1.1,10.0.5.`); sin lista solo entran redes privadas. No publicar ese puerto en internet. Con
Docker, el remitente puede verse con la dirección de la red de Docker en vez de la real: en ese caso todos los
equipos caen en un mismo archivo.

### D. Consulta al SIEM

Si ya hay un SIEM, es la fuente principal: él recoge y correlaciona, y Jano lo consulta y le informa a Camilo. Sirve
con cualquiera que tenga la API de búsqueda de OpenSearch o Elasticsearch.

```
SIEM_URL=https://wazuh-indexer:9200
SIEM_USER=jano_lector          # un usuario de SOLO LECTURA sobre el índice de alertas
SIEM_PASSWORD=...
SIEM_INDEX=wazuh-alerts-*      # Elastic Security: .alerts-security.alerts-*
SIEM_CA_FILE=/app/data/siem-ca.pem
```

Para un SIEM con otra API (Splunk, Graylog, QRadar), que envíe sus alertas por el camino B o el C.

## 6. Avisos en el momento: webhook de alertas

Lo que no puede esperar a que alguien revise un log (un sensor, fail2ban, una regla del SIEM, un monitor) avisa
directamente. Requiere `ALERTS_WEBHOOK_SECRET`.

```bash
curl -X POST https://<dominio>/alertas \
  -H "Content-Type: application/json" -H "X-Alert-Secret: <clave>" \
  -d '{"titulo":"fail2ban bloqueó 203.0.113.7","detalle":"12 fallos de SSH en 5 minutos","severidad":"media","origen":"sigac-servidor"}'
```

Usar siempre el mismo `titulo` y `origen` para el mismo tipo de evento: una alerta igual que siga abierta suma una
repetición en vez de duplicarse.

## 7. Lista de comprobación por proyecto

- [ ] Los logs salen una línea por evento, con hora ISO 8601 y zona.
- [ ] Los equipos sincronizan la hora por NTP.
- [ ] Se registran inicios de sesión (éxito y fallo), accesos denegados, cambios de permisos y acciones administrativas.
- [ ] Los fallos de autenticación usan una de las frases reconocidas y responden 401, 403 o 429.
- [ ] La dirección registrada es la del cliente, no la del proxy.
- [ ] No hay contraseñas, tokens, cookies ni tarjetas en los logs (revisado con `buscar_en_logs` o `grep`).
- [ ] Cada aplicación guarda sus logs en su propia tabla del esquema `apps` (`apps.<aplicacion>`), con las columnas de la sección 2.
- [ ] Cada servidor guarda los suyos en su propia tabla del esquema `servers` (`servers.<servidor>`), con la línea original sin cambios.
- [ ] El usuario que escribe solo tiene `INSERT` sobre su tabla; la lectura usa un usuario aparte de solo lectura.
- [ ] Hay rotación diaria y compresión de los archivos, depuración por fecha de las tablas y un plazo de retención definido.
- [ ] Hay una copia fuera del equipo que genera los logs.
- [ ] Los logs llegan a Jano por uno de los cuatro caminos (carpeta, HTTP, syslog o SIEM) con un nombre de fuente claro.
- [ ] Jano los lista (`fuentes_de_logs`) y `analizar_logs` reconoce el tipo de cada uno.
- [ ] Lo urgente (sensores, bloqueos automáticos) avisa por el webhook de alertas.
- [ ] Las claves de entrada (`LOGS_INGEST_SECRET`, `ALERTS_WEBHOOK_SECRET`) son largas, al azar y distintas por entorno; el usuario del SIEM es de solo lectura.
