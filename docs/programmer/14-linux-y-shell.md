# Capítulo 14 — Linux y shell para devs

> **Focus:** Dominar la caja de herramientas Unix que aparece a diario: filesystem, procesos y signals, permisos, `systemd`, cron/timers, journaling, texto (grep/awk/sed/xargs), pipes y redirecciones, `bash` con `set -euo pipefail`, y debugging profundo con `strace`, `lsof` y `journalctl`.
> **Áreas:** Fundamentos Linux · Shell · Debugging · Automatización
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior

## 0. Antes de empezar

**Pre-requisitos:**
- Terminal Linux/macOS o WSL2 en Windows con una distro reciente (Ubuntu 24.04, Debian 12, Fedora 40+).
- Cuenta con `sudo` para probar `systemd`, `ulimit`, `journalctl`, `strace`.
- Familiaridad con Git y con un editor de texto (`vim`, `nano`, `micro` o VS Code + Remote WSL).
- Un servicio HTTP simple (Node, Python o Go) que puedas usar de conejillo de indias.
- Un contenedor Docker corriendo Linux si estás en macOS ARM (algunas herramientas como `strace` no existen en macOS).

**Glosario mínimo:**
- **Kernel** vs **userspace**: el kernel gestiona hardware, memoria, procesos, red; los procesos de usuario hablan con él via **syscalls**.
- **PID**: process ID; **PPID**: parent process ID. PID 1 es `init` (en 2026, casi siempre `systemd`).
- **UID/GID**: user/group ID numéricos. `id -u`, `id -g`.
- **File descriptor (fd)**: entero que identifica un recurso abierto (archivo, socket, pipe). Cada proceso tiene su tabla; `0=stdin`, `1=stdout`, `2=stderr`.
- **Signal**: notificación asíncrona al proceso (`SIGTERM`, `SIGKILL`, `SIGHUP`, `SIGINT`, `SIGUSR1`). Se envía con `kill`, se captura con `trap` en shell o `signal.signal()` en Python.
- **cgroups (control groups)**: mecanismo del kernel que limita CPU, memoria, I/O, PIDs a un grupo de procesos. **cgroup v2** es el estándar en 2026 (systemd 256+ lo asume; systemd 257 marca v1 como obsoleto).
- **namespace**: aislamiento de vista (PID, network, mount, UTS, IPC, user). Base de los contenedores.
- **`systemd`**: init y service manager. Reemplazó SysV init en la mayoría de distros hace años. **Versión 256** (jun 2024) y **257** (dic 2024) son las relevantes en 2026.
- **`journalctl`**: cliente para los logs binarios de `journald`. Estructurado, indexado, con niveles.
- **Filesystem Hierarchy Standard (FHS)**: `/etc` (config), `/var` (variables), `/usr` (binarios), `/tmp` (efímero), `/proc` y `/sys` (interfaces del kernel), `/run` (runtime).

**Setup mínimo:**

```bash
# 1. Distro y versión de kernel
uname -a
cat /etc/os-release | head -5

# 2. Init y version de systemd
systemctl --version | head -1                        # esperar >= 256
ps -o pid,comm -p 1

# 3. Herramientas que usaremos
sudo apt update && sudo apt install -y \
  htop procps psmisc lsof strace file util-linux \
  ripgrep fd-find bat jq tmux tree ncdu iftop

# 4. Comprueba tu shell
echo "$SHELL"                                        # /bin/bash o /bin/zsh
bash --version | head -1                             # >= 5.2 recomendado

# 5. Directorio de trabajo
mkdir -p ~/linux-lab && cd ~/linux-lab
```

En macOS instala GNU coreutils (`brew install coreutils gnu-sed gawk findutils`) — el `sed`/`awk` de BSD tienen sintaxis distinta a los ejemplos de este capítulo. En WSL2 vas a estar cómodo con las mismas herramientas que Linux.

---

## 1. El gran cuadro

Todo en Linux es un **archivo**: los ficheros del disco, los dispositivos (`/dev/sda`, `/dev/null`), los sockets, los pipes, y las interfaces del kernel bajo `/proc` y `/sys`. Cuando entiendes que `cat /proc/self/status` te da información del proceso `cat` que estás corriendo, y que `echo 1 > /proc/sys/net/ipv4/ip_forward` activa el forwarding del kernel, ganas un modelo mental que hace comprensible el 90% del sistema. Los devs que se quedan en "es magia" pierden tardes en cada incidente; los que se toman una semana con `man`, `strace` y `journalctl` ganan un superpoder para el resto de su carrera.

El segundo modelo mental es **procesos y signals**. Cada proceso tiene PID, PPID, UID/GID efectivos, un `working directory`, una tabla de file descriptors, y limits impuestos por el shell o por `systemd`/cgroups. Los signals son la primera vía de comunicación con un proceso desde fuera; `SIGTERM` pide "termina ordenadamente", `SIGKILL` es el hachazo del kernel que ningún proceso puede capturar. Un buen daemon captura `SIGTERM` con `trap` (bash) o handler (código), cierra conexiones, hace flush de logs, y sale con `exit 0`. Un mal daemon deja sockets en `TIME_WAIT`, mensajes a medio escribir y datos corruptos. Todo lo que aprendiste en Docker (§4.4 del capítulo anterior) sobre PID 1 y exec form aplica igual aquí.

El tercer bloque es el **stack de servicios**. En 2026, `systemd` es prácticamente universal en producción Linux (Ubuntu, Debian, Fedora, RHEL, Arch, SUSE). Aprender `systemctl status/start/stop/enable`, escribir un `.service` unit decente y leer `journalctl -u miservicio -f` reemplaza a mucho conocimiento antiguo de SysV init, `/etc/init.d` y `chkconfig`. Los **timers de systemd** son el reemplazo moderno de cron: mejor logging, mejor manejo de fallos, mejor concurrencia. Cron sigue vivo por ubiquidad; timers son mejores cuando puedes usarlos.

Cerrando el cuadro: el shell. **Bash 5.2+** con **strict mode** (`set -euo pipefail`), tuberías bien diseñadas y una comprensión sólida de `grep`, `sed`, `awk`, `find`, `xargs`, `jq` te resuelve un porcentaje enorme del trabajo diario sin abrir un IDE ni escribir un script "de verdad". La regla mental es que la línea de comandos son **pequeños programas que se comunican por texto**; conectarlos bien es una habilidad tan importante como escribir código.

---

## 2. Filesystem, procesos y permisos (nivel junior)

### 2.1 Filesystem Hierarchy Standard

| Directorio | Contenido |
|---|---|
| `/etc` | Configuración del sistema (`/etc/nginx/nginx.conf`) |
| `/usr/bin`, `/usr/sbin` | Binarios instalados por el package manager |
| `/usr/local/bin` | Binarios instalados manualmente por el admin |
| `/var/log` | Logs (algunos migrados a `journald` binario) |
| `/var/lib` | Estado persistente de servicios (`/var/lib/postgresql`) |
| `/var/cache` | Caches (borrable) |
| `/tmp` | Efímero (`tmpfs` en muchos sistemas), limpiado al boot |
| `/proc` | Interfaz al kernel: procesos y sysctl |
| `/sys` | Interfaz al kernel: dispositivos, cgroups |
| `/run` | Runtime state (sockets, PIDs) volátil |
| `/opt` | Software de terceros empaquetado como árbol único |
| `/home` | Directorios de usuarios |
| `/dev` | Dispositivos de bloque y de carácter |

Comandos útiles del día a día:

```bash
tree -L 2 /var/lib | head -30
df -hT | grep -v tmpfs                    # espacio en disco por FS
du -sh /var/log/* 2>/dev/null | sort -h   # qué log es el gordo
ncdu /var                                 # navegador interactivo de tamaños
mount | column -t | grep -v cgroup        # qué está montado
```

### 2.2 Procesos: `ps`, `top`, `htop`, `pgrep`

```bash
# Snapshot completo formateado
ps -eo pid,ppid,user,%cpu,%mem,stat,start,command --sort=-%mem | head

# Buscar procesos por nombre
pgrep -a node
pgrep -a -u www-data                       # de un usuario

# Vista interactiva (moderna)
htop                                       # F5 tree, F6 sort, F9 signal, / search

# Vista base (todos los sistemas)
top -o %MEM -c

# Árbol de procesos
pstree -p 1 | head -20

# Uso puntual de un PID
ps -o pid,%cpu,%mem,rss,vsz,stat,cmd -p 12345
```

`stat` (columna `STAT`) de `ps`: `R` running, `S` sleeping, `D` uninterruptible I/O wait (¡rojo si crece!), `Z` zombie, `T` stopped, `<` high priority, `N` low priority.

### 2.3 Signals: `kill`, `trap`, la tabla que hay que memorizar

```bash
kill -l | tr ' ' '\n' | grep -E '^[0-9]+' | head -20   # lista de signals
```

| Señal | Núm | Uso |
|---|---|---|
| `SIGHUP` | 1 | Recarga de config (nginx, sshd) |
| `SIGINT` | 2 | Ctrl+C |
| `SIGQUIT` | 3 | Ctrl+\ (core dump) |
| `SIGKILL` | 9 | Fuerza terminación. **No capturable.** |
| `SIGTERM` | 15 | Termina ordenadamente. Default de `kill`. |
| `SIGUSR1`/`SIGUSR2` | 10/12 | Definido por la app (nginx reopen logs, etc.) |
| `SIGSTOP` | 19 | Pausa (no capturable). Ctrl+Z envía `SIGTSTP` (20). |
| `SIGCONT` | 18 | Reanuda |
| `SIGPIPE` | 13 | Escribió a pipe cerrado (típico en `curl | head`) |

Regla: **empieza con `SIGTERM`, espera unos segundos, solo entonces manda `SIGKILL`**. Ejemplo con `trap`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  local code=$?
  echo "[$(date -Is)] Cleanup: exit=$code" >&2
  # cerrar recursos, borrar temporales, etc.
  rm -rf "${TMPDIR:-/tmp/mycli.$$}"
  exit "$code"
}

trap cleanup EXIT INT TERM

TMPDIR="$(mktemp -d /tmp/mycli.XXXXXX)"
# ... trabajo real ...
```

`trap cleanup EXIT INT TERM` captura salida normal, Ctrl+C y `SIGTERM`. `EXIT` corre siempre — es idiomático para releasing.

### 2.4 Permisos: octal, `chmod`, `chown`, `umask`

Cada archivo tiene tres tríos (owner, group, other) con bits `rwx`. Notación octal:

```
r=4  w=2  x=1
rwx r-x r-x  =  755   (typical script)
rw- r-- r--  =  644   (typical file)
rwx --- ---  =  700   (private script)
rw- rw- ---  =  660   (shared config)
```

```bash
chmod 755 deploy.sh                        # numeric
chmod u+x,g-w,o= script.sh                 # simbólico
chown app:app /var/lib/miapp -R
chgrp docker /var/run/docker.sock
umask 022                                   # nuevos archivos: 644, nuevos dirs: 755
```

**Bits especiales:**
- **setuid (`4000`)**: al ejecutar, corre con UID del owner (peligroso; `/usr/bin/sudo` lo tiene).
- **setgid (`2000`)**: en directorios, archivos nuevos heredan el grupo del dir.
- **sticky (`1000`)**: en directorios, solo el owner puede borrar sus archivos (`/tmp` tiene `1777`).

```bash
ls -la /tmp    # verás drwxrwxrwt (t final = sticky)
ls -la /usr/bin/sudo   # verás -rwsr-xr-x (s = setuid)
```

Regla de oro: **NO** setuid en scripts propios. Usa `sudo` o capabilities (`setcap cap_net_bind_service=+ep miapp` para bind en puertos <1024 sin ser root).

### 2.5 File descriptors, `ulimit` y leaks

```bash
ulimit -n                                   # límite de fds del shell actual
cat /proc/$$/limits | head -20              # todos los limits del proceso
ls /proc/self/fd | wc -l                    # fds abiertos ahora mismo
```

Cuando una app long-running olvida cerrar sockets/archivos, verás `EMFILE (Too many open files)` en logs y `accept()` empieza a fallar. Diagnóstico:

```bash
# fds abiertos por el PID 12345
ls -l /proc/12345/fd | head -30
ls /proc/12345/fd | wc -l

# ¿qué archivos y sockets tiene abiertos un proceso?
lsof -p 12345 | head -20

# ¿quién tiene abierto /var/log/miapp.log?
lsof /var/log/miapp.log

# Sockets TCP en estado ESTABLISHED por proceso
ss -ntp state established
```

Subir el límite en un `.service` unit:

```ini
[Service]
LimitNOFILE=65535
```

---

## 3. Bash idiomático y texto (nivel junior → mid)

### 3.1 Strict mode y estructura de un script decente

```bash
#!/usr/bin/env bash
#
# deploy.sh — despliega miapp a staging
# uso: ./deploy.sh <version>

set -Eeuo pipefail
IFS=$'\n\t'

# ------- Config -------
readonly REGION="${AWS_REGION:-eu-west-1}"
readonly LOG_FILE="/var/log/deploy.log"

# ------- Utilidades -------
log()  { printf '[%s] %s\n' "$(date -Is)" "$*" | tee -a "$LOG_FILE" >&2; }
die()  { log "ERROR: $*"; exit 1; }

on_err() {
  local exit_code=$?
  log "Falló en línea $BASH_LINENO comando: $BASH_COMMAND (exit=$exit_code)"
  exit "$exit_code"
}
trap on_err ERR

# ------- Validación -------
[[ $# -ge 1 ]] || die "uso: $0 <version>"
readonly VERSION="$1"
command -v aws >/dev/null || die "aws CLI no encontrada"

# ------- Trabajo -------
log "Desplegando versión ${VERSION} a ${REGION}"
aws lambda update-function-code \
  --region "$REGION" \
  --function-name miapp \
  --image-uri "ghcr.io/linguadev/miapp:${VERSION}" >/dev/null

log "Deploy OK"
```

Explicación:

- `set -E`: los `trap ERR` heredan en funciones y subshells.
- `set -e`: falla al primer comando con exit != 0.
- `set -u`: usar variable no definida = error (protege de typos).
- `set -o pipefail`: si algún comando de una tubería falla, la tubería completa falla (por default solo cuenta el último).
- `IFS=$'\n\t'`: solo newline y tab separan palabras (protege de nombres con espacios).
- `readonly` para constantes.
- `log`/`die` separados en funciones.
- Comillas dobles alrededor de **cada** expansión: `"$VAR"`, `"$@"`, `"$(cmd)"`.
- `${VAR:-default}` para valores por default; `${VAR:?msg}` para exigir que exista.

### 3.2 Redirects y pipes: `>`, `>>`, `2>&1`, `<()`, `tee`

```bash
cmd > out.log 2>&1              # stdout + stderr juntos al mismo archivo
cmd > out.log 2> err.log         # separados
cmd 2>&1 | grep ERROR             # error a stdout para poder filtrarlo
cmd |& grep ERROR                 # atajo bash para 2>&1 |
cmd > /dev/null                   # descartar stdout
cmd &>/dev/null                   # descartar stdout y stderr
cmd < input.txt                   # stdin desde archivo
cmd <<< "cadena literal"           # here-string
cmd <<EOF                         # here-doc
línea 1
línea 2
EOF

# Process substitution (super útil)
diff <(cmd1) <(cmd2)               # compara salida de dos comandos
comm -12 <(sort a) <(sort b)       # líneas comunes

# tee para bifurcar
cmd | tee out.log | grep -c ERROR   # guarda todo y cuenta errores

# tee con sudo (no puedes redirigir con >, sí con tee)
echo 'nameserver 1.1.1.1' | sudo tee -a /etc/resolv.conf
```

### 3.3 `grep`, `rg`, regex, contexto y multiline

```bash
grep -RIn --color=auto "TODO" src/          # recursivo, ignora binarios, con nº línea
grep -RIn -E 'error|fatal' /var/log         # extended regex
grep -RIn -A3 -B1 "traceback" logs/         # contexto (3 después, 1 antes)
grep -RIn -F "literal(text)" .              # sin interpretar regex

# rg (ripgrep) — 3-10x más rápido, ignora .gitignore por default
rg -n 'AbortController' packages/
rg -n --type ts --context 2 'useEffect'
```

Regex esenciales (POSIX/ERE): `^` inicio, `$` fin, `.` cualquier char, `*` cero-o-más, `+` uno-o-más, `?` cero-o-uno, `[abc]` clase, `[^abc]` negada, `\b` word boundary (GNU/PCRE), `(a|b)` alternación, `{2,4}` rango.

### 3.4 `awk`, `sed`, one-liners que valen su peso en oro

**`awk` para columnas:**

```bash
# Top 5 IPs con más hits en un access log Apache/Nginx
awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -5

# Suma del bytes-sent (columna 10 en formato combined)
awk '{sum += $10} END {print sum}' /var/log/nginx/access.log

# Filtrar por status 5xx y contar por endpoint
awk '$9 ~ /^5/ {print $7}' access.log | sort | uniq -c | sort -rn

# Cambiar separador a coma
awk -F',' 'NR>1 {print $3}' data.csv | sort -u
```

**`sed` para sustituciones:**

```bash
# Sustituir en stdout
sed 's/foo/bar/g' file.txt

# Editar in-place (backup .bak)
sed -i.bak 's/localhost/prod.linguadev.app/g' config.yaml

# Solo líneas 10-20
sed -n '10,20p' log.txt

# Borrar líneas vacías
sed -i '/^$/d' file.txt

# Borrar líneas que empiezan por #
sed -i '/^#/d' config.ini

# Insertar antes de la línea que match
sed -i '/^\[server\]/i # comentario nuevo' config.ini
```

### 3.5 `find` + `xargs` + `-print0`

```bash
# Borrar .log más viejos de 30 días (safe con -print0/-0)
find /var/log/app -type f -name '*.log' -mtime +30 -print0 | xargs -0 rm -f

# Ejecutar comando por archivo (equivalente pero más limpio con -exec)
find . -type f -name '*.py' -exec grep -l 'TODO' {} +

# Contar archivos por extensión
find . -type f -name '*.*' -printf '%f\n' | awk -F. '{print $NF}' | sort | uniq -c | sort -rn

# Archivos mayores de 100 MB
find / -xdev -type f -size +100M 2>/dev/null

# Últimos 10 modificados
find . -type f -printf '%T@ %p\n' | sort -rn | head -10 | cut -d' ' -f2-

# Paralelo con xargs -P
find . -type f -name '*.png' -print0 | xargs -0 -P 4 -I {} optipng -o5 {}
```

`-print0`/`-0` usa `NUL` como separador — evita el bug de nombres con espacios o newlines.

### 3.6 `jq` para JSON

```bash
# Extraer un campo
curl -s api.github.com/repos/nodejs/node | jq -r '.stargazers_count'

# Filtrar array
curl -s api.github.com/orgs/nodejs/repos | jq -r '.[] | select(.fork==false) | .name'

# Recomponer objeto
kubectl get pods -o json | jq -r '.items[] | {name: .metadata.name, node: .spec.nodeName}'

# Contar por status
kubectl get pods -o json | jq -r '.items[].status.phase' | sort | uniq -c
```

---

## 4. systemd, journal, cron y timers (nivel mid)

### 4.1 Escribir un `.service` correcto

```ini
# /etc/systemd/system/miapp.service
[Unit]
Description=LinguaDev API (Node.js)
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=exec
User=app
Group=app
WorkingDirectory=/opt/miapp
EnvironmentFile=/etc/miapp/env
ExecStart=/usr/bin/node /opt/miapp/dist/index.js
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5s
TimeoutStopSec=25s

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=/var/lib/miapp
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
SystemCallFilter=@system-service
SystemCallArchitectures=native
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictNamespaces=yes
RestrictRealtime=yes

# Límites
LimitNOFILE=65535
MemoryMax=512M
CPUQuota=100%

# Logs a journald con identifier propio
StandardOutput=journal
StandardError=journal
SyslogIdentifier=miapp

[Install]
WantedBy=multi-user.target
```

Comandos:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now miapp.service
sudo systemctl status miapp
sudo systemctl restart miapp
sudo systemctl reload miapp
sudo systemd-analyze security miapp.service       # score de hardening
sudo systemd-analyze verify miapp.service         # sintaxis
```

### 4.2 `journalctl`: buscar como un pro

```bash
# Logs del servicio (con follow)
sudo journalctl -u miapp.service -f

# Solo desde el último boot
sudo journalctl -u miapp -b

# Última hora, priority error o worse
sudo journalctl -u miapp --since '1 hour ago' -p err

# Ver logs de una invocación específica (systemd 257+)
sudo journalctl -u miapp --list-invocations                       # lista
sudo journalctl -u miapp -I 42                                    # invocación 42

# JSON estructurado
sudo journalctl -u miapp -o json --output-fields=MESSAGE,PRIORITY | jq -r '.MESSAGE'

# Filtrar por unit y patrón
sudo journalctl -u miapp --since today | grep -i 'timeout'

# Uso de disco por journald
journalctl --disk-usage
sudo journalctl --vacuum-size=500M
sudo journalctl --vacuum-time=14d
```

### 4.3 Cron vs systemd timers

**Cron** (sintaxis: `m h dom mon dow cmd`):

```cron
# /etc/cron.d/backup
# Todos los días a las 02:15 UTC
15 2 * * * app /opt/miapp/backup.sh >> /var/log/backup.log 2>&1
```

Errores clásicos de cron: (1) `PATH` mínimo — usa paths absolutos o `PATH=` explícito; (2) no envía email a nadie si redirijes stderr sin loguear; (3) sin locking, ejecuciones se solapan; (4) sin retry; (5) cambios de horario / DST rompen. Añade `flock` para prevenir solapes:

```cron
* * * * * app /usr/bin/flock -n /var/run/miapp-cron.lock /opt/miapp/task.sh
```

**Systemd timer** (mejor logging, mejor manejo de misses):

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Backup de LinguaDev

[Service]
Type=oneshot
User=app
ExecStart=/opt/miapp/backup.sh
```

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Corre backup diario

[Timer]
OnCalendar=*-*-* 02:15:00
Persistent=true          # si se perdió una ejecución (host apagado), corre al arrancar
RandomizedDelaySec=300   # dispersa carga

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now backup.timer
systemctl list-timers --all
journalctl -u backup.service --since yesterday
```

Ventajas frente a cron: (a) logs unificados con `journalctl`, (b) `Persistent=true` recupera runs perdidos, (c) reintentos via `Restart=`, (d) misma sintaxis y hardening que services, (e) `RandomizedDelaySec` evita thundering herds.

### 4.4 cgroups v2 y limits

En 2026 casi todas las distros usan cgroup v2 unificado. Systemd 257 marca v1 como obsoleto e ignora configuraciones que la habiliten. Ver:

```bash
mount | grep cgroup                # cgroup2 en /sys/fs/cgroup
systemctl status miapp             # verás CGroup: /system.slice/miapp.service
systemd-cgtop                       # top a nivel cgroup

# Cambiar límite en vivo (no persistente)
sudo systemctl set-property miapp.service MemoryMax=256M CPUQuota=50%

# Verlo
systemctl show miapp | grep -E 'MemoryMax|CPUQuota'
```

Cuando la JVM o Node corre en cgroup con límite estricto, hay que decirle explícitamente cuánto puede usar (`-Xmx`, `--max-old-space-size`) o vas a ver **OOMKill** del kernel; `dmesg | tail` mostrará `Memory cgroup out of memory: killed process ... miapp`.

---

## 5. Debugging profundo: `strace`, `lsof`, `ss`, `perf` (nivel senior)

### 5.1 `strace` — qué syscalls está haciendo tu proceso

```bash
# Attachar a PID existente
sudo strace -p 12345 -f -e trace=network,openat -T -tt -o strace.log

# Correr y trace
strace -f -e trace=openat curl -sS https://example.com > /dev/null

# Cuentas y tiempos por syscall
strace -c -p 12345 -f
# ^C para terminar y ver la tabla resumen
```

Flags: `-p` PID, `-f` seguir hijos, `-e trace=…` filtro (network, file, openat, connect…), `-T` tiempo por syscall, `-tt` timestamp con µs, `-c` resumen contable, `-y` muestra el path de cada fd, `-s 1024` extiende strings.

Casos de uso reales:
- "Mi app abre 'foo.conf' pero no encuentra las claves" → `strace -e openat` y ves qué path abre.
- "Timeout misterioso al llamar a un servicio" → `strace -e connect,recvfrom,sendto -T -tt`.
- "Consume 100% CPU" → `strace -c` te dice si es `futex`, `epoll_wait`, `read`, etc.

### 5.2 `lsof` — quién tiene esto abierto

```bash
lsof -p 12345                       # todo del PID
lsof /var/log/miapp.log             # quién tiene ese archivo abierto
lsof -i :5432                       # quién escucha en 5432
lsof -i TCP:80 -sTCP:LISTEN         # listeners de HTTP
lsof -u app                         # todo del usuario app
lsof +D /var/lib/miapp              # todo el árbol
lsof -nP -i                          # todas las conexiones, sin resolver nombres
```

Muy útil para debugging de "no puedo borrar este archivo" (todavía abierto), "por qué no arranca mi server" (puerto ocupado por otro proceso).

### 5.3 `ss` (moderno) vs `netstat` (legacy)

`netstat` está deprecado. Usa `ss`:

```bash
ss -tulnp                           # TCP + UDP, listening, con PID
ss -tanp state established           # TCP established con PID
ss -s                                # summary por familia y estado
ss -tn 'sport = :443'                # todas las conexiones desde el 443
ss -to state established             # con timers (keepalive)
```

Combinado con `watch`:

```bash
watch -n 1 'ss -s ; echo ; ss -tan state established | wc -l'
```

### 5.4 `fuser` — quién está usando ese archivo/dispositivo

```bash
fuser /var/log/miapp.log
fuser -m /mnt/data                   # quién tiene abierto ALGO en ese mount
fuser -k -TERM /var/log/miapp.log    # matar procesos con SIGTERM
```

Cuando `umount /mnt/data` falla con "device busy", `fuser -m /mnt/data -v` te dice quién lo tiene abierto.

### 5.5 `perf` y flame graphs

```bash
# Perfil de CPU 30 s de un proceso
sudo perf record -F 99 -p 12345 -g -- sleep 30
sudo perf report

# Flame graph (necesita FlameGraph tools clonado)
sudo perf script | ~/FlameGraph/stackcollapse-perf.pl | ~/FlameGraph/flamegraph.pl > out.svg
```

Alternativas modernas: `py-spy` (Python), `rbspy` (Ruby), `pyroscope`/`parca` (continuous profiling multi-lenguaje), `bpftrace` (eBPF sin recompile del kernel).

### 5.6 `tmux` / `screen` para sesiones remotas

```bash
tmux new -s work                     # nueva sesión llamada 'work'
# Ctrl-b d  → detach (la sesión sigue viva)
tmux ls                              # listar
tmux attach -t work                  # reatachar
tmux kill-session -t work

# Panes útiles: Ctrl-b " (horizontal), Ctrl-b % (vertical), Ctrl-b flechas (mover)
```

En 2026, para sesiones largas con historial de scroll navegable y multiplexado, `tmux` sigue siendo el estándar; `zellij` (Rust, más nuevo, UI moderna) es alternativa.

---

## 6. Ejemplo completo: script de rotación + análisis de logs

Ponemos todo junto: un script real que analiza los logs de nginx del último día en el servidor de `linguadev.app`, genera un resumen y lo publica en Slack.

```bash
#!/usr/bin/env bash
#
# analyze-nginx.sh — resumen diario de logs nginx
# ejecutar como timer systemd todos los días 07:00

set -Eeuo pipefail
IFS=$'\n\t'

readonly LOG_DIR="${LOG_DIR:-/var/log/nginx}"
readonly OUT_DIR="/var/lib/nginx-reports"
readonly SLACK_URL="${SLACK_WEBHOOK_URL:?SLACK_WEBHOOK_URL requerido}"
readonly YESTERDAY="$(date -d 'yesterday' +%d/%b/%Y)"
readonly REPORT="${OUT_DIR}/report-$(date -d 'yesterday' +%F).md"

log() { printf '[%s] %s\n' "$(date -Is)" "$*" >&2; }

on_err() {
  local code=$?
  log "ERROR en línea $BASH_LINENO: ${BASH_COMMAND} (exit=$code)"
  curl -sS -X POST -H 'Content-Type: application/json' \
       --data "{\"text\":\":x: analyze-nginx.sh falló: código $code\"}" \
       "$SLACK_URL" || true
  exit "$code"
}
trap on_err ERR

mkdir -p "$OUT_DIR"

# 1. Une access logs comprimidos y planos del día de ayer
ACCESS_LINES="$(zgrep -h "\\[${YESTERDAY}:" "${LOG_DIR}"/access.log* 2>/dev/null || true)"

if [[ -z "$ACCESS_LINES" ]]; then
  log "No hay logs para ${YESTERDAY}. Saliendo."
  exit 0
fi

TOTAL=$(printf '%s\n' "$ACCESS_LINES" | wc -l)
ERR5XX=$(printf '%s\n' "$ACCESS_LINES" | awk '$9 ~ /^5/' | wc -l)
ERR4XX=$(printf '%s\n' "$ACCESS_LINES" | awk '$9 ~ /^4/' | wc -l)

TOP_IPS=$(printf '%s\n' "$ACCESS_LINES" \
  | awk '{print $1}' | sort | uniq -c | sort -rn | head -5 \
  | awk '{printf "  - %s hits: `%s`\n", $1, $2}')

TOP_PATHS_5XX=$(printf '%s\n' "$ACCESS_LINES" \
  | awk '$9 ~ /^5/ {print $7}' | sort | uniq -c | sort -rn | head -5 \
  | awk '{printf "  - %s x `%s`\n", $1, $2}')

SLOW=$(printf '%s\n' "$ACCESS_LINES" \
  | awk '{ if ($NF+0 > 1.0) print $NF, $7 }' | sort -rn | head -5 \
  | awk '{printf "  - %ss `%s`\n", $1, $2}')

# 2. Escribe reporte Markdown
cat > "$REPORT" <<MD
# Nginx report ${YESTERDAY}

- Requests totales: **${TOTAL}**
- 4xx: **${ERR4XX}**
- 5xx: **${ERR5XX}**

## Top 5 IPs
${TOP_IPS}

## Top paths con 5xx
${TOP_PATHS_5XX:-  (ninguno)}

## Top requests lentas (>1s)
${SLOW:-  (ninguno)}
MD

log "Reporte escrito en ${REPORT}"

# 3. Publica resumen a Slack
BODY=$(jq -Rs '{text: .}' < "$REPORT")
curl -sS -X POST -H 'Content-Type: application/json' --data "$BODY" "$SLACK_URL" > /dev/null

log "Publicado en Slack"
```

Unit + timer:

```ini
# /etc/systemd/system/nginx-report.service
[Unit]
Description=Reporte diario de nginx
After=network-online.target

[Service]
Type=oneshot
User=nginx-reporter
EnvironmentFile=/etc/nginx-report/env
ExecStart=/opt/scripts/analyze-nginx.sh
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nginx-report
```

```ini
# /etc/systemd/system/nginx-report.timer
[Unit]
Description=Corre reporte nginx todos los días 07:00

[Timer]
OnCalendar=*-*-* 07:00:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now nginx-report.timer
systemctl list-timers nginx-report.timer
sudo journalctl -u nginx-report.service --since '2 days ago'
```

---

## 7. Cheatsheet y anti-patrones

### Reglas de oro

- ✅ **`set -Eeuo pipefail` + `IFS=$'\n\t'`** al inicio de cada script bash.
- ✅ **Comillas dobles** en toda expansión de variable o `$(cmd)`.
- ✅ **`trap` para cleanup** en `EXIT` (`INT`, `TERM`) — deja recursos siempre limpios.
- ✅ **`mktemp -d`** para directorios temporales; nunca `/tmp/foo.$$`.
- ✅ **Paths absolutos** para binarios en cron y en scripts que corran de contextos no interactivos.
- ✅ **`-print0` / `-0`** con `find`/`xargs` para nombres con espacios.
- ✅ **`ss`, no `netstat`** en 2026.
- ✅ **`rg`/`fd`/`bat`/`jq`** en tu toolbox — mucho más rápidos que sus predecesores.
- ✅ **`journalctl -u <svc>`** para logs de servicios systemd; **`--since` + `-p err`** para filtrar.
- ✅ **`systemd-analyze security <svc>`** para evaluar hardening de tus units.
- ✅ **Timers > cron** cuando estés en systemd. `Persistent=true` recupera runs perdidos.
- ✅ **`SIGTERM` primero, `SIGKILL` último** — deja el grace period.
- ✅ **`umask 022`** por default; **`umask 077`** cuando manejas secrets.
- ✅ **`getcap`/`setcap`** en lugar de setuid para permisos granulares.
- ✅ **`sudo -E` o `sudo -H`** conscientemente cuando importa el entorno.

### Anti-patrones

- ❌ `for f in $(ls *.log); do …; done` — usa `for f in *.log`.
- ❌ `cat file | grep pattern` — usa `grep pattern file` (useless use of cat).
- ❌ `curl … | bash` sin auditar el script.
- ❌ `chmod 777` (por lo que sea).
- ❌ `kill -9` como primer intento — nunca deja al proceso limpiar.
- ❌ `rm -rf /var/log/*` "para liberar espacio" — muchos procesos escriben en fds abiertos y no liberas hasta reiniciarlos.
- ❌ `>` con `sudo` (`sudo echo x > /etc/foo` NO funciona — redirect corre como tu usuario). Usa `sudo tee`.
- ❌ Cron sin `flock` en tareas que pueden solaparse.
- ❌ `sleep 30 && restart-service` — usa `systemctl restart` con `Restart=on-failure`.
- ❌ `PATH=/opt/miapp/bin` sin `$PATH` al final — rompe binarios del sistema.
- ❌ Ejecutar scripts descargados con `wget | sh` sin `-fsSL` y sin `set -e`.
- ❌ Poner secrets en `~/.bash_history` (ejecuta con espacio inicial si `HISTCONTROL=ignorespace` — hábito básico).
- ❌ `find / -exec` sin filtros de path — durará horas y matará I/O.
- ❌ `strace` en producción sin filtros — cientos de MB de log en segundos y latencia extra para el proceso.

### Tabla de decisión: qué herramienta

| Necesito… | Uso |
|---|---|
| Ver logs de un service | `journalctl -u foo -f` |
| Ver qué escucha un puerto | `ss -tulnp` o `lsof -i :N` |
| Ver quién tiene un archivo abierto | `lsof /path` o `fuser /path` |
| Ver syscalls de un proceso | `strace -p PID -f -e trace=…` |
| Buscar en muchos archivos | `rg pattern` |
| Buscar archivos por nombre | `fd name` o `find . -name` |
| Editar JSON | `jq` |
| Editar YAML | `yq` |
| Ver tamaños interactivos | `ncdu /dir` |
| Reemplazar en muchos archivos | `sed -i 's/a/b/g' **/*.md` |
| Contar líneas por categoría | `awk … | sort | uniq -c | sort -rn` |
| Programar tarea periódica | `systemd timer` (o cron si estás fuera) |
| Persistir sesión SSH | `tmux new -s work` |

---

## 8. Casos reales 2020-2026

**Log4Shell (dic 2021):** una vulnerabilidad de deserialización JNDI en `log4j` pedía `curl` interno malicioso. Detectada masivamente con `strace -e connect` (mostraba conexiones inesperadas) y con `find`/`grep` recursivo por JARs vulnerables. Empujó SBOM y scanning como práctica universal (ver cap 13).

**Systemd 256 (jun 2024):** entre otras, `journalctl` ganó `--list-namespaces`, `-i` como shortcut de `--file=`, y `-T` para excluir syslog identifiers. `journald` puede reenviar vía socket `AF_INET`/`AF_VSOCK`.

**Systemd 257 (dic 2024):** `journalctl --list-invocations` y `-I` para inspeccionar una ejecución concreta de un servicio (útil para post-mortems). cgroup v1 marcado obsoleto — systemd ignora por default configs que lo habiliten. Presión definitiva para migrar a v2 en 2026.

**xz-utils backdoor (mar 2024, CVE-2024-3094):** Jia Tan mantenedor sospechoso introdujo backdoor en `liblzma` durante ~2 años; detectado por Andres Freund al observar 500 ms extra en handshakes SSH con `strace` + benchmarking cuidadoso. Ejemplo perfecto del valor de dominar herramientas base.

**Ubuntu 24.04 LTS (abr 2024):** llegó con systemd 255+, `netplan` unificado, y por default `unattended-upgrades`. En 2026 Ubuntu 24.04.3 mantiene soporte hasta 2029.

**Debian 12 "Bookworm" (jun 2023) → 13 "Trixie" (2025):** transición a systemd 257 y kernel 6.x. Firmware no-libre habilitado por default desde 12.

**Fedora 40+ (2024-2026):** Podman por default, cgroup v2 obligatorio, ZRAM swap default. Fedora Silverblue con OSTree como base inmutable ganó tracción.

**BusyBox y Alpine musl bugs (recurrentes):** DNS resolver de musl con quirks (comportamiento distinto en `search` domain, sensibilidad a UDP truncation) han causado incidents en Kubernetes con Alpine + CoreDNS. La solución típica: `--dns-search` explícito, o migrar a slim.

**Wayland vs X11 en servidores** (irrelevante) — pero relevante: en 2026 la mayoría de servers ni X ni Wayland, solo `sway` u otros WMs si necesitas GUI local, algo rarísimo.

**eBPF y bpftrace (2020-2026):** herramientas basadas en eBPF (BCC, bpftrace, `parca`, Cilium) reemplazan gradualmente `strace`/`perf` en workloads productivos por su bajo overhead. Sigue siendo útil aprender `strace` primero.

---

## 9. Ejercicios prácticos

### Ejercicio 1 — Instrumenta un script con `set -Eeuo pipefail` y `trap`

**Objetivo:** convertir un script "sucio" en uno robusto con estricto manejo de errores y cleanup.

**Setup:** un script bash que descargue un archivo, lo procese en un tmp dir, y suba el resultado.

**Pasos:**
1. Parte de un script que hace `curl … > /tmp/x && process /tmp/x && upload result`.
2. Añade `#!/usr/bin/env bash` y `set -Eeuo pipefail; IFS=$'\n\t'`.
3. Crea tmp dir con `mktemp -d` y `trap 'rm -rf "$TMP"' EXIT`.
4. Envuelve las llamadas peligrosas y verifica exit codes.
5. Añade `on_err` handler que loguee `$BASH_LINENO` y `$BASH_COMMAND`.
6. Prueba matando el script con Ctrl+C a mitad y verifica que el tmp dir se limpia.

**Criterios de éxito:**
- [ ] Con `set -u`, una typo en variable rompe el script (no continúa silenciosamente).
- [ ] Ctrl+C limpia el tmp dir (no queda basura en `/tmp`).
- [ ] Error en un comando aborta el pipeline (no continúa).
- [ ] Logs incluyen timestamp y contexto.

**Bonus:** añade retry con backoff exponencial (`until curl … ; do sleep $((RANDOM % 10 + 1)); done`).

---

### Ejercicio 2 — Diagnostica un leak de file descriptors

**Objetivo:** encontrar qué está manteniendo abiertos miles de fds.

**Setup:** una app Node/Python "leaky" que abre archivos y no los cierra en un loop.

**Pasos:**
1. Escribe la app leaky (`for i in range: open('/tmp/x')` sin close).
2. Arrancala. Espera 1 min.
3. Averigua su PID con `pgrep -a leaky`.
4. Cuenta fds abiertos: `ls /proc/<PID>/fd | wc -l`.
5. Categoriza con `lsof -p <PID> | awk '{print $5}' | sort | uniq -c | sort -rn`.
6. Sube ulimit con `prlimit --pid <PID> --nofile=1024:2048`.
7. Fixea el código (`with open(...) as f:` en Python, `handle.close()` en Node).

**Criterios de éxito:**
- [ ] Identificas que la mayoría de fds son de tipo `REG` (archivos regulares) apuntando al mismo path.
- [ ] `lsof -p <PID>` te da lista concreta.
- [ ] Tras el fix, fds abiertos se estabilizan.
- [ ] Documentas el patrón para tu equipo.

**Bonus:** añade una métrica Prometheus custom (`process_open_fds`) al servicio y alerta si > 80% de ulimit.

---

### Ejercicio 3 — Convierte un cron a systemd timer

**Objetivo:** migrar un job de cron a systemd timer con logging unificado y `Persistent=true`.

**Setup:** un cronjob que corre `/opt/miapp/backup.sh` diariamente.

**Pasos:**
1. Crea `/etc/systemd/system/backup.service` con `Type=oneshot`, `User=app`, `ExecStart=/opt/miapp/backup.sh`.
2. Crea `/etc/systemd/system/backup.timer` con `OnCalendar=*-*-* 02:15:00`, `Persistent=true`, `RandomizedDelaySec=300`.
3. `systemctl daemon-reload && systemctl enable --now backup.timer`.
4. Verifica con `systemctl list-timers backup.timer`.
5. Fuerza una ejecución: `systemctl start backup.service`.
6. Ve logs: `journalctl -u backup.service -f`.
7. Apaga el host durante la hora del timer y comprueba que al arrancar ejecuta la corrida perdida.

**Criterios de éxito:**
- [ ] `list-timers` muestra `LAST` y `NEXT` correctos.
- [ ] Logs aparecen en `journalctl -u backup.service`.
- [ ] Con `Persistent=true`, ejecutar al arrancar tras ventana perdida.
- [ ] Cron original desactivado (`crontab -e` limpio).

**Bonus:** añade `OnFailure=alert.service` que dispare notificación cuando falle.

---

### Ejercicio 4 — Análisis de logs con `awk` + pipeline

**Objetivo:** producir un top 10 de endpoints con más 5xx del día usando solo herramientas Unix.

**Setup:** un `access.log` de nginx en formato combined.

**Pasos:**
1. Filtra líneas del día de hoy con `awk`.
2. Filtra líneas con status 5xx: `awk '$9 ~ /^5/'`.
3. Extrae la columna del path (col 7).
4. Agrupa: `sort | uniq -c | sort -rn | head -10`.
5. Formatea salida con `awk '{printf "%5d  %s\n", $1, $2}'`.
6. Guárdalo en un script `top-5xx.sh` que acepte fecha como argumento.

**Criterios de éxito:**
- [ ] El script imprime tabla ordenada de más frecuentes.
- [ ] Acepta `--date YYYY-MM-DD` como parámetro.
- [ ] Maneja logs comprimidos con `zcat` o `zgrep -h`.
- [ ] Cabecera con totales (requests, 2xx, 4xx, 5xx).

**Bonus:** añade heatmap horario (bucket por hora, `sort` numérico) e imprime histograma con `#` proporcional al conteo.

---

### Ejercicio 5 — Debug de red con `strace` + `ss` + `lsof`

**Objetivo:** diagnosticar por qué una app no puede conectar al DB.

**Setup:** app configurada con hostname erróneo, o firewall bloqueando puerto.

**Pasos:**
1. Arranca la app y observa el error (`ECONNREFUSED`, `timeout`).
2. `ss -tulnp | grep 5432` — ¿está escuchando el DB local?
3. `ss -tan state syn-sent` — ¿la app está intentando conectar y quedándose en SYN_SENT?
4. `sudo strace -p <PID> -f -e trace=connect,recvfrom,sendto -T -tt` — ¿qué IP:puerto intenta?
5. `getent hosts <hostname>` — ¿resuelve correctamente?
6. `curl -v telnet://host:5432` o `nc -zv host 5432` — ¿hay ruta y puerto abierto?
7. Identifica y corrige (hostname wrong, security group, DNS split-horizon, etc.).

**Criterios de éxito:**
- [ ] Identificas la causa raíz con evidencia (comando + salida).
- [ ] Documentas la línea de razonamiento en 5-6 pasos.
- [ ] Añades un healthcheck a la app que verifique connectividad al DB al arrancar.
- [ ] Sabes cuándo es DNS, cuándo firewall, cuándo el server no está listening.

**Bonus:** captura tráfico con `sudo tcpdump -i any -n 'port 5432' -w capture.pcap` y ábrelo en Wireshark.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales. Cubren: procesos y threads en Linux (`clone`, `fork`), signals (`SIGTERM` vs `SIGKILL`), file descriptors y `ulimit`, permisos octales y bits especiales, `chown`/`chgrp` y ownership, pipes y redirecciones (`>`, `2>&1`, process substitution), `grep`/`rg` con regex, `awk` para extracción, `sed` para sustitución in-place, `systemd` units y hardening, cron vs timers, `cgroups` y `MemoryMax`/`OOM`, `ps`/`top`/`htop`, `strace`/`lsof` para debugging profundo, `find` avanzado con `-print0`, `ss` moderno vs `netstat`, `du`/`df` y disk usage, SSH `ProxyJump`, `xargs` con `-0` y paralelismo `-P`, y shell scripting con `set -euo pipefail`.

- **Fuente:** [`packages/content/src/tech/programmer/sim-14-linux-and-shell.json`](../../packages/content/src/tech/programmer/sim-14-linux-and-shell.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-14-linux-and-shell`
- **Tiempo:** 25 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 13 — Docker y contenedores](./13-docker-y-contenedores.md) · [Índice](./README.md) · [Capítulo 15 — Observabilidad para devs →](./15-observabilidad-para-devs.md)
